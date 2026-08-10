import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { NativeComputerUseController } from "../packages/agent-core/dist/computer.js";

if (process.platform !== "win32" && process.platform !== "darwin") {
  console.warn("[computer-control-smoke] skipped: Windows or macOS is required");
  process.exit(0);
}

const helperPath = path.join(
  process.cwd(),
  "apps",
  "desktop",
  "runtime",
  process.platform === "darwin" ? "computer-control-mac" : "computer-control-win",
  process.platform === "darwin" ? "YoomClaw.ComputerControl" : "YoomClaw.ComputerControl.exe",
);
if (!fs.existsSync(helperPath)) {
  console.warn("[computer-control-smoke] skipped: published helper is not present");
  process.exit(0);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "yoomclaw-computer-data-"));
const controller = new NativeComputerUseController(dataDir, { enabled: true, helperPath });

try {
  const windows = await controller.listWindows();
  const status = controller.status();
  assert.equal(status.enabled, true);
  assert.equal(status.available, true);
  assert.equal(status.helperVersion, "0.1.0");
  assert.ok(windows.every((window) => Number.isSafeInteger(window.hwnd) && window.hwnd > 0));
  const auditPath = path.join(dataDir, "computer", "audit.jsonl");
  assert.equal(fs.existsSync(auditPath), true);
  const audit = fs.readFileSync(auditPath, "utf8");
  assert.match(audit, /"action":"list_windows"/);
  assert.equal(audit.includes("allowInputInjection"), false);
  console.log(JSON.stringify({ ok: true, helperVersion: status.helperVersion, windows: windows.length }));
} finally {
  await controller.close();
  await rm(dataDir, { recursive: true, force: true });
}
