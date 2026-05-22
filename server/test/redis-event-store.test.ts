import assert from "node:assert/strict";
import test from "node:test";
import { createRedisEventStore } from "../src/admin/redis-event-store.js";

const REDIS_URL = process.env.REDIS_URL;

function createStreamKey(): string {
  return `bsp:test:events:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function createKeyTriplet(): {
  streamKey: string;
  countsKey: string;
  minuteCountsKey: string;
} {
  const suffix = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  return {
    streamKey: `bsp:test:events:${suffix}`,
    countsKey: `bsp:test:event_counts:${suffix}`,
    minuteCountsKey: `bsp:test:event_minute_counts:${suffix}`,
  };
}

test("redis event store appends, trims, and queries events across store instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const streamKey = createStreamKey();
  const storeA = await createRedisEventStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });
  const storeB = await createRedisEventStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });

  try {
    await storeA.append({
      event: "room_created",
      timestamp: "2026-03-26T11:00:00.000Z",
      data: {
        roomCode: "ROOM01",
        sessionId: "session-1",
        remoteAddress: "127.0.0.1",
        origin: "chrome-extension://allowed-extension",
        result: "ok",
      },
    });
    const joined = await storeB.append({
      event: "room_joined",
      timestamp: "2026-03-26T11:00:01.000Z",
      data: {
        roomCode: "ROOM01",
        sessionId: "session-2",
        result: "ok",
      },
    });
    await storeA.append({
      event: "room_closed",
      timestamp: "2026-03-26T11:00:02.000Z",
      data: {
        roomCode: "ROOM02",
        sessionId: "session-3",
        result: "ok",
      },
    });

    const room01 = await storeA.query({
      roomCode: "ROOM01",
      page: 1,
      pageSize: 10,
    });
    assert.equal(room01.total, 1);
    assert.equal(room01.items[0]?.id, joined.id);

    const joinedOnly = await storeB.query({
      event: "room_joined",
      page: 1,
      pageSize: 10,
    });
    assert.equal(joinedOnly.total, 1);
    assert.equal(joinedOnly.items[0]?.sessionId, "session-2");

    const trimmed = await storeA.query({
      page: 1,
      pageSize: 10,
    });
    assert.equal(trimmed.total, 2);
    assert.equal(
      trimmed.items.some((item) => item.event === "room_created"),
      false,
    );
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

test("countsByEventInWindow returns accurate windowed counts even after the stream trims", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keys = createKeyTriplet();
  const store = await createRedisEventStore(REDIS_URL, {
    ...keys,
    maxLen: 2,
  });

  try {
    await store.append({
      event: "rate_limited",
      timestamp: "2026-03-26T13:00:30.000Z",
      data: { result: "blocked" },
    });
    await store.append({
      event: "rate_limited",
      timestamp: "2026-03-26T13:00:45.000Z",
      data: { result: "blocked" },
    });
    // These appends evict the earlier stream entries thanks to maxLen=2,
    // but the per-minute counter must still remember both rate_limited
    // events from 13:00.
    await store.append({
      event: "room_joined",
      timestamp: "2026-03-26T13:05:00.000Z",
      data: { roomCode: "ROOM01", result: "ok" },
    });
    await store.append({
      event: "rate_limited",
      timestamp: "2026-03-26T13:07:00.000Z",
      data: { result: "blocked" },
    });

    const now = Date.parse("2026-03-26T13:07:30.000Z");

    const lastMinute = await store.countsByEventInWindow(
      ["rate_limited", "room_joined"],
      now - 60_000,
      now,
    );
    assert.equal(lastMinute.rate_limited, 1);
    assert.equal(lastMinute.room_joined, 0);

    const lastTenMinutes = await store.countsByEventInWindow(
      ["rate_limited", "room_joined"],
      now - 10 * 60_000,
      now,
    );
    assert.equal(lastTenMinutes.rate_limited, 3);
    assert.equal(lastTenMinutes.room_joined, 1);

    const streamSurvivors = await store.query({
      page: 1,
      pageSize: 10,
    });
    assert.ok(streamSurvivors.total <= 2);
  } finally {
    await store.close();
  }
});

test("countsByEventInWindow drops minute buckets older than the retention window", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keys = createKeyTriplet();
  const store = await createRedisEventStore(REDIS_URL, {
    ...keys,
    maxLen: 100,
  });

  try {
    await store.append({
      event: "rate_limited",
      timestamp: "2026-03-26T10:00:00.000Z",
      data: { result: "blocked" },
    });
    // 24h+ later should trigger pruning of the 10:00 bucket from the
    // previous day.
    await store.append({
      event: "rate_limited",
      timestamp: "2026-03-27T10:01:00.000Z",
      data: { result: "blocked" },
    });

    const now = Date.parse("2026-03-27T10:01:30.000Z");
    const lastDay = await store.countsByEventInWindow(
      ["rate_limited"],
      now - 24 * 60 * 60_000,
      now,
    );
    assert.equal(lastDay.rate_limited, 1);
  } finally {
    await store.close();
  }
});

test("redis event store hides system events by default and can include them on demand", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const streamKey = createStreamKey();
  const store = await createRedisEventStore(REDIS_URL, {
    streamKey,
    maxLen: 10,
  });

  try {
    await store.append({
      event: "room_created",
      timestamp: "2026-03-26T12:30:00.000Z",
      data: { roomCode: "ROOM01", result: "ok" },
    });
    await store.append({
      event: "runtime_index_reaper_failed",
      timestamp: "2026-03-26T12:30:01.000Z",
      data: { result: "error" },
    });

    const defaultView = await store.query({
      page: 1,
      pageSize: 10,
    });
    assert.equal(defaultView.total, 1);
    assert.equal(defaultView.items[0]?.event, "room_created");

    const fullView = await store.query({
      includeSystem: true,
      page: 1,
      pageSize: 10,
    });
    assert.equal(fullView.total, 2);
  } finally {
    await store.close();
  }
});
