import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, "apps", "desktop", "runtime");

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

console.log(`[YoomClaw] desktop Gateway runtime written to ${path.relative(root, runtimeDir)}`);
