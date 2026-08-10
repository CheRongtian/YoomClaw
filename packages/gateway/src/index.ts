/**
 * @yoomclaw/gateway - HTTP + WebSocket Gateway
 *
 * HTTP endpoints:
 *   GET  /api/health                    - Health check
 *   GET  /api/sessions                  - List sessions
 *   POST /api/sessions                  - Create session
 *   GET  /api/sessions/:id              - Get session
 *   PATCH /api/sessions/:id             - Rename session
 *   POST  /api/sessions/:id/branch      - Truncate and branch a session
 *   DELETE /api/sessions/:id            - Delete session
 *   POST /api/sessions/:id/messages     - Send message (SSE streaming AgentEvent)
 *   POST /api/upload/file               - Upload file (proxied to LLM provider)
 *   POST /api/files/read-pdf            - Extract PDF text locally
 *   POST /api/files/read-local          - Resolve an explicitly supplied local media path
 *   GET  /api/tools                     - List builtin tool definitions
 *   GET  /api/workspace/tree             - List safe workspace entries
 *   GET  /api/workspace/file             - Read a safe text workspace file
 *   GET  /api/workspace/git              - Read-only Git status and diff snapshot
 *
 * WebSocket:
 *   ws://host:port/ws - Bidirectional channel for chat (AgentEvent stream + 工具确认)
 */

import http from "node:http";
import fs from "node:fs";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  Agent,
  SessionStore,
  BUILTIN_TOOLS,
  FileSessionRepository,
  PromptStore,
  MemoryStore,
  SkillStore,
  ChromeCdpController,
  WindowsComputerUseController,
  loadRuntimeConfig,
  resolveInWorkspace,
  type BuiltinTool,
  type ConfirmFn,
  type ToolServices,
  type SubagentRequest,
  type SubagentResult,
  type ToolServiceContext,
} from "@yoomclaw/agent-core";
import {
  ImageHostClient,
  dataUrlMimeType,
  isHostableDataUrl,
  JimoProvider,
  type ImageHostConfig,
} from "@yoomclaw/llm-provider";
import {
  isPdfDataUrl,
  LocalPdfReader,
  LOCAL_PDF_MAX_BYTES,
} from "./pdf-reader.js";
import {
  classifyFileInput,
  countAttachmentParts,
  countImageAttachmentParts,
  FILE_INPUT_RULES,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
} from "@yoomclaw/protocol";
import type {
  ChatMessage,
  SessionSummary,
  GatewayMessage,
  FileUploadRequest,
  FileUploadResponse,
  LocalFileReadResponse,
  PdfReadResponse,
  FileInputDescriptor,
  AgentEvent,
  RuntimeConfig,
  SafetyMode,
  SessionRunStatus,
  ToolsetId,
} from "@yoomclaw/protocol";
import type { AgentConfig } from "@yoomclaw/protocol";
import { AttachmentStore, createDocumentService, createHttpMcpService } from "./advanced-services.js";

// ===== Gateway Config =====

export interface GatewayConfig {
  host: string;
  port: number;
  agentConfig: AgentConfig;
  jimoConfig: {
    baseUrl: string;
    shareId: string;
    authorization: string;
  };
  /** 工具读写的工作目录（沙箱根）。 */
  workspace: string;
  /** 会话持久化目录（可选）。 */
  dataDir?: string;
  /** Static file directory for the desktop renderer UI (optional). */
  staticDir?: string;
  /** Hermes-style runtime overrides. */
  runtime?: Partial<RuntimeConfig>;
  /** Existing self-hosted image host used to expose local images as HTTPS URLs. */
  imageHostConfig?: ImageHostConfig;
}

// ===== Gateway Server =====

interface PendingConfirm {
  ws: WebSocket;
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
}

interface ActiveRun {
  ws: WebSocket;
  sessionId: string;
  controller: AbortController;
}

function normalizeSafetyMode(value: unknown): SafetyMode | undefined {
  if (value === "confirm") return "confirm";
  if (value === "workspace-auto" || value === "no-confirm") return "workspace-auto";
  if (value === "full-access") return "full-access";
  return undefined;
}

export class Gateway {
  private httpServer: http.Server;
  private wsServer: WebSocketServer;
  private sessions: SessionStore;
  private tools: BuiltinTool[];
  private agent: Agent;
  private config: GatewayConfig;
  private runtime: RuntimeConfig;
  private promptStore: PromptStore;
  private memoryStore: MemoryStore;
  private skillStore: SkillStore;
  private browser: ChromeCdpController;
  private computer: WindowsComputerUseController;
  private imageHost?: ImageHostClient;
  private pdfReader: LocalPdfReader;
  private attachments: AttachmentStore;
  private activeSubagents = 0;
  /** callId → 等待用户确认的裁决。 */
  private pendingConfirm = new Map<string, PendingConfirm>();
  /** 兼容旧客户端的确认模式消息；旧的 no-confirm 会归一化为 workspace-auto。 */
  private confirmModes = new Map<WebSocket, SafetyMode>();
  private activeRuns = new Map<string, ActiveRun>();

  private abortRunsForSession(sessionId: string): void {
    for (const [runId, active] of this.activeRuns) {
      if (active.sessionId !== sessionId) continue;
      active.controller.abort();
      this.activeRuns.delete(runId);
    }
  }

