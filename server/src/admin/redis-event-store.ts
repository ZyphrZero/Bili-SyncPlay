import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import type {
  GlobalEventStore,
  GlobalEventStoreAppendInput,
  GlobalEventStoreQuery,
  GlobalEventStoreQueryResult,
} from "./global-event-store.js";
import type { RuntimeEvent } from "./types.js";

const DEFAULT_EVENT_STREAM_KEY = "bsp:events";
const DEFAULT_EVENT_COUNTS_KEY = "bsp:event_counts";
const DEFAULT_EVENT_MINUTE_COUNTS_KEY = "bsp:event_minute_counts";
const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const MINUTE_MS = 60_000;
const MINUTE_BUCKET_RETENTION = 24 * 60;

function normalizeNullable(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function encodeNullable(value: string | null | undefined): string {
  return value ?? "";
}

function parseEvent(
  id: string,
  fields: Record<string, string>,
): RuntimeEvent | null {
  const event = fields.event;
  const timestamp = fields.timestamp;
  const details = fields.details;
  if (!event || !timestamp || !details) {
    return null;
  }

  return {
    id,
    timestamp,
    event,
    roomCode: normalizeNullable(fields.roomCode),
    sessionId: normalizeNullable(fields.sessionId),
    remoteAddress: normalizeNullable(fields.remoteAddress),
    origin: normalizeNullable(fields.origin),
    result: normalizeNullable(fields.result),
    details: JSON.parse(details) as Record<string, unknown>,
  };
}

function eventTime(event: RuntimeEvent): number {
  return Date.parse(event.timestamp);
}

function matchesQuery(
  event: RuntimeEvent,
  query: GlobalEventStoreQuery,
): boolean {
  const timestamp = eventTime(event);
  if (!shouldIncludeRuntimeEvent(event.event, query.includeSystem === true)) {
    return false;
  }
  if (query.event && event.event !== query.event) {
    return false;
  }
  if (query.roomCode && event.roomCode !== query.roomCode) {
    return false;
  }
  if (query.sessionId && event.sessionId !== query.sessionId) {
    return false;
  }
  if (query.remoteAddress && event.remoteAddress !== query.remoteAddress) {
    return false;
  }
  if (query.origin && event.origin !== query.origin) {
    return false;
  }
  if (query.result && event.result !== query.result) {
    return false;
  }
  if (query.from !== undefined && timestamp < query.from) {
    return false;
  }
  if (query.to !== undefined && timestamp > query.to) {
    return false;
  }
  return true;
}

export async function createRedisEventStore(
  redisUrl: string,
  options: {
    streamKey?: string;
    countsKey?: string;
    minuteCountsKey?: string;
    maxLen?: number;
  } = {},
): Promise<GlobalEventStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const streamKey = options.streamKey ?? DEFAULT_EVENT_STREAM_KEY;
  const countsKey = options.countsKey ?? DEFAULT_EVENT_COUNTS_KEY;
  const minuteCountsKey =
    options.minuteCountsKey ?? DEFAULT_EVENT_MINUTE_COUNTS_KEY;
  const maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
  let closing = false;
  let pendingAppend = Promise.resolve();
  let lastPrunedMinute: number | null = null;

  await redis.connect();

  // Backfill cumulative counts from existing stream entries if the hash
  // does not exist yet (first startup after upgrade).
  const hashExists = await redis.exists(countsKey);
  if (!hashExists) {
    const allEntries = await redis.xrange(streamKey, "-", "+");
    if (allEntries.length > 0) {
      const counts = new Map<string, number>();
      for (const [, fieldValues] of allEntries) {
        for (let i = 0; i < fieldValues.length; i += 2) {
          if (fieldValues[i] === "event" && fieldValues[i + 1]) {
            const name = fieldValues[i + 1];
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
        }
      }
      if (counts.size > 0) {
        const args: string[] = [];
        for (const [name, count] of counts) {
          args.push(name, String(count));
        }
        await redis.hset(countsKey, ...args);
      }
    }
  }

  // Backfill minute buckets from existing stream entries if the hash does
  // not exist yet. Stream only retains up to maxLen recent entries, but
  // seeding gives the windowed counters something to start from instead of
  // showing zero until new traffic arrives.
  const minuteHashExists = await redis.exists(minuteCountsKey);
  if (!minuteHashExists) {
    const allEntries = await redis.xrange(streamKey, "-", "+");
    if (allEntries.length > 0) {
      const buckets = new Map<string, number>();
      for (const [, fieldValues] of allEntries) {
        let eventName: string | undefined;
        let timestamp: string | undefined;
        for (let i = 0; i < fieldValues.length; i += 2) {
          const key = fieldValues[i];
          const value = fieldValues[i + 1];
          if (key === "event") {
            eventName = value;
          } else if (key === "timestamp") {
            timestamp = value;
          }
        }
        if (!eventName || !timestamp) continue;
        const ts = Date.parse(timestamp);
        if (!Number.isFinite(ts)) continue;
        const minute = Math.floor(ts / MINUTE_MS);
        const field = `${eventName}:${minute}`;
        buckets.set(field, (buckets.get(field) ?? 0) + 1);
      }
      if (buckets.size > 0) {
        const args: string[] = [];
        for (const [field, count] of buckets) {
          args.push(field, String(count));
        }
        await redis.hset(minuteCountsKey, ...args);
      }
    }
  }

  async function pruneMinuteBucketsIfNeeded(currentMinute: number) {
    if (lastPrunedMinute === currentMinute) {
      return;
    }
    lastPrunedMinute = currentMinute;
    const oldestKept = currentMinute - MINUTE_BUCKET_RETENTION + 1;
    const fields = await redis.hkeys(minuteCountsKey);
    const stale: string[] = [];
    for (const field of fields) {
      const colon = field.lastIndexOf(":");
      if (colon < 0) continue;
      const minute = Number(field.slice(colon + 1));
      if (Number.isFinite(minute) && minute < oldestKept) {
        stale.push(field);
      }
    }
    if (stale.length > 0) {
      await redis.hdel(minuteCountsKey, ...stale);
    }
  }

  async function queryEvents(
    query: GlobalEventStoreQuery,
  ): Promise<GlobalEventStoreQueryResult> {
    await pendingAppend;
    const rawEntries = await redis.xrevrange(streamKey, "+", "-");
    const parsedEvents = rawEntries
      .map(([id, fieldValues]) => {
        const fields: Record<string, string> = {};
        for (let index = 0; index < fieldValues.length; index += 2) {
          const key = fieldValues[index];
          const value = fieldValues[index + 1];
          if (key !== undefined && value !== undefined) {
            fields[key] = value;
          }
        }
        return parseEvent(id, fields);
      })
      .filter((event): event is RuntimeEvent => event !== null)
      .filter((event) => matchesQuery(event, query));

    const start = (query.page - 1) * query.pageSize;
    return {
      items: parsedEvents.slice(start, start + query.pageSize),
      total: parsedEvents.length,
    };
  }

  return {
    append(input: GlobalEventStoreAppendInput) {
      const timestamp = input.timestamp ?? new Date().toISOString();
      const details = JSON.stringify(input.data);
      const runtimeEvent: RuntimeEvent = {
        id: randomUUID(),
        timestamp,
        event: input.event,
        roomCode:
          typeof input.data.roomCode === "string" ? input.data.roomCode : null,
        sessionId:
          typeof input.data.sessionId === "string"
            ? input.data.sessionId
            : null,
        remoteAddress:
          typeof input.data.remoteAddress === "string"
            ? input.data.remoteAddress
            : null,
        origin:
          typeof input.data.origin === "string" ? input.data.origin : null,
        result:
          typeof input.data.result === "string" ? input.data.result : null,
        details: { ...input.data },
      };

      if (closing) {
        return Promise.resolve(runtimeEvent);
      }

      const appendPromise = pendingAppend.then(async () => {
        const streamId = await redis.xadd(
          streamKey,
          "*",
          "event",
          input.event,
          "timestamp",
          timestamp,
          "roomCode",
          encodeNullable(
            typeof input.data.roomCode === "string"
              ? input.data.roomCode
              : null,
          ),
          "sessionId",
          encodeNullable(
            typeof input.data.sessionId === "string"
              ? input.data.sessionId
              : null,
          ),
          "remoteAddress",
          encodeNullable(
            typeof input.data.remoteAddress === "string"
              ? input.data.remoteAddress
              : null,
          ),
          "origin",
          encodeNullable(
            typeof input.data.origin === "string" ? input.data.origin : null,
          ),
          "result",
          encodeNullable(
            typeof input.data.result === "string" ? input.data.result : null,
          ),
          "details",
          details,
        );
        if (!streamId) {
          throw new Error(
            "Redis did not return a stream id for appended event.",
          );
        }
        const minute = Math.floor(Date.parse(timestamp) / MINUTE_MS);
        const minuteField = `${input.event}:${minute}`;
        await Promise.all([
          redis.xtrim(streamKey, "MAXLEN", "=", maxLen),
          redis.hincrby(countsKey, input.event, 1),
          redis.hincrby(minuteCountsKey, minuteField, 1),
        ]);
        await pruneMinuteBucketsIfNeeded(minute);

        return {
          ...runtimeEvent,
          id: streamId,
        } satisfies RuntimeEvent;
      });

      pendingAppend = appendPromise.then(
        () => undefined,
        () => undefined,
      );

      return appendPromise;
    },
    async query(query) {
      return await queryEvents(query);
    },
    async totalCountsByEvent(eventNames: readonly string[]) {
      if (eventNames.length === 0) {
        return {};
      }
      await pendingAppend;
      const values = await redis.hmget(countsKey, ...eventNames);
      return Object.fromEntries(
        eventNames.map((name, i) => [
          name,
          values[i] ? parseInt(values[i], 10) : 0,
        ]),
      );
    },
    async countsByEventInWindow(
      eventNames: readonly string[],
      fromMs: number,
      toMs: number,
    ) {
      if (eventNames.length === 0) {
        return {};
      }
      await pendingAppend;
      const fromMinute = Math.floor(fromMs / MINUTE_MS);
      const toMinute = Math.floor(toMs / MINUTE_MS);
      const wanted = new Set(eventNames);
      const totals = Object.fromEntries(
        eventNames.map((name) => [name, 0]),
      ) as Record<string, number>;
      const fields = await redis.hgetall(minuteCountsKey);
      for (const [field, raw] of Object.entries(fields)) {
        const colon = field.lastIndexOf(":");
        if (colon < 0) continue;
        const name = field.slice(0, colon);
        if (!wanted.has(name)) continue;
        const minute = Number(field.slice(colon + 1));
        if (!Number.isFinite(minute)) continue;
        if (minute < fromMinute || minute > toMinute) continue;
        const value = Number.parseInt(raw, 10);
        if (Number.isFinite(value)) {
          totals[name] += value;
        }
      }
      return totals;
    },
    async close() {
      closing = true;
      await pendingAppend;
      await redis.quit();
    },
  };
}
