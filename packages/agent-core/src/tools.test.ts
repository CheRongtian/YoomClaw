import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILTIN_TOOLS, decodeCommandOutput } from "./tools.js";

test("preserves UTF-8 command output", () => {
  assert.equal(decodeCommandOutput(Buffer.from("目录：中文", "utf8")), "目录：中文");
});

test("decodes legacy GBK/CP936 command output", () => {
  // "中文" encoded as GBK (CP936), as emitted by cmd.exe on Simplified
  // Chinese Windows when stdout is redirected to a pipe.
  assert.equal(decodeCommandOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "中文");
});

test("decodes UTF-16LE command output without a BOM", () => {
  const output = Buffer.from("Directory of C:\\工作区\r\n", "utf16le");
  assert.equal(decodeCommandOutput(output), "Directory of C:\\工作区\r\n");
});

test("full-access delete_file moves a file outside the workspace to the trash", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-delete-workspace-"));
  const outsideFile = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside.txt`);
  const trashDir = path.join(workspace, "trash");
  const trashedFile = path.join(trashDir, path.basename(outsideFile));
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(outsideFile, "remove me", "utf8");
  const deleteFile = BUILTIN_TOOLS.find((tool) => tool.definition.name === "delete_file");
  assert.ok(deleteFile);

  try {
    const outcome = await deleteFile.run(
      { path: outsideFile },
      {
        sessionId: "delete-test",
        workspace,
        safetyMode: "full-access",
        services: {
          trash: {
            move: async (filePath) => {
              fs.renameSync(filePath, trashedFile);
            },
          },
        },
      },
    );
    assert.equal(outcome.isError, false);
    assert.equal(fs.existsSync(outsideFile), false);
    assert.equal(fs.readFileSync(trashedFile, "utf8"), "remove me");
  } finally {
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("delete_file leaves the source file untouched when the trash move fails", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-delete-failure-"));
  const file = path.join(workspace, "keep.txt");
  fs.writeFileSync(file, "keep me", "utf8");
  const deleteFile = BUILTIN_TOOLS.find((tool) => tool.definition.name === "delete_file");
  assert.ok(deleteFile);

  try {
    const outcome = await deleteFile.run(
      { path: file },
      {
        sessionId: "delete-failure-test",
        workspace,
        services: {
          trash: {
            move: async () => {
              throw new Error("trash unavailable");
            },
          },
        },
      },
    );
    assert.equal(outcome.isError, true);
    assert.equal(fs.readFileSync(file, "utf8"), "keep me");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bash preserves Chinese output from the Windows command shell", { skip: process.platform !== "win32" }, async () => {
  const bash = BUILTIN_TOOLS.find((tool) => tool.definition.name === "bash");
  assert.ok(bash);

  const outcome = await bash.run(
    { command: "cmd /d /s /c echo 中文" },
    { sessionId: "encoding-test", workspace: process.cwd() },
  );

  assert.equal(outcome.isError, false);
  assert.match(outcome.result, /中文/);
});
test("planning and unified patch tools persist and apply changes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-advanced-tools-"));
  const file = path.join(workspace, "note.txt");
  fs.writeFileSync(file, "before\n", "utf8");
  const plans = new Map<string, unknown>();
  const updatePlan = BUILTIN_TOOLS.find((tool) => tool.definition.name === "update_plan");
  const applyPatch = BUILTIN_TOOLS.find((tool) => tool.definition.name === "apply_patch");
  assert.ok(updatePlan);
  assert.ok(applyPatch);
  try {
    const planOutcome = await updatePlan.run(
      { items: [{ id: "one", title: "modify file", status: "in_progress" }] },
      {
        sessionId: "advanced-test",
        workspace,
        services: {
          planStore: {
            get: () => undefined,
            set: (_id, value) => { plans.set("advanced-test", value); },
          },
        },
      },
    );
    assert.equal(planOutcome.isError, false);
    assert.equal((plans.get("advanced-test") as { items: Array<{ status: string }> }).items[0].status, "in_progress");

    const patchOutcome = await applyPatch.run(
      { patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n" },
      { sessionId: "advanced-test", workspace, safetyMode: "full-access" },
    );
    assert.equal(patchOutcome.isError, false, patchOutcome.result);
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("apply_patch moves deleted files to the trash", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-patch-delete-"));
  const file = path.join(workspace, "remove.txt");
  const trashDir = path.join(workspace, "trash");
  const trashedFile = path.join(trashDir, "remove.txt");
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(file, "remove me\n", "utf8");
  const applyPatch = BUILTIN_TOOLS.find((tool) => tool.definition.name === "apply_patch");
  assert.ok(applyPatch);
  try {
    const outcome = await applyPatch.run(
      { patch: "--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove me\n" },
      {
        sessionId: "patch-delete-test",
        workspace,
        safetyMode: "full-access",
        services: {
          trash: {
            move: async (filePath) => {
              fs.renameSync(filePath, trashedFile);
            },
          },
        },
      },
    );
    assert.equal(outcome.isError, false, outcome.result);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(trashedFile, "utf8"), "remove me\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("web_fetch extracts bounded HTML and execute_code runs without inherited secrets", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-web-tools-"));
  const webFetch = BUILTIN_TOOLS.find((tool) => tool.definition.name === "web_fetch");
  const executeCode = BUILTIN_TOOLS.find((tool) => tool.definition.name === "execute_code");
  assert.ok(webFetch);
  assert.ok(executeCode);
  try {
    globalThis.fetch = (async () => new Response("<html><head><title>Demo</title></head><body><script>bad()</script><p>Hello</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
    const webOutcome = await webFetch.run(
      { url: "https://example.test/article" },
      { sessionId: "web-test", workspace },
    );
    assert.equal(webOutcome.isError, false);
    assert.match(webOutcome.result, /Hello/);
    assert.doesNotMatch(webOutcome.result, /bad\(\)/);

    const codeOutcome = await executeCode.run(
      { language: "javascript", code: "console.log(process.env.YOOMCLAW_TEST_SECRET || 'clean')" },
      { sessionId: "code-test", workspace, safetyMode: "full-access" },
    );
    assert.equal(codeOutcome.isError, false);
    assert.match(codeOutcome.result, /clean/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("parallel preserves input order and delegates through bounded services", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-orchestration-tools-"));
  const parallel = BUILTIN_TOOLS.find((tool) => tool.definition.name === "parallel");
  const delegate = BUILTIN_TOOLS.find((tool) => tool.definition.name === "delegate_task");
  assert.ok(parallel);
  assert.ok(delegate);
  try {
    const parallelOutcome = await parallel.run(
      {
        calls: [
          { tool: "get_time", args: {} },
          { tool: "get_time", args: {} },
        ],
      },
      { sessionId: "parallel-test", workspace, safetyMode: "full-access", toolRegistry: BUILTIN_TOOLS },
    );
    assert.equal(parallelOutcome.isError, false);
    const results = JSON.parse(parallelOutcome.result) as Array<{ index: number }>;
    assert.deepEqual(results.map((item) => item.index), [0, 1]);

    const delegateOutcome = await delegate.run(
      { task: "检查项目状态" },
      {
        sessionId: "parent",
        workspace,
        safetyMode: "workspace-auto",
        services: {
          subagents: {
            delegate: async () => ({ taskId: "child", status: "completed", summary: "完成" }),
          },
        },
      },
    );
    assert.equal(delegateOutcome.isError, false);
    assert.match(delegateOutcome.result, /child/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
