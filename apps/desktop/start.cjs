#!/usr/bin/env node
// Cross-platform Electron launcher.
// Bypasses a pnpm-specific bug: electron's path.txt ships as "dist\electron.exe" while its
// index.js also prepends a "dist" segment, producing ".../electron/dist/dist/electron.exe"
// (ENOENT). Instead of requiring electron/cli.js (which reads that buggy path), we resolve
// the real binary on disk and spawn it directly. Works on Windows/macOS/Linux.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..", ".."); // repo root (YoomClaw/)
const appDir = __dirname; // apps/desktop
const exeName = process.platform === "win32" ? "electron.exe" : "electron";

// 1) Preferred location (pnpm symlink resolves here)
let exe = path.join(root, "node_modules", "electron", "dist", exeName);

if (!fs.existsSync(exe)) {
  // 2) Fallback: recursive search under node_modules (npm / non-pnpm layouts)
  const base = path.join(root, "node_modules");
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = walk(full);
        if (r) return r;
      } else if (e.name === exeName) {
        return full;
      }
    }
    return null;
  };
  const found = walk(base);
  if (!found) {
    console.error("[YoomClaw] electron binary not found under", base);
    process.exit(1);
  }
  exe = found;
}

// Safety: ensure Electron runs as the real runtime, not plain Node
delete process.env.ELECTRON_RUN_AS_NODE;

const args = [".", ...process.argv.slice(2)];
const child = spawn(exe, args, { cwd: appDir, stdio: "inherit", windowsHide: false });

child.on("close", (code, signal) => {
  if (code === null) {
    console.error("[YoomClaw] electron exited with signal", signal);
    process.exit(1);
  }
  process.exit(code);
});

const onSignal = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
