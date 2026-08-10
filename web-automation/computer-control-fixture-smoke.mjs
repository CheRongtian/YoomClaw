import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { WindowsComputerUseController } from "../packages/agent-core/dist/computer.js";

const execFileAsync = promisify(execFile);

if (process.platform !== "win32") {
  console.warn("[computer-control-fixture-smoke] skipped: Windows is required");
  process.exit(0);
}

const helperPath = path.join(
  process.cwd(),
  "apps",
  "desktop",
  "runtime",
  "computer-control-win",
  "YoomClaw.ComputerControl.exe",
);
const fixturePath = path.join(
  process.cwd(),
  ".tmp",
  "computer-control-fixture",
  "YoomClaw.ComputerControl.Fixture.exe",
);
if (!fs.existsSync(helperPath) || !fs.existsSync(fixturePath)) {
  console.warn("[computer-control-fixture-smoke] skipped: helper or fixture is not built");
  process.exit(0);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "yoomclaw-computer-fixture-data-"));
const fixture = spawn(fixturePath, [], { stdio: "ignore", windowsHide: false });
const controller = new WindowsComputerUseController(dataDir, { enabled: true, helperPath });

function findElement(root, automationId) {
  if (!root || typeof root !== "object") return undefined;
  if (root.automationId === automationId) return root;
  for (const child of root.children ?? []) {
    const match = findElement(child, automationId);
    if (match) return match;
  }
  return undefined;
}

async function waitForFixtureWindow() {
  const deadline = Date.now() + 15_000;
  let lastTitles = [];
  while (Date.now() < deadline) {
    const windows = await controller.listWindows();
    lastTitles = windows.map((window) => window.title);
    const match = windows.find((window) => window.title === "YoomClaw Computer Control Fixture");
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`computer-control fixture window did not appear; visible titles: ${lastTitles.join(" | ")}`);
}

try {
  const window = await waitForFixtureWindow();
  const tree = await controller.inspect(window.hwnd);
  assert.ok(findElement(tree, "fixtureInput"));
  assert.ok(findElement(tree, "fixtureApply"));
  assert.ok(findElement(tree, "fixtureStatus"));

  assert.equal((await controller.read(window.hwnd, { automationId: "fixtureInput" })).value, "");
  await controller.type(window.hwnd, { automationId: "fixtureInput" }, "Ada");
  assert.equal((await controller.read(window.hwnd, { automationId: "fixtureInput" })).value, "Ada");
  await controller.click(window.hwnd, { automationId: "fixtureApply" });
  assert.equal((await controller.read(window.hwnd, { automationId: "fixtureStatus" })).value, "Hello Ada");
  await controller.click(window.hwnd, { name: "Two", controlType: "ListItem" });
  assert.match((await controller.read(window.hwnd, { automationId: "fixtureChoice" })).value, /Two/);

  const focused = await controller.focus(window.hwnd);
  assert.equal(focused.focused, true);
  await controller.pressKey(window.hwnd, "ESC");
  const screenshot = await controller.screenshot(window.hwnd);
  assert.equal(fs.existsSync(screenshot.path), true);

  await assert.rejects(
    () => controller.read(1, { automationId: "fixtureInput" }),
    (error) => error?.code === "WINDOW_NOT_FOUND",
  );

  const auditPath = path.join(dataDir, "computer", "audit.jsonl");
  const audit = fs.readFileSync(auditPath, "utf8");
  assert.match(audit, /YoomClaw Computer Control Fixture/);
  assert.match(audit, /"action":"type"/);
  assert.match(audit, /"action":"click"/);
  assert.match(audit, /"action":"press_key"/);
  assert.equal(audit.includes("Ada"), false);
  assert.equal(audit.includes('"text"'), false);
  console.log(JSON.stringify({ ok: true, hwnd: window.hwnd, screenshot: screenshot.path }));
} finally {
  await controller.close();
  if (!fixture.killed && fixture.pid) {
    await execFileAsync("taskkill", ["/PID", String(fixture.pid), "/T", "/F"]).catch(() => undefined);
  }
  await new Promise((resolve) => {
    if (fixture.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3_000);
    fixture.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await rm(dataDir, { recursive: true, force: true });
}
