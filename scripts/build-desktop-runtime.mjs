import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, "apps", "desktop", "runtime");
const helperDir = path.join(runtimeDir, "computer-control-win");
const helperStaging = path.join(root, ".tmp", "computer-control-win-staging");

await fs.rm(helperStaging, { recursive: true, force: true });
try {
  await fs.cp(helperDir, helperStaging, { recursive: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await fs.rm(runtimeDir, { recursive: true, force: true });
await fs.mkdir(runtimeDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "packages", "gateway", "src", "bin.ts")],
  outfile: path.join(runtimeDir, "gateway.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["electron", "playwright-core", "ws"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

try {
  await fs.cp(helperStaging, helperDir, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
} finally {
  await fs.rm(helperStaging, { recursive: true, force: true });
}

console.log(`[YoomClaw] desktop Gateway runtime written to ${path.relative(root, runtimeDir)}`);
