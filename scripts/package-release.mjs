import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { distDirName, resolveTargetBrowser } from "./target-browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const targetBrowser = resolveTargetBrowser();
const distDir = path.join(extensionDir, distDirName(targetBrowser));
const releaseDir = path.join(rootDir, "release");

const extensionPackageRaw = await readFile(
  path.join(extensionDir, "package.json"),
  "utf8",
);
const extensionPackage = JSON.parse(extensionPackageRaw);
const version = extensionPackage.version;
const zipName = `bili-syncplay-extension-v${version}-${targetBrowser}.zip`;
const zipPath = path.join(releaseDir, zipName);
// Firefox 用户可直接拖入 .xpi 安装；与 zip 同字节流，复制即可。
const xpiPath =
  targetBrowser === "firefox"
    ? path.join(releaseDir, `bili-syncplay-extension-v${version}-firefox.xpi`)
    : null;

await access(distDir, constants.F_OK);
await mkdir(releaseDir, { recursive: true });
await rm(zipPath, { force: true });
if (xpiPath) {
  await rm(xpiPath, { force: true });
}

if (process.platform === "win32") {
  await run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    rootDir,
  );
} else {
  await run("zip", ["-rq", zipPath, "."], distDir);
}

console.log(`Release package created: ${zipPath}`);

if (xpiPath) {
  await copyFile(zipPath, xpiPath);
  console.log(`Release package created: ${xpiPath}`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
