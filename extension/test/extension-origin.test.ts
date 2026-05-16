import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getExtensionOrigin } from "../src/shared/extension-origin";

const originalChrome = globalThis.chrome;

function installChromeRuntime(rootUrl: string): void {
  globalThis.chrome = {
    runtime: {
      // 真实运行时中 chrome.runtime.getURL("/") 恒返回 "<scheme>://<host>/"
      getURL(path: string): string {
        return `${rootUrl}${path.replace(/^\//, "")}`;
      },
    },
  } as unknown as typeof chrome;
}

afterEach(() => {
  globalThis.chrome = originalChrome;
});

test("getExtensionOrigin 解析 Chrome/Edge 扩展 origin", () => {
  installChromeRuntime("chrome-extension://abcdefghijklmnop/");
  assert.equal(getExtensionOrigin(), "chrome-extension://abcdefghijklmnop");
});

test("getExtensionOrigin 解析 Firefox moz-extension origin", () => {
  installChromeRuntime("moz-extension://12345678-90ab-cdef-1234-567890abcdef/");
  assert.equal(
    getExtensionOrigin(),
    "moz-extension://12345678-90ab-cdef-1234-567890abcdef",
  );
});

test("getExtensionOrigin 结果不含结尾斜杠", () => {
  installChromeRuntime("moz-extension://uuid-value/");
  assert.ok(!getExtensionOrigin().endsWith("/"));
});
