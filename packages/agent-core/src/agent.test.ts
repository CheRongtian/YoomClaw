import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatCompletionRequest } from "@yoomclaw/protocol";
import type { LLMProvider, ProviderChunk } from "@yoomclaw/llm-provider";
import { Agent, SessionStore } from "./index.js";
import { PromptStore, MemoryStore, SkillStore } from "./config.js";
import { BUILTIN_TOOLS } from "./tools.js";

class ScriptedProvider implements LLMProvider {
  readonly id = "scripted";
  readonly requests: ChatCompletionRequest[] = [];
  private call = 0;

  async *chat(request: ChatCompletionRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    this.call += 1;
    if (this.call === 1) {
      yield { kind: "content", content: '{"tool":"read_file","args":{"path":"note.txt"}}' };
    } else {
      yield { kind: "content", content: "已读取 note.txt。" };
    }
  }

  async uploadFile(): Promise<never> {
    throw new Error("not used");
  }
}

test("Hermes Agent bootstraps prompts once and persists run events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-run-"));
  fs.writeFileSync(path.join(root, "note.txt"), "hello from workspace", "utf8");
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Test");
  const provider = new ScriptedProvider();
  const agent = new Agent(
    { provider: "scripted", model: "test", mode: "hermes", toolsets: ["coding"] },
    provider,
    sessions,
    BUILTIN_TOOLS,
    root,
    {
      dataDir,
      promptStore: new PromptStore(root, dataDir),
      memoryStore: new MemoryStore(root, dataDir),
      skillStore: new SkillStore(root, dataDir),
    },
  );

  const events = [];
  for await (const event of agent.run(session.id, "请读取 note.txt")) events.push(event);
  const apiRequests = provider.requests.filter((request) => request.source === "api");
  assert.equal(apiRequests.length, 2);
  assert.match(String(apiRequests[0].messages[0].content), /Hermes Mode/);
  assert.match(String(apiRequests[0].messages[0].content), /note\.txt/);
  assert.match(String(apiRequests[1].messages[0].content), /工具结果/);
  assert.equal(events.some((event) => event.type === "tool_end" && !event.isError), true);
  assert.equal(events.some((event) => event.type === "final"), true);
  assert.equal(events.at(-1)?.type, "run");
  assert.equal((events.at(-1) as { status: string }).status, "completed");
  const stored = sessions.get(session.id)!;
  assert.equal(stored.messages.at(-1)?.role, "assistant");
  assert.equal(stored.runs?.[0].status, "completed");
});
