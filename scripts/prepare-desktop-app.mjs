import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "apps", "desktop");
const staging = path.join(root, ".tmp", "desktop-app");

await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(path.dirname(staging), { recursive: true });

await execFileAsync("pnpm", [
  "--filter",
  "@yoomclaw/desktop",
  "deploy",
  "--prod",
  "--legacy",
  "--frozen-lockfile",
  "--config.node-linker=hoisted",
  staging,
], {
  cwd: root,
  windowsHide: true,
  shell: process.platform === "win32",
});

for (const name of ["src", "assets", "renderer/dist", "runtime"]) {
  const from = path.join(source, name);
  const to = path.join(staging, name);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
}

console.log(`[YoomClaw] packaged app staging prepared at ${path.relative(root, staging)}`);
