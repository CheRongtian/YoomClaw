import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSessionRepository } from "./session-repository.js";

test("imports legacy sessions into file-per-session storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-session-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(workspace, ".claw-data"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".claw-data", "sessions.json"),
    JSON.stringify([{
      id: "legacy-1",
      title: "Legacy",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: "user", content: "hello" }],
    }]),
  );

  const repository = new FileSessionRepository(dataDir, workspace);
  const sessions = repository.load();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].schemaVersion, 2);
  assert.equal(sessions[0].providerSessionId, "legacy-1");
  assert.equal(fs.existsSync(path.join(dataDir, "sessions", "legacy-1.json")), true);

  const restored = new FileSessionRepository(dataDir, workspace).load();
  assert.equal(restored[0].messages[0].content, "hello");
  assert.equal(repository.delete("legacy-1"), true);
  assert.equal(repository.delete("legacy-1"), false);
});
