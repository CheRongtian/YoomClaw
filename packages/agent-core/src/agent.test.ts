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

class ImageScriptedProvider implements LLMProvider {
  readonly id = "image-scripted";
  readonly requests: ChatCompletionRequest[] = [];

  async *chat(request: ChatCompletionRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    yield { kind: "content", content: "image-ok" };
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

class DeleteFileProvider implements LLMProvider {
  readonly id = "delete-file";
  readonly requests: ChatCompletionRequest[] = [];
  private call = 0;

  constructor(private readonly targetPath: string) {}

  async *chat(request: ChatCompletionRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    this.call += 1;
    yield {
      kind: "content",
      content: this.call === 1
        ? JSON.stringify({ tool: "delete_file", args: { path: this.targetPath } })
        : "文件已移到回收站。",
    };
  }

  async uploadFile(): Promise<never> {
    throw new Error("not used");
  }
}

class LeakingDeleteProvider implements LLMProvider {
  readonly id = "leaking-delete";
  readonly requests: ChatCompletionRequest[] = [];
  private call = 0;

  async *chat(request: ChatCompletionRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    this.call += 1;
    yield {
      kind: "content",
      content: this.call === 1
        ? "We need actually tool call, but response must be JSON. I mistakenly final. Need now tool? We can issue commentary? Rules say only one line JSON. Let's do."
        : "文件已移到回收站。",
    };
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

test("full-access Agent can move a file outside the workspace to the trash without confirmation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-full-access-"));
  const outsideFile = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside.txt`);
  const trashDir = path.join(workspace, "trash");
  const trashedFile = path.join(trashDir, path.basename(outsideFile));
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(outsideFile, "remove me", "utf8");
  const dataDir = path.join(workspace, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Full access");
  const provider = new DeleteFileProvider(outsideFile);
  const agent = new Agent(
    {
      provider: "delete-file",
      model: "test",
      promptMode: "provider",
      toolsets: ["coding"],
    },
    provider,
    sessions,
    BUILTIN_TOOLS,
    workspace,
    {
      dataDir,
      promptStore: new PromptStore(workspace, dataDir),
      memoryStore: new MemoryStore(workspace, dataDir),
      skillStore: new SkillStore(workspace, dataDir),
      services: {
        trash: {
          move: async (filePath) => {
            fs.renameSync(filePath, trashedFile);
          },
        },
      },
    },
  );

  try {
    const events = [];
    for await (const event of agent.run(session.id, "删除外部文件", {
      safetyMode: "full-access",
    })) {
      events.push(event);
    }
    const toolEnd = events.find((event) => event.type === "tool_end");
    assert.equal(toolEnd?.type, "tool_end");
    assert.equal(toolEnd?.isError, false);
    assert.equal(events.some((event) => event.type === "tool_confirm"), false);
    const apiRequest = provider.requests.find((request) => request.source === "api");
    assert.equal(apiRequest?.extra?.safetyMode, "full-access");
    assert.equal(fs.existsSync(outsideFile), false);
    assert.equal(fs.readFileSync(trashedFile, "utf8"), "remove me");
  } finally {
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("attached-file delete recovers from a leaked tool protocol draft", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-leaked-delete-"));
  const attachedFile = path.join(path.dirname(workspace), `${path.basename(workspace)}-attached.docx`);
  const trashDir = path.join(workspace, "trash");
  const trashedFile = path.join(trashDir, path.basename(attachedFile));
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(attachedFile, "remove me", "utf8");
  const dataDir = path.join(workspace, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Leaked delete");
  const provider = new LeakingDeleteProvider();
  const agent = new Agent(
    {
      provider: "leaking-delete",
      model: "test",
      promptMode: "provider",
      toolsets: ["coding"],
    },
    provider,
    sessions,
    BUILTIN_TOOLS,
    workspace,
    {
      dataDir,
      promptStore: new PromptStore(workspace, dataDir),
      memoryStore: new MemoryStore(workspace, dataDir),
      skillStore: new SkillStore(workspace, dataDir),
      services: {
        trash: {
          move: async (filePath) => {
            fs.renameSync(filePath, trashedFile);
          },
        },
      },
    },
  );

  try {
    const events = [];
    for await (const event of agent.run(session.id, {
      role: "user",
      content: "帮我把这个文档删除",
      localPaths: [attachedFile],
    }, {
      safetyMode: "full-access",
    })) {
      events.push(event);
    }
    const toolEnd = events.find((event) => event.type === "tool_end");
    assert.equal(toolEnd?.type, "tool_end");
    assert.equal(toolEnd?.isError, false);
    assert.equal(events.some((event) => event.type === "delta" && event.text.includes("We need actually")), false);
    assert.equal(fs.existsSync(attachedFile), false);
    assert.equal(fs.readFileSync(trashedFile, "utf8"), "remove me");
  } finally {
    fs.rmSync(attachedFile, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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
  const providerPrompt = String(apiRequests[0].messages[0].content);
  assert.match(providerPrompt, /当前权限模式：workspace-auto/);
  assert.match(providerPrompt, /请读取 note\.txt/);
  assert.equal(apiRequests[0].extra?.safetyMode, "workspace-auto");
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
  const localPath = "C:\\Users\\tester\\demo.pdf";
  const input: ChatMessage = {
    role: "user",
    content: visible,
    localPaths: [localPath],
    agentContext: internal,
  };
  for await (const _event of agent.run(session.id, input)) {
    // Consume the event stream.
  }

  const apiRequests = provider.requests.filter((request) => request.source === "api");
  const providerPrompt = String(apiRequests[0].messages[0].content);
  assert.match(providerPrompt, /当前权限模式：workspace-auto/);
  assert.match(providerPrompt, new RegExp(internal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const stored = sessions.get(session.id)!;
  assert.equal(stored.messages[0].content, visible);
  assert.deepEqual(stored.messages[0].localPaths, [localPath]);
  assert.match(providerPrompt, new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal("agentContext" in stored.messages[0], false);
});

test("hosted image parts are forwarded to the main provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-image-"));
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore();
  const session = sessions.create("Image context");
  const provider = new ImageScriptedProvider();
  const agent = new Agent(
    {
      provider: "image-scripted",
      model: "test",
      promptMode: "provider",
      autoMemoryReview: false,
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
  assert.equal(requestContent.some((part) => part.type === "image_url"), true);
  assert.equal(requestContent.find((part) => part.type === "image_url")?.image_url.url, "https://files.example.test/image.png");
  assert.match(
    requestContent.map((part) => part.type === "text" ? part.text : "").join("\n"),
    /describe image/,
  );
  assert.equal(events.some((event) => event.type === "final" && event.text === "image-ok"), true);
});

test("agent surfaces a non-empty fallback for a successful empty provider response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-agent-empty-response-"));
  const sessions = new SessionStore();
  const session = sessions.create("Empty response");
  const agent = new Agent(
    {
      provider: "empty-response",
      model: "test",
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
      promptMode: "provider",
      autoMemoryReview: false,
      toolsets: ["planning"],
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
