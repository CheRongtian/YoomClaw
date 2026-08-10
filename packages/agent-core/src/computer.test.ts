import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsComputerUseController } from "./computer.js";

test("Windows computer controller speaks JSONL and redacts helper-side text handling", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows helper protocol test only runs on Windows");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-computer-test-"));
  const helper = path.join(root, "fake-helper.mjs");
  fs.writeFileSync(helper, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    for await (const line of input) {
      const request = JSON.parse(line);
      let result;
      if (request.action === "ping") result = { version: "fake-test" };
      else if (request.action === "list_windows") result = [{ hwnd: 42, title: "Fixture", focused: true }];
      else if (request.action === "read") result = { value: "fixture-value", element: { name: "Field" } };
      else if (request.action === "type") result = { name: "Field", enabled: true };
      else result = { hwnd: request.hwnd ?? 42, action: request.action };
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
    }
  `, "utf8");

  const controller = new WindowsComputerUseController(path.join(root, "data"), {
    enabled: true,
    helperPath: helper,
  });
  try {
    assert.equal(controller.status().enabled, true);
    assert.equal(controller.status().available, true);
    assert.deepEqual(await controller.listWindows(), [{ hwnd: 42, title: "Fixture", focused: true }]);
    assert.equal(controller.status().available, true);
    assert.equal(controller.status().helperVersion, "fake-test");
    assert.deepEqual(await controller.read(42, { name: "Field" }), { value: "fixture-value", element: { name: "Field" } });
    assert.deepEqual(await controller.type(42, { name: "Field" }, "secret-value"), { name: "Field", enabled: true });
  } finally {
    await controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disabled Windows computer controller fails closed", async () => {
  const controller = new WindowsComputerUseController(path.join(os.tmpdir(), "yoomclaw-computer-disabled"), { enabled: false });
  await assert.rejects(
    () => controller.listWindows(),
    (error) => error && typeof error === "object" && (error as { code?: unknown }).code === "COMPUTER_DISABLED",
  );
});