  private async runSubagent(
    request: SubagentRequest,
    context: ToolServiceContext,
  ): Promise<SubagentResult> {
    if (this.activeSubagents >= 2) {
      return {
        taskId: randomUUID(),
        status: "failed",
        summary: "当前最多同时运行 2 个子 Agent，请稍后重试。",
      };
    }
    const parent = this.sessions.get(context.sessionId);
    const depth = typeof parent?.meta?.subagentDepth === "number" ? parent.meta.subagentDepth : 0;
    if (depth >= 2) {
      return {
        taskId: randomUUID(),
        status: "failed",
        summary: "已达到子 Agent 最大嵌套深度。",
      };
    }
    // In confirm mode a child would need an additional UI event channel. Do not
    // silently downgrade the permission mode; ask the parent to retry in a mode
    // that can execute inherited safe/workspace operations automatically.
    if (context.safetyMode === "confirm") {
      return {
        taskId: randomUUID(),
        status: "failed",
        summary: "子 Agent 在‘请求批准’模式下需要独立确认通道，请切换到工作区自动或完全访问权限。",
      };
    }
    this.activeSubagents += 1;
    const child = this.sessions.create(`子 Agent：${request.task.slice(0, 60)}`);
    const childDepth = depth + 1;
    this.sessions.setFlags(child.id, { archived: true });
    this.sessions.setMeta(child.id, {
      parentSessionId: context.sessionId,
      subagentDepth: childDepth,
    });
    let finalText = "";
    const errors: string[] = [];
    const supportedToolsets: ToolsetId[] = [
      "coding", "memory", "skills", "browser", "planning", "web",
      "execution", "orchestration", "mcp", "computer",
    ];
    const inheritedToolsets = this.agent.config.toolsets ?? this.runtime.toolsets;
    const requestedToolsets = request.toolsets?.filter(
      (value): value is ToolsetId => supportedToolsets.includes(value as ToolsetId),
    );
    const childToolsets = (requestedToolsets && requestedToolsets.length > 0
      ? requestedToolsets
      : inheritedToolsets
    ).filter((value) => inheritedToolsets.includes(value));
    try {
      for await (const event of this.agent.run(child.id, request.task, {
        signal: context.signal,
        safetyMode: context.safetyMode,
        toolsets: childToolsets,
        runId: randomUUID(),
      })) {
        if (event.type === "final") finalText = event.text;
        if (event.type === "error") errors.push(event.message);
      }
      if (context.signal?.aborted) {
        return { taskId: child.id, status: "cancelled", summary: "子 Agent 已取消。" };
      }
      if (errors.length > 0) {
        return { taskId: child.id, status: "failed", summary: errors.join("\n") };
      }
      const files = [...finalText.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\.\.?[\\/])[^\s`"']+)/g)]
        .map((match) => match[1])
        .slice(0, 50);
      return { taskId: child.id, status: "completed", summary: finalText || "子 Agent 已完成但没有返回文本。", files };
    } catch (error) {
      return {
        taskId: child.id,
        status: context.signal?.aborted ? "cancelled" : "failed",
        summary: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeSubagents = Math.max(0, this.activeSubagents - 1);
    }
  }

  constructor(config: GatewayConfig) {
    this.config = config;
    this.runtime = loadRuntimeConfig(process.env, {
      ...config.runtime,
      workspace: config.runtime?.workspace ?? config.workspace,
      dataDir:
        config.runtime?.dataDir ??
        config.dataDir ??
        pathModule.join(config.workspace, ".claw-data"),
    });
    this.promptStore = new PromptStore(this.runtime.workspace, this.runtime.dataDir);
    this.memoryStore = new MemoryStore(this.runtime.workspace, this.runtime.dataDir);
    this.skillStore = new SkillStore(this.runtime.workspace, this.runtime.dataDir);
    this.browser = new ChromeCdpController(this.runtime.dataDir, this.runtime.browserCdpUrl);
    this.computer = new WindowsComputerUseController(this.runtime.dataDir, {
      enabled: this.runtime.computerEnabled,
    });
    this.sessions = new SessionStore(
      new FileSessionRepository(this.runtime.dataDir, this.runtime.workspace),
      this.runtime.workspace,
    );
    this.tools = BUILTIN_TOOLS;
    this.attachments = new AttachmentStore();

    const provider = new JimoProvider(config.jimoConfig);
    const imageHostConfig = config.imageHostConfig ?? readImageHostConfig(process.env);
    this.imageHost = imageHostConfig
      ? new ImageHostClient(imageHostConfig)
      : undefined;
    this.pdfReader = new LocalPdfReader();
    this.persistRuntimeConfig();
    const services: ToolServices = {
      planStore: {
        get: (sessionId) => {
          const plan = this.sessions.get(sessionId)?.meta?.plan;
          return plan && typeof plan === "object" ? plan as import("@yoomclaw/protocol").PlanState : undefined;
        },
        set: (sessionId, plan) => {
          this.sessions.setMeta(sessionId, { plan });
        },
      },
      documents: createDocumentService(this.pdfReader, this.attachments),
      subagents: {
        delegate: (request, context) => this.runSubagent(request, context),
      },
      mcp: createHttpMcpService(),
    };
    this.agent = new Agent(
      {
        ...config.agentConfig,
        mode: config.agentConfig.mode ?? this.runtime.mode,
        promptMode: config.agentConfig.promptMode ?? this.runtime.promptMode,
        autoMemoryReview: config.agentConfig.autoMemoryReview ?? this.runtime.autoMemoryReview,
        toolsets: config.agentConfig.toolsets ?? this.runtime.toolsets,
        safetyMode: config.agentConfig.safetyMode ?? this.runtime.safetyMode,
      },
      provider,
      this.sessions,
      this.tools,
      this.runtime.workspace,
      {
        dataDir: this.runtime.dataDir,
        promptStore: this.promptStore,
        memoryStore: this.memoryStore,
        skillStore: this.skillStore,
        browser: this.browser,
        computer: this.computer,
        services,
      },
    );

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      path: "/ws",
    });
    this.wsServer.on("connection", (ws) => this.handleWs(ws));
  }

  start(): void {
    this.httpServer.listen(this.config.port, this.config.host, () => {
      console.log(`YoomClaw Gateway listening on http://${this.config.host}:${this.config.port}`);
      console.log(`   WebSocket: ws://${this.config.host}:${this.config.port}/ws`);
      console.log(`   Client UI: http://${this.config.host}:${this.config.port}/`);
    });
  }

  async stop(): Promise<void> {
    for (const active of this.activeRuns.values()) active.controller.abort();
    for (const pending of this.pendingConfirm.values()) pending.reject(new Error("Gateway stopped"));
    this.pendingConfirm.clear();
    await this.computer.close();
    return new Promise((resolve) => {
      this.wsServer.close();
      this.httpServer.close(() => resolve());
    });
  }

  // ===== HTTP =====

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;

      if (path === "/api/health" && req.method === "GET") {
        return this.sendJson(res, 200, { status: "ok", uptime: process.uptime() });
      }

      if (path === "/api/config" && req.method === "GET") {
        return this.sendJson(res, 200, this.publicConfig());
      }

