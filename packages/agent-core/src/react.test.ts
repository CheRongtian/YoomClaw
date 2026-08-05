import assert from "node:assert/strict";
import test from "node:test";
import { buildSafetyPrompt, buildToolPrompt, callFingerprint, parseToolCall } from "./react.js";

test("ReAct parser accepts JSON, fenced JSON and ignores unknown tools", () => {
  const known = new Set(["read_file"]);
  assert.deepEqual(parseToolCall('{"tool":"read_file","args":{"path":"README.md"}}', known), {
    tool: "read_file",
    args: { path: "README.md" },
  });
  assert.deepEqual(parseToolCall("```json\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```", known), {
    tool: "read_file",
    args: { path: "a.ts" },
  });
  assert.equal(parseToolCall('{"tool":"run_command","args":{}}', known), null);
  assert.equal(callFingerprint({ tool: "read_file", args: { path: "a.ts" } }), "read_file(path=\"a.ts\")");
});

test("ReAct parser can accept an explicitly allowed dynamic MCP tool", () => {
  const known = new Set(["tool_search"]);
  assert.deepEqual(
    parseToolCall(
      '{"tool":"mcp.local_server.lookup","args":{"query":"hello"}}',
      known,
      (name) => name.startsWith("mcp."),
    ),
    { tool: "mcp.local_server.lookup", args: { query: "hello" } },
  );
  assert.equal(parseToolCall('{"tool":"shell_escape","args":{}}', known, (name) => name.startsWith("mcp.")), null);
});

test("tool prompt describes tools without relying on native tool calling", () => {
  const prompt = buildToolPrompt([{
    name: "read_file",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }]);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /JSON/);
});

test("full-access prompt tells the model to operate outside the workspace", () => {
  const prompt = buildSafetyPrompt("full-access");
  assert.match(prompt, /完全访问权限/);
  assert.match(prompt, /当前权限模式：full-access/);
  assert.match(prompt, /工作区内外/);
  assert.match(prompt, /不要因为目标路径位于工作区外而拒绝/);
});
