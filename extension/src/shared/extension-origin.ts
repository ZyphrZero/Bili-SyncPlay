/**
 * 返回当前扩展运行环境的 origin。
 *
 * Chrome/Edge 为 `chrome-extension://<id>`，Firefox 为 `moz-extension://<uuid>`。
 *
 * 通过 `chrome.runtime.getURL("/")` 推导，而非手拼 `chrome.runtime.id`，
 * 可在 Chrome / Edge / Firefox 下都返回正确的 origin。
 *
 * 注意：不使用 `new URL(...).origin`——WHATWG URL 解析器对
 * `chrome-extension:` / `moz-extension:` 这类非特殊 scheme 的 `.origin`
 * 在部分运行时（如 Node）返回 `"null"`。`getURL("/")` 的返回值恒为
 * `"<scheme>://<host>/"`，剥掉结尾斜杠即为 origin，跨运行时稳定。
 */
export function getExtensionOrigin(): string {
  return chrome.runtime.getURL("/").replace(/\/$/, "");
}