      if (path === "/api/config" && req.method === "PATCH") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        this.updateRuntimeConfig(body);
        return this.sendJson(res, 200, this.publicConfig());
      }

      const promptMatch = path.match(/^\/api\/config\/prompts\/(global|user|project)$/);
      if (promptMatch) {
        const target = promptMatch[1];
        if (req.method === "GET") {
          return this.sendJson(res, 200, { target, content: this.readPrompt(target) });
        }
        if (req.method === "PUT") {
          const body = (await readJsonBody(req)) as { content?: string };
          if (typeof body.content !== "string") {
            return this.sendJson(res, 400, { error: "content is required" });
          }
          this.writePrompt(target, body.content);
          return this.sendJson(res, 200, { target, content: this.readPrompt(target) });
        }
      }

      if (path === "/api/memory" && req.method === "GET") {
        return this.sendJson(res, 200, {
          memory: this.memoryStore.read("memory"),
          user: this.memoryStore.read("user"),
        });
      }

      const memoryMatch = path.match(/^\/api\/memory\/(memory|user)$/);
      if (memoryMatch) {
        const store = memoryMatch[1] as "memory" | "user";
        if (req.method === "PUT") {
          const body = (await readJsonBody(req)) as { content?: string };
          if (typeof body.content !== "string") return this.sendJson(res, 400, { error: "content is required" });
          this.memoryStore.replace(store, body.content);
          return this.sendJson(res, 200, { store, content: this.memoryStore.read(store) });
        }
        if (req.method === "DELETE") {
          this.memoryStore.replace(store, "");
          return this.sendJson(res, 200, { store, content: "" });
        }
      }

      if (path === "/api/skills" && req.method === "GET") {
        return this.sendJson(res, 200, this.skillStore.list(true));
      }

      const skillMatch = path.match(/^\/api\/skills\/([^/]+)(?:\/(apply|reject))?$/);
      if (skillMatch) {
        const skillId = decodeURIComponent(skillMatch[1]);
        const action = skillMatch[2];
        if (req.method === "GET" && !action) {
          const skill = this.skillStore.get(skillId, true);
          return skill
            ? this.sendJson(res, 200, skill)
            : this.sendJson(res, 404, { error: "Skill not found" });
        }
        if (req.method === "POST" && action === "apply") {
          return this.sendJson(res, 200, this.skillStore.apply(skillId));
        }
        if (req.method === "POST" && action === "reject") {
          return this.sendJson(res, 200, { deleted: this.skillStore.reject(skillId) });
        }
      }

      if (path === "/api/browser/status" && req.method === "GET") {
        return this.sendJson(res, 200, this.browser.status());
      }
      if (path === "/api/browser/connect" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { cdpUrl?: string };
        await this.browser.connect(body.cdpUrl ?? this.runtime.browserCdpUrl);
        return this.sendJson(res, 200, this.browser.status());
      }
      if (path === "/api/browser/disconnect" && req.method === "POST") {
        await this.browser.disconnect();
        return this.sendJson(res, 200, this.browser.status());
      }
      if (path === "/api/computer/status" && req.method === "GET") {
        return this.sendJson(res, 200, this.computer.status());
      }

      const runMatch = path.match(/^\/api\/runs\/([^/]+)(?:\/cancel)?$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        if (req.method === "GET") {
          const found = this.sessions.findRun(runId);
          return found
            ? this.sendJson(res, 200, found)
            : this.sendJson(res, 404, { error: "Run not found" });
        }
        if (req.method === "POST" && path.endsWith("/cancel")) {
          const active = this.activeRuns.get(runId);
          if (!active) return this.sendJson(res, 404, { error: "Run is not active" });
          active.controller.abort();
          return this.sendJson(res, 202, { runId, status: "interrupted" });
        }
      }

      if (path === "/api/sessions" && req.method === "GET") {
        return this.sendJson(res, 200, this.sessions.list());
      }

      if (path === "/api/sessions/search" && req.method === "GET") {
        return this.sendJson(res, 200, this.sessions.search(url.searchParams.get("q") ?? ""));
      }

      if (path === "/api/sessions" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { title?: string };
        const session = this.sessions.create(body?.title);
        const summary: SessionSummary = {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: 0,
          archived: session.archived === true,
          pinned: session.pinned === true,
        };
        return this.sendJson(res, 201, summary);
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const id = sessionMatch[1];
        if (req.method === "GET") {
          const session = this.sessions.get(id);
          if (!session) return this.sendJson(res, 404, { error: "Not found" });
          return this.sendJson(res, 200, session);
        }
        if (req.method === "PATCH") {
          const body = (await readJsonBody(req)) as {
            title?: unknown;
            archived?: unknown;
            pinned?: unknown;
          };
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const hasTitle = typeof body.title === "string";
          const hasArchived = typeof body.archived === "boolean";
          const hasPinned = typeof body.pinned === "boolean";
          if (!hasTitle && !hasArchived && !hasPinned) {
            return this.sendJson(res, 400, { error: "title, archived or pinned is required" });
          }
          if (hasTitle && !title) return this.sendJson(res, 400, { error: "title is required" });
          if (hasTitle && title.length > 120) {
            return this.sendJson(res, 400, { error: "title must be at most 120 characters" });
          }
          const updated = hasTitle
            ? this.sessions.rename(id, title)
            : this.sessions.get(id);
          if (!updated) return this.sendJson(res, 404, { error: "Not found" });
          const patched = hasArchived || hasPinned
            ? this.sessions.setFlags(id, {
              archived: hasArchived ? body.archived as boolean : undefined,
              pinned: hasPinned ? body.pinned as boolean : undefined,
            })
            : updated;
          if (!patched) return this.sendJson(res, 404, { error: "Not found" });
          const summary = this.sessions.list().find((item) => item.id === id);
          return this.sendJson(res, 200, summary ?? {
            id: patched.id,
            title: patched.title,
            createdAt: patched.createdAt,
            updatedAt: patched.updatedAt,
            messageCount: patched.messages.length,
            archived: patched.archived === true,
            pinned: patched.pinned === true,
          } satisfies SessionSummary);
        }
        if (req.method === "DELETE") {
          this.abortRunsForSession(id);
          const deleted = this.sessions.delete(id);
          return this.sendJson(res, deleted ? 204 : 404, deleted ? null : { error: "Not found" });
        }
      }

      const branchMatch = path.match(/^\/api\/sessions\/([^/]+)\/branch$/);
      if (branchMatch && req.method === "POST") {
        const id = branchMatch[1];
        const body = (await readJsonBody(req)) as { messageIndex?: unknown };
        const messageIndex = typeof body.messageIndex === "number" ? body.messageIndex : NaN;
        const session = this.sessions.get(id);
        if (!session) return this.sendJson(res, 404, { error: "Not found" });
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex > session.messages.length) {
          return this.sendJson(res, 400, { error: "messageIndex is out of range" });
        }
        const branched = this.sessions.truncateMessages(id, messageIndex);
        if (!branched) return this.sendJson(res, 404, { error: "Not found" });
        const summary = this.sessions.list().find((item) => item.id === id);
        return this.sendJson(res, 200, summary ?? {
          id: branched.id,
          title: branched.title,
          createdAt: branched.createdAt,
          updatedAt: branched.updatedAt,
          messageCount: branched.messages.length,
          archived: branched.archived === true,
          pinned: branched.pinned === true,
        } satisfies SessionSummary);
      }

      const msgMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgMatch && req.method === "POST") {
        return this.handleSendMessage(msgMatch[1], req, res);
      }

      if (path === "/api/upload/file" && req.method === "POST") {
        return this.handleUploadFile(req, res);
      }

      if (path === "/api/files/read-pdf" && req.method === "POST") {
        return this.handleReadPdf(req, res, url.searchParams.get("fileName"));
      }

      if (path === "/api/files/read-local" && req.method === "POST") {
        return this.handleReadLocalFile(req, res);
      }

      if (path === "/api/tools" && req.method === "GET") {
        const enabledToolsets = this.agent.config.toolsets ?? this.runtime.toolsets;
        const enabledNames = this.agent.config.enabledTools;
        return this.sendJson(res, 200, this.tools
          .filter((tool) => !enabledNames || enabledNames.includes(tool.definition.name))
          .filter((tool) => enabledToolsets.includes(tool.definition.toolset ?? "coding"))
          .map((tool) => tool.definition));
      }

      if (path === "/api/workspace/tree" && req.method === "GET") {
        const relativePath = url.searchParams.get("path") ?? ".";
        const resolved = resolveInWorkspace(this.runtime.workspace, relativePath, {
          allowOutsideWorkspace: this.runtime.safetyMode === "full-access",
        });
        if (!resolved.ok) return this.sendJson(res, 403, { error: resolved.reason, code: "WORKSPACE_PATH_BLOCKED" });
        try {
          const stat = fs.statSync(resolved.resolved);
          if (!stat.isDirectory()) return this.sendJson(res, 400, { error: "path is not a directory" });
          const entries = fs.readdirSync(resolved.resolved, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
            .slice(0, 200)
            .map((entry) => {
              const entryPath = pathModule.join(resolved.resolved, entry.name);
              let size: number | undefined;
              if (entry.isFile()) {
                try { size = fs.statSync(entryPath).size; } catch { /* best effort */ }
              }
              return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", size };
            })
            .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
          return this.sendJson(res, 200, { path: relativePath, entries });
        } catch (error) {
          return this.sendJson(res, 404, { error: error instanceof Error ? error.message : "Directory not found" });
        }
      }

      if (path === "/api/workspace/file" && req.method === "GET") {
        const relativePath = url.searchParams.get("path") ?? "";
        const resolved = resolveInWorkspace(this.runtime.workspace, relativePath, {
          allowOutsideWorkspace: this.runtime.safetyMode === "full-access",
        });
        if (!resolved.ok) return this.sendJson(res, 403, { error: resolved.reason, code: "WORKSPACE_PATH_BLOCKED" });
        try {
          const stat = fs.statSync(resolved.resolved);
          if (!stat.isFile()) return this.sendJson(res, 400, { error: "path is not a file" });
          if (stat.size > 1024 * 1024) return this.sendJson(res, 413, { error: "file is too large to preview" });
          return this.sendJson(res, 200, {
            path: relativePath,
            content: fs.readFileSync(resolved.resolved, "utf8"),
          });
        } catch (error) {
          return this.sendJson(res, 404, { error: error instanceof Error ? error.message : "File not found" });
        }
      }

      if (path === "/api/workspace/git" && req.method === "GET") {
        const resolved = resolveInWorkspace(this.runtime.workspace, ".", {
          allowOutsideWorkspace: this.runtime.safetyMode === "full-access",
        });
        if (!resolved.ok) return this.sendJson(res, 403, { error: resolved.reason, code: "WORKSPACE_PATH_BLOCKED" });
        const runGit = (args: string[]): string => execFileSync("git", args, {
          cwd: resolved.resolved,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 512 * 1024,
          windowsHide: true,
        }) as string;
        try {
          return this.sendJson(res, 200, {
            available: true,
            branch: runGit(["branch", "--show-current"]).trim(),
            status: runGit(["status", "--short"]),
            diff: runGit(["diff", "--no-ext-diff", "--unified=2"]).slice(0, 80_000),
          });
        } catch (error) {
          return this.sendJson(res, 200, {
            available: false,
            error: error instanceof Error ? error.message : "Git is not available",
            branch: "",
            status: "",
            diff: "",
          });
        }
      }

      // Static file serving (optional, for desktop renderer UI in production)
      if (this.config.staticDir && req.method === "GET") {
        return this.serveStatic(req, res, path);
      }

      return this.sendJson(res, 404, { error: "Not found", path });
    } catch (err) {
      console.error("[Gateway] HTTP error:", err);
      const status = err instanceof RequestBodyTooLargeError ? 413 : 500;
      return this.sendJson(res, status, {
        error: status === 413 ? "Request body is too large" : "Internal server error",
        code: status === 413 ? "REQUEST_BODY_TOO_LARGE" : "INTERNAL_SERVER_ERROR",
      });
    }
  }

  /** Send a message and stream AgentEvent as SSE. */
  private async handleSendMessage(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as Partial<ChatMessage>;
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "Session not found" });
    }

    if (typeof body.content !== "string" && !Array.isArray(body.content)) {
      return this.sendJson(res, 400, {
        error: "content is required",
        code: "INVALID_MESSAGE_CONTENT",
      });
    }
   const providerContent = body.agentContext ?? body.content;
    if (countImageAttachmentParts(providerContent) > MAX_IMAGES_PER_MESSAGE) {
     return this.sendJson(res, 400, {
        error: `A message may contain at most ${MAX_IMAGES_PER_MESSAGE} images`,
        code: "TOO_MANY_IMAGES",
     });
   }
    if (countAttachmentParts(providerContent) > MAX_FILES_PER_MESSAGE) {
     return this.sendJson(res, 400, {
        error: `A message may contain at most ${MAX_FILES_PER_MESSAGE} files`,
        code: "TOO_MANY_FILES",
     });
   }
    const message: ChatMessage = {
      role: body.role ?? "user",
      content: body.content,
      ...(Array.isArray(body.localPaths) ? { localPaths: body.localPaths } : {}),
      ...(body.agentContext === undefined ? {} : { agentContext: body.agentContext }),
    };

    // SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // SSE 无交互确认通道 → 不传 confirm，由 Agent 在可信环境自动放行。
    const ac = new AbortController();
    req.on("close", () => ac.abort());

    try {
      for await (const ev of this.agent.run(sessionId, message, {
        signal: ac.signal,
        safetyMode: this.runtime.safetyMode,
      })) {
        send("chat.event", { sessionId, event: ev });
      }
      send("chat.end", { sessionId });
    } catch (err) {
      send("error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      res.end();
    }
  }

  /** Proxy file upload to the LLM provider. */
  private async handleUploadFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const declaredLengthHeader = req.headers["content-length"];
    const declaredLength = declaredLengthHeader === undefined
      ? Number.NaN
      : Number(declaredLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_BYTES) {
      return this.sendJson(res, 413, {
        error: "Request body is too large",
        code: "REQUEST_BODY_TOO_LARGE",
      });
    }
    const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES) as {
      url?: string;
      source?: string;
      fileName?: string;
      mimeType?: string;
      kind?: FileUploadRequest["kind"];
      sizeBytes?: number;
    };
    if (typeof body.url !== "string" || !body.url.trim()) {
      return this.sendJson(res, 400, { error: "url is required" });
    }

    const inputUrl = body.url.trim();
    const dataMimeType = dataUrlMimeType(inputUrl);
    const inferredFileName = body.fileName?.trim() ||
      (dataMimeType ? `upload.${extensionForMimeType(dataMimeType)}` : undefined);
    const dataSizeBytes = dataUrlByteLength(inputUrl);
    if (inputUrl.startsWith("data:")) {
      if (!dataMimeType || dataSizeBytes === undefined) {
        return this.sendJson(res, 400, {
          error: "A valid base64 data URL is required",
          code: "INVALID_DATA_URL",
        });
      }
      const descriptor = classifyFileInput(
        inferredFileName ?? "upload",
        dataSizeBytes,
        body.mimeType ?? dataMimeType,
      );
      if (!descriptor.accepted) {
        return this.sendFileInputError(res, descriptor);
      }
      body.kind = descriptor.kind;
      body.sizeBytes = dataSizeBytes;
    } else if (inferredFileName && typeof body.sizeBytes === "number") {
      const descriptor = classifyFileInput(inferredFileName, body.sizeBytes, body.mimeType);
      if (!descriptor.accepted) {
        return this.sendFileInputError(res, descriptor);
      }
      body.kind = descriptor.kind;
    }

    const uploadRequest: FileUploadRequest = {
      url: inputUrl,
      source: body.source ?? "api",
      fileName: inferredFileName,
      mimeType: body.mimeType,
      kind: body.kind,
      sizeBytes: body.sizeBytes,
    };

    if (isHostableDataUrl(inputUrl)) {
      if (!this.imageHost) {
        return this.sendJson(res, 503, {
          error: "File host is not configured",
          code: "FILE_HOST_NOT_CONFIGURED",
        });
      }

      try {
        const result = await this.imageHost.upload(uploadRequest, {
          signal: AbortSignal.timeout(FILE_UPLOAD_TIMEOUT_MS),
        });
        this.attachments.remember(result.fileId, inputUrl, inferredFileName, body.mimeType ?? dataMimeType);
        return this.sendJson(res, 200, result);
      } catch (err) {
        console.error(
          "[Gateway] file host upload failed:",
          err instanceof Error ? err.message : String(err),
        );
        return this.sendJson(res, 502, {
          error: "File host upload failed",
          code: "FILE_HOST_UPLOAD_FAILED",
        });
      }
    }

    try {
      const provider = new JimoProvider(this.config.jimoConfig);
      const result: FileUploadResponse = await provider.uploadFile(uploadRequest, {
        signal: AbortSignal.timeout(FILE_UPLOAD_TIMEOUT_MS),
      });
      this.attachments.remember(result.fileId, inputUrl, inferredFileName, body.mimeType ?? dataMimeType);
      return this.sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const providerRejectedForSize = /(?:upload error|HTTP)\s*413\b|413\s+Request Entity Too Large/i.test(message);
      console.error(
        "[Gateway] provider file upload failed:",
        message,
      );
      return this.sendJson(res, providerRejectedForSize ? 413 : 502, {
        error: providerRejectedForSize
          ? "Provider rejected the file because its upstream request limit was exceeded"
          : "Provider file upload failed",
        code: providerRejectedForSize
          ? "PROVIDER_FILE_TOO_LARGE"
          : "PROVIDER_FILE_UPLOAD_FAILED",
      });
    }
  }

  /** Extract text from a PDF locally; the PDF bytes never leave the Gateway. */
  private async handleReadPdf(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    queryFileName?: string | null,
  ): Promise<void> {
    const contentType = String(req.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    let pdfBytes: Buffer | undefined;
    let pdfDataUrl: string | undefined;
    let fileName = queryFileName?.trim() || "document.pdf";

    if (contentType === "application/pdf" || contentType === "application/octet-stream") {
      pdfBytes = await readRawBody(req, LOCAL_PDF_MAX_BYTES);
      if (pdfBytes.length === 0) {
        return this.sendJson(res, 400, { error: "PDF content is empty" });
      }
    } else {
      const body = await readJsonBody(req, MAX_PDF_JSON_BODY_BYTES) as {
        url?: string;
        fileName?: string;
      };
      if (typeof body.url !== "string" || !body.url.trim()) {
        return this.sendJson(res, 400, { error: "url is required" });
      }
      if (!isPdfDataUrl(body.url)) {
        return this.sendJson(res, 415, {
          error: "A base64 PDF data URL is required",
          code: "PDF_DATA_URL_REQUIRED",
        });
      }
      pdfDataUrl = body.url;
      fileName = body.fileName?.trim() || fileName;
    }

    try {
      const result = pdfBytes
        ? await this.pdfReader.readBytes(pdfBytes, {
            signal: AbortSignal.timeout(PDF_READ_TIMEOUT_MS),
          })
        : await this.pdfReader.read(pdfDataUrl!, {
            signal: AbortSignal.timeout(PDF_READ_TIMEOUT_MS),
          });
      const response: PdfReadResponse = {
        ok: true,
        fileName,
        ...result,
      };
      return this.sendJson(res, 200, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Gateway] local PDF parsing failed:", message);
      const timedOut = /timed out/i.test(message);
      return this.sendJson(res, timedOut ? 504 : 422, {
        error: timedOut ? "Local PDF parsing timed out" : "Local PDF parsing failed",
        code: timedOut ? "PDF_PARSE_TIMEOUT" : "PDF_PARSE_FAILED",
        message,
      });
    }
  }

  /** Resolve an explicitly supplied local media path under the current safety mode. */
  private async handleReadLocalFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req) as { path?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return this.sendJson(res, 400, {
        error: "path is required",
        code: "LOCAL_FILE_PATH_REQUIRED",
      });
    }

    const requestedPath = normalizeLocalFilePath(body.path);
    const resolved = resolveInWorkspace(this.runtime.workspace, requestedPath, {
      allowOutsideWorkspace: this.runtime.safetyMode === "full-access",
    });
    if (!resolved.ok) {
      return this.sendJson(res, 403, {
        error: resolved.reason,
        code: "LOCAL_FILE_BLOCKED",
      });
    }

    try {
      const stat = await fs.promises.stat(resolved.resolved);
      if (!stat.isFile()) {
        return this.sendJson(res, 400, {
          error: "path is not a file",
          code: "LOCAL_FILE_NOT_A_FILE",
        });
      }

      const fileName = pathModule.basename(resolved.resolved);
      const mimeType = mimeTypeForExtension(pathModule.extname(fileName));
      const descriptor = classifyFileInput(fileName, stat.size, mimeType);
      if (!descriptor.accepted || !descriptor.kind) {
        return this.sendFileInputError(res, descriptor);
      }

      // Text paths are promoted only for the document/image flows currently
      // understood by the client. Audio/video still require an explicit file
      // attachment so a large binary is never read merely because it appears
      // in prose.
      if (descriptor.kind !== "image" && descriptor.kind !== "document") {
        return this.sendJson(res, 415, {
          error: "Only image and document paths can be attached from text",
          code: "LOCAL_MEDIA_KIND_UNSUPPORTED",
          fileName,
          kind: descriptor.kind,
        });
      }

      const bytes = await fs.promises.readFile(resolved.resolved);
      const response: LocalFileReadResponse = {
        ok: true,
        fileName,
        extension: descriptor.extension,
        mimeType,
        kind: descriptor.kind,
        sizeBytes: bytes.length,
        dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      };
      return this.sendJson(res, 200, response);
    } catch (error) {
      return this.sendJson(res, 404, {
        error: error instanceof Error ? error.message : "Local file is not readable",
        code: "LOCAL_FILE_READ_FAILED",
      });
    }
  }

  // ===== WebSocket =====

  private handleWs(ws: WebSocket): void {
    console.log("[Gateway] WebSocket client connected");

    ws.on("message", async (data: Buffer) => {
      let msg: GatewayMessage;
      try {
        msg = JSON.parse(data.toString()) as GatewayMessage;
      } catch {
        return ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }

      try {
        await this.handleWsMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    });

    ws.on("close", () => {
      console.log("[Gateway] WebSocket client disconnected");
      // 连接关闭时，拒绝该连接上仍在等待确认的工具调用，避免 Agent 挂死
      for (const [id, p] of this.pendingConfirm) {
        if (p.ws === ws) {
          this.pendingConfirm.delete(id);
          p.reject(new Error("连接已关闭"));
        }
      }
      for (const [runId, active] of this.activeRuns) {
        if (active.ws === ws) {
          active.controller.abort();
          this.activeRuns.delete(runId);
        }
      }
      this.confirmModes.delete(ws);
    });
  }

  private async handleWsMessage(ws: WebSocket, msg: GatewayMessage): Promise<void> {
    switch (msg.type) {
      case "session.list": {
        ws.send(JSON.stringify({
          type: "session.list.result",
          sessions: this.sessions.list(),
        } satisfies GatewayMessage));
        break;
      }
      case "session.create": {
        const session = this.sessions.create(msg.title);
        ws.send(JSON.stringify({
          type: "session.create.result",
          session: {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: 0,
          },
        } satisfies GatewayMessage));
        break;
      }
      case "session.get": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
          return;
        }
        ws.send(JSON.stringify({ type: "session.get.result", session }));
        break;
      }
      case "session.delete": {
        this.abortRunsForSession(msg.sessionId);
        this.sessions.delete(msg.sessionId);
        break;
      }
      case "tool.decision": {
        // 用户在前端点了「允许/拒绝」
        const pend = this.pendingConfirm.get(msg.decision.callId);
        if (pend) {
          this.pendingConfirm.delete(msg.decision.callId);
          pend.resolve(msg.decision.approved);
        }
        break;
      }
      case "setConfirmMode": {
        const mode: SafetyMode = normalizeSafetyMode(msg.mode) ?? "confirm";
        this.confirmModes.set(ws, mode);
        ws.send(
          JSON.stringify({
            type: "confirmMode.ack",
            mode,
          }),
        );
        break;
      }
      case "chat": {
        await this.handleWsChat(ws, msg.sessionId, msg.message, generateId(), msg.safetyMode);
        return;
        break;
      }
      case "chat.start": {
        await this.handleWsChat(ws, msg.sessionId, msg.message, msg.runId, msg.safetyMode);
        break;
      }
      case "chat.cancel": {
        const active = this.activeRuns.get(msg.runId);
        if (active && active.sessionId === msg.sessionId) {
          active.controller.abort();
        }
        break;
      }
      default: {
        ws.send(JSON.stringify({
          type: "error",
          message: `Unknown message type: ${(msg as { type: string }).type}`,
        }));
      }
    }
  }

  private async handleWsChat(
    ws: WebSocket,
    sessionId: string,
    message: ChatMessage,
    runId: string,
    requestedSafetyMode?: SafetyMode,
  ): Promise<void> {
   const visibleAttachmentCount = countAttachmentParts(message.content);
   const providerAttachmentCount = countAttachmentParts(message.agentContext);
    const visibleImageCount = countImageAttachmentParts(message.content);
    const providerImageCount = countImageAttachmentParts(message.agentContext);
    if (Math.max(visibleImageCount, providerImageCount) > MAX_IMAGES_PER_MESSAGE) {
     ws.send(JSON.stringify({
        type: "error",
        code: "TOO_MANY_IMAGES",
        message: `A message may contain at most ${MAX_IMAGES_PER_MESSAGE} images`,
       runId,
     }));
     return;
   }
    if (Math.max(visibleAttachmentCount, providerAttachmentCount) > MAX_FILES_PER_MESSAGE) {
     ws.send(JSON.stringify({
       type: "error",
        code: "TOO_MANY_FILES",
        message: `A message may contain at most ${MAX_FILES_PER_MESSAGE} files`,
       runId,
     }));
     return;
   }
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
      return;
    }

    const existing = [...this.activeRuns.values()].find((run) => run.sessionId === sessionId);
    if (existing || this.activeRuns.has(runId)) {
      ws.send(JSON.stringify({
        type: "error",
        code: "RUN_ACTIVE",
        message: "This session already has an active run",
        runId,
      }));
      return;
    }

    const controller = new AbortController();
    const safetyMode = normalizeSafetyMode(requestedSafetyMode)
      ?? this.confirmModes.get(ws)
      ?? this.runtime.safetyMode;
    const onClose = () => controller.abort();
    this.activeRuns.set(runId, { ws, sessionId, controller });
    ws.once("close", onClose);

    const confirm: ConfirmFn = (request) => {
      if (controller.signal.aborted) {
        return Promise.reject(new Error("Run cancelled"));
      }
      return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const onAbort = () => settle(() => reject(new Error("Run cancelled")));
        const cleanup = () => {
          controller.signal.removeEventListener("abort", onAbort);
          this.pendingConfirm.delete(request.callId);
        };
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        this.pendingConfirm.set(request.callId, {
          ws,
          resolve: (approved) => settle(() => resolve(approved)),
          reject: (error) => settle(() => reject(error)),
        });
      });
    };

    let status: SessionRunStatus = "completed";
    let thrownError: string | undefined;
    try {
      for await (const event of this.agent.run(sessionId, message, {
        signal: controller.signal,
        confirm,
        safetyMode,
        runId,
      })) {
        if (event.type === "run" && event.status !== "running") {
          status = event.status;
        } else if (event.type === "error") {
          status = controller.signal.aborted ? "interrupted" : "failed";
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "chat.event",
            sessionId,
            runId,
            event,
          } satisfies GatewayMessage));
        }
      }
    } catch (err) {
      status = controller.signal.aborted ? "interrupted" : "failed";
      thrownError = err instanceof Error ? err.message : String(err);
    } finally {
      if (thrownError && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          code: status === "interrupted" ? "RUN_INTERRUPTED" : "RUN_FAILED",
          message: thrownError,
          runId,
        }));
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "chat.end",
          sessionId,
          runId,
          status,
        } satisfies GatewayMessage));
      }
      ws.off("close", onClose);
      this.activeRuns.delete(runId);
    }
  }

  // ===== Session 持久化 =====

  private publicConfig(): Record<string, unknown> {
    return {
      agent: {
        id: "main",
        provider: this.config.agentConfig.provider,
        model: this.config.agentConfig.model,
      },
      mode: this.runtime.mode,
      promptMode: this.runtime.promptMode,
      autoMemoryReview: this.runtime.autoMemoryReview,
      workspace: this.runtime.workspace,
      dataDir: this.runtime.dataDir,
      toolsets: this.runtime.toolsets,
      safetyMode: this.runtime.safetyMode,
      browserCdpUrl: this.runtime.browserCdpUrl,
      computerEnabled: this.runtime.computerEnabled,
      browser: this.browser.status(),
      computer: this.computer.status(),
      imageHostConfigured: Boolean(this.imageHost),
      searchConfigured: Boolean(process.env.YOOMCLAW_SEARCH_URL),
      mcpConfigured: Boolean(process.env.YOOMCLAW_MCP_URL),
      prompts: {
        global: this.promptStore.readGlobalPrompt(),
        user: this.promptStore.readUserProfile(),
        project: this.promptStore.readProjectPrompt(),
      },
    };
  }

  private updateRuntimeConfig(patch: Record<string, unknown>): void {
    if (patch.mode === "legacy" || patch.mode === "hermes") {
      this.runtime.mode = patch.mode;
      this.config.agentConfig.mode = patch.mode;
      this.agent.config.mode = patch.mode;
    }
    if (patch.promptMode === "provider" || patch.promptMode === "local") {
      this.runtime.promptMode = patch.promptMode;
      this.config.agentConfig.promptMode = patch.promptMode;
      this.agent.config.promptMode = patch.promptMode;
    }
    if (typeof patch.autoMemoryReview === "boolean") {
      this.runtime.autoMemoryReview = patch.autoMemoryReview;
      this.config.agentConfig.autoMemoryReview = patch.autoMemoryReview;
      this.agent.config.autoMemoryReview = patch.autoMemoryReview;
    }
    if (Array.isArray(patch.toolsets)) {
      this.runtime.toolsets = patch.toolsets.filter((value): value is RuntimeConfig["toolsets"][number] =>
        ["coding", "memory", "skills", "browser", "planning", "web", "execution", "orchestration", "mcp", "computer"].includes(String(value)),
      );
      this.config.agentConfig.toolsets = this.runtime.toolsets;
      this.agent.config.toolsets = this.runtime.toolsets;
    }
    if (patch.safetyMode === "confirm" || patch.safetyMode === "workspace-auto" || patch.safetyMode === "full-access") {
      this.runtime.safetyMode = patch.safetyMode;
      this.config.agentConfig.safetyMode = patch.safetyMode;
      this.agent.config.safetyMode = patch.safetyMode;
    }
    if (typeof patch.browserCdpUrl === "string" && patch.browserCdpUrl.trim()) {
      this.runtime.browserCdpUrl = patch.browserCdpUrl.trim();
    }
    if (typeof patch.computerEnabled === "boolean") {
      this.runtime.computerEnabled = patch.computerEnabled;
      this.computer.setEnabled(patch.computerEnabled);
      if (patch.computerEnabled && !this.runtime.toolsets.includes("computer")) {
        this.runtime.toolsets = [...this.runtime.toolsets, "computer"];
        this.config.agentConfig.toolsets = this.runtime.toolsets;
        this.agent.config.toolsets = this.runtime.toolsets;
      }
    }
    this.persistRuntimeConfig();
  }

  private readPrompt(target: string): string {
    if (target === "global") return this.promptStore.readGlobalPrompt();
    if (target === "user") return this.promptStore.readUserProfile();
    return this.promptStore.readProjectPrompt();
  }

  private writePrompt(target: string, content: string): void {
    if (target === "global") this.promptStore.writeGlobalPrompt(content);
    else if (target === "user") this.promptStore.writeUserProfile(content);
    else this.promptStore.writeProjectPrompt(content);
  }

  private persistRuntimeConfig(): void {
    try {
      const file = pathModule.join(this.runtime.dataDir, "config.json");
      fs.mkdirSync(pathModule.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        mode: this.runtime.mode,
        promptMode: this.runtime.promptMode,
        autoMemoryReview: this.runtime.autoMemoryReview,
        workspace: this.runtime.workspace,
        toolsets: this.runtime.toolsets,
        safetyMode: this.runtime.safetyMode,
        browserCdpUrl: this.runtime.browserCdpUrl,
        computerEnabled: this.runtime.computerEnabled,
      }, null, 2), "utf8");
    } catch (err) {
      console.error("[Gateway] 配置保存失败:", err);
    }
  }

  // ===== Static Files (basic) =====

  private serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): void {
    this.sendJson(res, 404, { error: "Static file not configured", path });
  }

  // ===== Helpers =====

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = data === null ? "" : JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }

  private sendFileInputError(
    res: http.ServerResponse,
    descriptor: FileInputDescriptor,
  ): void {
    const status = descriptor.rejectionCode === "FILE_TOO_LARGE" ? 413 : 415;
    this.sendJson(res, status, {
      error: descriptor.rejectionCode,
      code: descriptor.rejectionCode,
      fileName: descriptor.fileName,
      extension: descriptor.extension,
      sizeBytes: descriptor.sizeBytes,
      maxBytes: descriptor.maxBytes,
    });
  }
}

