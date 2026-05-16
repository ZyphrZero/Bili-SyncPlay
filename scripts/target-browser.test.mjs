import assert from "node:assert/strict";
import test from "node:test";
import { distDirName, resolveTargetBrowser } from "./target-browser.mjs";

test("默认目标为 chrome", () => {
  assert.equal(resolveTargetBrowser([], {}), "chrome");
});

test("环境变量 TARGET_BROWSER 生效", () => {
  assert.equal(
    resolveTargetBrowser([], { TARGET_BROWSER: "firefox" }),
    "firefox",
  );
});

test("CLI --target=value 形式", () => {
  assert.equal(resolveTargetBrowser(["--target=firefox"], {}), "firefox");
});

test("CLI --target value 形式", () => {
  assert.equal(resolveTargetBrowser(["--target", "firefox"], {}), "firefox");
});

test("CLI 参数优先于环境变量", () => {
  assert.equal(
    resolveTargetBrowser(["--target=chrome"], { TARGET_BROWSER: "firefox" }),
    "chrome",
  );
});

test("大小写与空白被归一", () => {
  assert.equal(
    resolveTargetBrowser([], { TARGET_BROWSER: " FireFox " }),
    "firefox",
  );
});

test("不支持的目标抛错", () => {
  assert.throws(
    () => resolveTargetBrowser(["--target=safari"], {}),
    /Unsupported target browser "safari"/,
  );
});

test("distDirName 映射", () => {
  assert.equal(distDirName("chrome"), "dist");
  assert.equal(distDirName("firefox"), "dist-firefox");
});
