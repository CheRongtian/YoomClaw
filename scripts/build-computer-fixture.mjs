import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "packages", "computer-control-win", "fixture", "ComputerControlFixture.csproj");
const output = path.join(root, ".tmp", "computer-control-fixture");
const dotnet = process.env.YOOMCLAW_DOTNET_PATH?.trim() || "dotnet";

if (process.platform !== "win32") {
  console.log("[YoomClaw] Skipping the Windows computer fixture on a non-Windows host.");
  process.exit(0);
}

const sdkProbe = spawnSync(dotnet, ["--list-sdks"], { encoding: "utf8" });
if (sdkProbe.status !== 0 || !sdkProbe.stdout?.trim()) {
  console.warn("[YoomClaw] .NET SDK not installed; the Windows computer fixture was not built.");
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
console.log(`[YoomClaw] Windows computer fixture written to ${path.relative(root, output)}`);
