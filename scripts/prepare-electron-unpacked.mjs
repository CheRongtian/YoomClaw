import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, ".tmp", "desktop-app");
const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const requestedPlatform = process.argv[2] ?? process.platform;
const isMac = requestedPlatform === "mac" || requestedPlatform === "darwin";
const electronDist = path.join(root, "node_modules", "electron", "dist");
const output = isMac
  ? path.join(root, ".tmp", "electron-unpacked-mac", "YoomClaw.app")
  : path.join(root, ".tmp", "electron-unpacked-win");

await fs.rm(isMac ? path.dirname(output) : output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });

if (isMac) {
  await fs.cp(path.join(electronDist, "Electron.app"), output, { recursive: true });
} else {
  await fs.cp(electronDist, output, { recursive: true });
  await fs.rename(path.join(output, "electron.exe"), path.join(output, "YoomClaw.exe"));
}

const appResources = isMac
  ? path.join(output, "Contents", "Resources")
  : path.join(output, "resources");
const appDir = path.join(appResources, "app");
await fs.mkdir(appDir, { recursive: true });

for (const name of ["src", "assets", "renderer", "runtime", "node_modules", "package.json"]) {
  await fs.cp(path.join(staging, name), path.join(appDir, name), { recursive: true, force: true });
}

const helperDir = path.join(appResources, "runtime-helpers");
await fs.mkdir(helperDir, { recursive: true });
for (const name of ["pdf_extract.py", "document_extract.py"]) {
  await fs.cp(path.join(root, "packages", "gateway", name), path.join(helperDir, name));
}

await fs.writeFile(
  path.join(appResources, "app-update.yml"),
  ["provider: github", "owner: Alex-Wang-88", "repo: YoomClaw", "releaseType: release", ""].join("\n"),
  "utf8",
);

if (isMac) {
  const plist = path.join(output, "Contents", "Info.plist");
  const replacements = [
    ["CFBundleExecutable", "YoomClaw"],
    ["CFBundleDisplayName", "YoomClaw"],
    ["CFBundleName", "YoomClaw"],
    ["CFBundleIdentifier", "com.yoomclaw.desktop"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
  ];
  for (const [key, value] of replacements) {
    await execFileAsync("plutil", ["-replace", key, "-string", value, plist]);
  }
  await fs.rename(path.join(output, "Contents", "MacOS", "Electron"), path.join(output, "Contents", "MacOS", "YoomClaw"));
}

console.log(`[YoomClaw] prepackaged Electron app written to ${path.relative(root, output)}`);
