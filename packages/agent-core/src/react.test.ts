import assert from "node:assert/strict";
import test from "node:test";
import { buildToolPrompt, callFingerprint, parseToolCall } from "./react.js";

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

test("tool prompt describes tools without relying on native tool calling", () => {
  const prompt = buildToolPrompt([{
    name: "read_file",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }]);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /JSON/);
});
