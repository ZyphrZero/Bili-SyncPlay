// Chrome extension types are provided by @types/chrome.
//
// Firefox 同时暴露 `browser` 命名空间（Promise 风格，与 `chrome` 等价）。
// 源码统一使用 `chrome.*`（Firefox 原生兼容），此处仅作可选兜底声明，
// 避免在引用 `browser` 做特性探测时报未定义。
declare const browser: typeof chrome | undefined;
