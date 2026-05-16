// 解析构建/打包脚本的目标浏览器。
//
// 优先级：CLI `--target=<v>` / `--target <v>` > 环境变量 TARGET_BROWSER > 默认 chrome。
// 用 CLI 参数而非 cross-env，可跨平台（含 Windows）且不引入额外依赖；
// 同时保留 TARGET_BROWSER 环境变量入口，便于 CI 矩阵注入。

const SUPPORTED_TARGETS = new Set(["chrome", "firefox"]);

export function resolveTargetBrowser(
  argv = process.argv.slice(2),
  env = process.env,
) {
  let fromArg = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      fromArg = argv[index + 1] ?? null;
      break;
    }
    if (arg.startsWith("--target=")) {
      fromArg = arg.slice("--target=".length);
      break;
    }
  }

  const raw = (fromArg ?? env.TARGET_BROWSER ?? "chrome").trim().toLowerCase();
  if (!SUPPORTED_TARGETS.has(raw)) {
    throw new Error(
      `Unsupported target browser "${raw}"; expected one of: ${[...SUPPORTED_TARGETS].join(", ")}.`,
    );
  }
  return raw;
}

// 各 target 对应的 dist 目录名，build 与 package 脚本共用，避免不一致。
export function distDirName(targetBrowser) {
  return targetBrowser === "firefox" ? "dist-firefox" : "dist";
}