// ===== Helpers =====

/** 从 ChatMessage.content 里抽取纯文本（支持多模态数组）。 */
function generateId(): string {
  return randomUUID();
}

function readImageHostConfig(env: NodeJS.ProcessEnv): ImageHostConfig | undefined {
  const uploadUrl = (
    env.IMAGE_HOST_UPLOAD_URL ??
    "https://yunbloom.cn/img/api/upload"
  ).trim();
  let uploadToken = env.IMAGE_HOST_UPLOAD_TOKEN?.trim() ?? "";
  const tokenFile = env.IMAGE_HOST_UPLOAD_TOKEN_FILE?.trim();

  if (!uploadToken && tokenFile) {
    try {
      uploadToken = fs.readFileSync(tokenFile, "utf8").trim();
    } catch (err) {
      console.warn(
        "[Gateway] image host token file is not readable:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!uploadUrl || !uploadToken) return undefined;
  return { uploadUrl, uploadToken };
}

function textOf(content: string | ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

/** 请求体大小上限，防止内存被打满。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Data URLs expand by roughly 4/3; reserve room for JSON metadata. */
const MAX_UPLOAD_BODY_BYTES = Math.ceil(FILE_INPUT_RULES.video.maxBytes * 4 / 3) + 2_000_000;
const MAX_PDF_JSON_BODY_BYTES = Math.ceil(FILE_INPUT_RULES.document.maxBytes * 4 / 3) + 1_000_000;
const FILE_UPLOAD_TIMEOUT_MS = 90 * 1000;
const PDF_READ_TIMEOUT_MS = 90 * 1000;

class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super("Request body exceeds " + maxBytes + " bytes");
    this.name = "RequestBodyTooLargeError";
  }
}

function dataUrlByteLength(value: string): number | undefined {
  const match = /^data:[^;,]+;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match) return undefined;
  const encoded = match[1].replace(/\s+/g, "");
  // An empty file is still a valid base64 data URL. The shared upload policy
  // permits size 0, so let the provider decide whether an empty payload is
  // meaningful instead of turning it into a gateway-level 400.
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return undefined;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  const known: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "text/html": "html",
    "text/csv": "csv",
    "application/json": "json",
    "application/xml": "xml",
    "text/markdown": "md",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
  };
  return known[normalized] ?? "bin";
}

function mimeTypeForExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  const known: Record<string, string> = {
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    html: "text/html",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    md: "text/markdown",
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    webp: "image/webp",
  };
  return known[normalized] ?? "application/octet-stream";
}

function normalizeLocalFilePath(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!/^file:/i.test(trimmed)) return trimmed;
  try {
    return fileURLToPath(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 必须先 Buffer.concat 再整体解码：多字节 UTF-8 字符（如中文占 3 字节）
 * 可能跨 TCP 包边界被切开，逐 chunk 隐式 toString 会把两半各自解成 U+FFFD。
 */
function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new RequestBodyTooLargeError(maxBytes));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);

    req.on("end", () => {
      if (aborted) return;
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("Request aborted")));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

// ===== Entry Point =====

export function startGateway(config?: Partial<GatewayConfig>): Gateway {
  const env = process.env;
  const finalConfig: GatewayConfig = {
    host: config?.host ?? env.GATEWAY_HOST ?? "127.0.0.1",
    port: config?.port ?? Number(env.GATEWAY_PORT ?? 18789),
    workspace: config?.workspace ?? env.YOOMCLAW_WORKSPACE ?? env.CLAW_WORKSPACE ?? process.cwd(),
    agentConfig: config?.agentConfig ?? {
      provider: "jimo",
      model: env.DEFAULT_MODEL ?? "gpt-5.6-luna",
    },
    jimoConfig: config?.jimoConfig ?? {
      baseUrl: env.JIMO_API_BASE_URL ?? "https://jimoai-bot-api.xiaohuodui.cn",
      shareId: env.JIMO_SHARE_ID ?? "",
      authorization: env.JIMO_AUTHORIZATION ?? "",
    },
    dataDir: config?.dataDir ?? env.YOOMCLAW_DATA_DIR,
    staticDir: config?.staticDir,
    runtime: config?.runtime,
    imageHostConfig: config?.imageHostConfig ?? readImageHostConfig(env),
  };

  const gateway = new Gateway(finalConfig);
  gateway.start();
  return gateway;
}

// 注意：本文件是库，不再自执行。启动请用 ./bin.ts。
