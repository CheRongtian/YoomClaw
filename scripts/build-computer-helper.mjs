import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "packages", "computer-control-win", "ComputerControlWin.csproj");
const dotnet = process.env.YOOMCLAW_DOTNET_PATH?.trim() || "dotnet";

if (process.platform === "darwin") {
  const source = path.join(root, "packages", "computer-control-mac", "main.swift");
  const output = path.join(root, "apps", "desktop", "runtime", "computer-control-mac");
  const binary = path.join(output, "YoomClaw.ComputerControl");
  const moduleCache = path.join(root, ".tmp", "swift-module-cache");
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(moduleCache, { recursive: true });
  const compile = spawnSync("xcrun", [
    "swiftc", "-O", "-target", "arm64-apple-macos11.0", source,
    "-framework", "AppKit",
    "-framework", "ApplicationServices",
    "-framework", "CoreGraphics",
    "-o", binary,
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache,
    },
  });
  if (compile.status !== 0) process.exit(compile.status ?? 1);
  await fs.chmod(binary, 0o755);
  console.log(`[YoomClaw] macOS computer helper written to ${path.relative(root, output)}`);
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log("[YoomClaw] Skipping native computer helper on this platform.");
  process.exit(0);
}

const output = path.join(root, "apps", "desktop", "runtime", "computer-control-win");
const sdkProbe = spawnSync(dotnet, ["--list-sdks"], { encoding: "utf8" });
if (sdkProbe.status !== 0 || !sdkProbe.stdout?.trim()) {
  console.warn("[YoomClaw] .NET SDK not installed; Windows computer helper was not built.");
  process.exit(0);
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const publish = spawnSync(
  dotnet,
  ["publish", project, "-c", "Release", "-r", "win-x64", "--self-contained", "true", "/p:PublishSingleFile=true", "/p:EnableCompressionInSingleFile=true", "-o", output],
  { cwd: root, stdio: "inherit" },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);
console.log(`[YoomClaw] Windows computer helper written to ${path.relative(root, output)}`);
