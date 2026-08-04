import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatCompletionRequest, ChatMessage } from "@yoomclaw/protocol";
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

class VisionScriptedProvider implements LLMProvider {
  readonly id = "vision-scripted";
  readonly requests: ChatCompletionRequest[] = [];

  async *chat(request: ChatCompletionRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    yield { kind: "content", content: "vision-ok" };
  }

  async uploadFile(): Promise<never> {
    throw new Error("not used");
  }
}

class EmptyResponseProvider implements LLMProvider {
  readonly id = "empty-response";

  async *chat(): AsyncIterable<ProviderChunk> {
    // The upstream stream ends without a content chunk.
  }

  async uploadFile(): Promise<never> {
    throw new Error("not used");
  }
}

class UnknownToolProvider implements LLMProvider {
  readonly id = "unknown-tool";

  async *chat(): AsyncIterable<ProviderChunk> {
    yield { kind: "content", content: '{"tool":"list_dir","args":{}}' };
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
    {
      provider: "scripted",
      model: "test",
      mode: "hermes",
      promptMode: "local",
      toolsets: ["coding"],
    },
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

test("provider prompt mode sends the task without a local bootstrap or review request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-provider-prompt-"));
  fs.writeFileSync(path.join(root, "note.txt"), "hello from workspace", "utf8");
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Provider prompt");
  const provider = new ScriptedProvider();
  const agent = new Agent(
    {
      provider: "scripted",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["coding"],
    },
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

  for await (const _event of agent.run(session.id, "请读取 note.txt")) {
    // Consume the event stream.
  }

  const apiRequests = provider.requests.filter((request) => request.source === "api");
  assert.equal(String(apiRequests[0].messages[0].content), "请读取 note.txt");
  assert.equal(provider.requests.some((request) => request.source === "memory-review"), false);
});

test("agent context reaches the provider but stays out of visible session history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-context-"));
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Internal context");
  const provider = new ScriptedProvider();
  const agent = new Agent(
    {
      provider: "scripted",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["coding"],
    },
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

  const visible = "[已解析 PDF：demo.pdf，共 1 页]";
  const internal = "请概括以下 PDF 内容：\n[本地 PDF 内容：demo.pdf]\n内部测试内容";
  const input: ChatMessage = {
    role: "user",
    content: visible,
    agentContext: internal,
  };
  for await (const _event of agent.run(session.id, input)) {
    // Consume the event stream.
  }

  const apiRequests = provider.requests.filter((request) => request.source === "api");
  assert.equal(String(apiRequests[0].messages[0].content), internal);
  const stored = sessions.get(session.id)!;
  assert.equal(stored.messages[0].content, visible);
  assert.equal("agentContext" in stored.messages[0], false);
});

test("vision context is converted to text before the main provider request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-vision-"));
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Vision context");
  const provider = new VisionScriptedProvider();
  const agent = new Agent(
    {
      provider: "vision-scripted",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["vision"],
    },
    provider,
    sessions,
    BUILTIN_TOOLS,
    root,
    {
      dataDir,
      promptStore: new PromptStore(root, dataDir),
      memoryStore: new MemoryStore(root, dataDir),
      skillStore: new SkillStore(root, dataDir),
      vision: { analyze: async () => "OCR result" },
    },
  );

  const input: ChatMessage = {
    role: "user",
    content: "[已附加图片：image.png]",
    agentContext: [
      { type: "text", text: "describe image" },
      { type: "image_url", image_url: { url: "https://files.example.test/image.png" } },
    ],
  };
  const events = [];
  for await (const event of agent.run(session.id, input)) events.push(event);

  const requestContent = provider.requests[0].messages[0].content;
  assert.ok(Array.isArray(requestContent));
  assert.equal(requestContent.some((part) => part.type === "image_url"), false);
  assert.match(
    requestContent.map((part) => part.type === "text" ? part.text : "").join("\n"),
    /OCR result/,
  );
  assert.equal(events.some((event) => event.type === "final" && event.text === "vision-ok"), true);
});

test("agent strips raw image parts when Vision is unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-no-vision-"));
  const sessions = new SessionStore();
  const session = sessions.create("No Vision");
  const provider = new VisionScriptedProvider();
  const agent = new Agent(
    {
      provider: "vision-scripted",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
    },
    provider,
    sessions,
    BUILTIN_TOOLS,
    root,
  );

  const input: ChatMessage = {
    role: "user",
    content: "[已附加图片：image.png]",
    agentContext: [
      { type: "text", text: "describe image" },
      { type: "image_url", image_url: { url: "https://files.example.test/image.png" } },
    ],
  };
  for await (const _event of agent.run(session.id, input)) {
    // Consume the event stream.
  }

  const requestContent = provider.requests[0].messages[0].content;
  assert.ok(Array.isArray(requestContent));
  assert.equal(requestContent.some((part) => part.type === "image_url"), false);
  assert.equal(
    requestContent.map((part) => part.type === "text" ? part.text : "").join(""),
    "describe image",
  );
});

test("agent strips raw image parts when Vision fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-vision-error-"));
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Vision error");
  const provider = new VisionScriptedProvider();
  const agent = new Agent(
    {
      provider: "vision-scripted",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["vision"],
    },
    provider,
    sessions,
    BUILTIN_TOOLS,
    root,
    {
      dataDir,
      promptStore: new PromptStore(root, dataDir),
      memoryStore: new MemoryStore(root, dataDir),
      skillStore: new SkillStore(root, dataDir),
      vision: {
        analyze: async () => {
          throw new Error("vision offline");
        },
      },
    },
  );

  const input: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "describe image" },
      { type: "image_url", image_url: { url: "https://files.example.test/image.png" } },
    ],
  };
  const events = [];
  for await (const event of agent.run(session.id, input)) events.push(event);

  const requestContent = provider.requests[0].messages[0].content;
  assert.ok(Array.isArray(requestContent));
  assert.equal(requestContent.some((part) => part.type === "image_url"), false);
  assert.equal(events.some((event) => event.type === "vision" && event.status === "error"), true);
});

test("agent surfaces a non-empty fallback for a successful empty provider response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-empty-response-"));
  const sessions = new SessionStore();
  const session = sessions.create("Empty response");
  const agent = new Agent(
    {
      provider: "empty-response",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
    },
    new EmptyResponseProvider(),
    sessions,
    BUILTIN_TOOLS,
    root,
  );

  const events = [];
  for await (const event of agent.run(session.id, "Reply about README.md")) events.push(event);
  const final = events.find((event) => event.type === "final");
  assert.ok(final && final.type === "final");
  assert.match(final.text, /README\.md/);
});

test("agent does not expose an unavailable provider tool request as the final answer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-unknown-tool-"));
  const sessions = new SessionStore();
  const session = sessions.create("Unknown tool");
  const agent = new Agent(
    {
      provider: "unknown-tool",
      model: "test",
      mode: "hermes",
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["vision"],
    },
    new UnknownToolProvider(),
    sessions,
    BUILTIN_TOOLS,
    root,
  );

  const events = [];
  for await (const event of agent.run(session.id, "Reply about README.md")) events.push(event);
  const final = events.find((event) => event.type === "final");
  assert.ok(final && final.type === "final");
  assert.match(final.text, /unavailable tool/);
  assert.match(final.text, /README\.md/);
  assert.equal(final.text.includes('{"tool":"list_dir"'), false);
});
