/**
 * @yoomclaw/gateway - HTTP + WebSocket Gateway
 *
 * HTTP endpoints:
 *   GET  /api/health                    - Health check
 *   GET  /api/sessions                  - List sessions
 *   POST /api/sessions                  - Create session
 *   GET  /api/sessions/:id              - Get session
 *   DELETE /api/sessions/:id            - Delete session
 *   POST /api/sessions/:id/messages     - Send message (SSE streaming AgentEvent)
 *   POST /api/upload/file               - Upload file (proxied to LLM provider)
 *   GET  /api/tools                     - List builtin tool definitions
 *
 * WebSocket:
 *   ws://host:port/ws - Bidirectional channel for chat (AgentEvent stream + 工具确认)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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
  loadRuntimeConfig,
  type BuiltinTool,
  type ConfirmFn,
} from "@yoomclaw/agent-core";
import { JimoProvider, JimoVisionProvider } from "@yoomclaw/llm-provider";
import type {
  ChatMessage,
  SessionSummary,
  GatewayMessage,
  FileUploadResponse,
  AgentEvent,
  RuntimeConfig,
  SessionRunStatus,
} from "@yoomclaw/protocol";
import type { AgentConfig } from "@yoomclaw/protocol";

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
  /** Optional second Jimo robot used for image/OCR preprocessing. */
  visionConfig?: {
    baseUrl: string;
    shareId: string;
    authorization: string;
  };
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
  /** callId → 等待用户确认的裁决。 */
  private pendingConfirm = new Map<string, PendingConfirm>();
  /** 兼容旧客户端的确认模式状态；高风险确认不会被该开关绕过。 */
  private confirmModes = new Map<WebSocket, "confirm" | "no-confirm">();
  private activeRuns = new Map<string, ActiveRun>();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.runtime = loadRuntimeConfig(process.env, {
      ...config.runtime,
      workspace: config.runtime?.workspace ?? config.workspace,
      dataDir:
        config.runtime?.dataDir ??
        config.dataDir ??
        path.join(config.workspace, ".claw-data"),
    });
    this.promptStore = new PromptStore(this.runtime.workspace, this.runtime.dataDir);
    this.memoryStore = new MemoryStore(this.runtime.workspace, this.runtime.dataDir);
    this.skillStore = new SkillStore(this.runtime.workspace, this.runtime.dataDir);
    this.browser = new ChromeCdpController(this.runtime.dataDir, this.runtime.browserCdpUrl);
    this.sessions = new SessionStore(
      new FileSessionRepository(this.runtime.dataDir, this.runtime.workspace),
      this.runtime.workspace,
    );
    this.tools = BUILTIN_TOOLS;

    const provider = new JimoProvider(config.jimoConfig);
    const visionConfig = config.visionConfig ?? readVisionConfig(process.env);
    this.runtime.visionEnabled = Boolean(visionConfig?.shareId && visionConfig.authorization);
    this.persistRuntimeConfig();
    const vision = visionConfig?.shareId && visionConfig.authorization
      ? new JimoVisionProvider(visionConfig)
      : undefined;
    this.agent = new Agent(
      {
        ...config.agentConfig,
        mode: config.agentConfig.mode ?? this.runtime.mode,
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
        vision,
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

      if (path === "/api/sessions" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { title?: string };
        const session = this.sessions.create(body?.title);
        const summary: SessionSummary = {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: 0,
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
        if (req.method === "DELETE") {
          const deleted = this.sessions.delete(id);
          return this.sendJson(res, deleted ? 204 : 404, deleted ? null : { error: "Not found" });
        }
      }

      const msgMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgMatch && req.method === "POST") {
        return this.handleSendMessage(msgMatch[1], req, res);
      }

      if (path === "/api/upload/file" && req.method === "POST") {
        return this.handleUploadFile(req, res);
      }

      if (path === "/api/tools" && req.method === "GET") {
        return this.sendJson(res, 200, this.tools.map((t) => t.definition));
      }

      // Static file serving (optional, for desktop renderer UI in production)
      if (this.config.staticDir && req.method === "GET") {
        return this.serveStatic(req, res, path);
      }

      return this.sendJson(res, 404, { error: "Not found", path });
    } catch (err) {
      console.error("[Gateway] HTTP error:", err);
      return this.sendJson(res, 500, {
        error: "Internal server error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Send a message and stream AgentEvent as SSE. */
  private async handleSendMessage(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as { content: string | ChatMessage["content"]; role?: string; title?: string };
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "Session not found" });
    }

    const text = textOf(body.content);

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
      for await (const ev of this.agent.run(sessionId, text, { signal: ac.signal })) {
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
    const body = await readJsonBody(req) as { url: string; source?: string };
    if (!body.url) {
      return this.sendJson(res, 400, { error: "url is required" });
    }
    const provider = new JimoProvider(this.config.jimoConfig);
    const result: FileUploadResponse = await provider.uploadFile({
      url: body.url,
      source: body.source ?? "api",
    });
    return this.sendJson(res, 200, result);
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
        this.confirmModes.set(
          ws,
          msg.mode === "no-confirm" ? "no-confirm" : "confirm",
        );
        ws.send(
          JSON.stringify({
            type: "confirmMode.ack",
            mode: this.confirmModes.get(ws),
          }),
        );
        break;
      }
      case "chat": {
        await this.handleWsChat(ws, msg.sessionId, msg.message, generateId());
        return;
        break;
      }
      case "chat.start": {
        await this.handleWsChat(ws, msg.sessionId, msg.message, msg.runId);
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
  ): Promise<void> {
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
      mode: this.runtime.mode,
      workspace: this.runtime.workspace,
      dataDir: this.runtime.dataDir,
      toolsets: this.runtime.toolsets,
      safetyMode: this.runtime.safetyMode,
      browserCdpUrl: this.runtime.browserCdpUrl,
      browser: this.browser.status(),
      visionConfigured: this.runtime.visionEnabled,
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
    if (Array.isArray(patch.toolsets)) {
      this.runtime.toolsets = patch.toolsets.filter((value): value is RuntimeConfig["toolsets"][number] =>
        ["coding", "memory", "skills", "browser", "vision"].includes(String(value)),
      );
      this.config.agentConfig.toolsets = this.runtime.toolsets;
      this.agent.config.toolsets = this.runtime.toolsets;
    }
    if (patch.safetyMode === "confirm" || patch.safetyMode === "workspace-auto") {
      this.runtime.safetyMode = patch.safetyMode;
      this.config.agentConfig.safetyMode = patch.safetyMode;
      this.agent.config.safetyMode = patch.safetyMode;
    }
    if (typeof patch.browserCdpUrl === "string" && patch.browserCdpUrl.trim()) {
      this.runtime.browserCdpUrl = patch.browserCdpUrl.trim();
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
      const file = path.join(this.runtime.dataDir, "config.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        mode: this.runtime.mode,
        workspace: this.runtime.workspace,
        toolsets: this.runtime.toolsets,
        safetyMode: this.runtime.safetyMode,
        browserCdpUrl: this.runtime.browserCdpUrl,
        visionEnabled: this.runtime.visionEnabled,
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
}

// ===== Helpers =====

/** 从 ChatMessage.content 里抽取纯文本（支持多模态数组）。 */
function generateId(): string {
  return randomUUID();
}

function readVisionConfig(env: NodeJS.ProcessEnv): GatewayConfig["visionConfig"] {
  const shareId = env.JIMO_VISION_SHARE_ID?.trim();
  const authorization = env.JIMO_VISION_AUTHORIZATION?.trim();
  if (!shareId || !authorization) return undefined;
  return {
    baseUrl: env.JIMO_VISION_API_BASE_URL ?? env.JIMO_API_BASE_URL ?? "https://jimoai-bot-api.xiaohuodui.cn",
    shareId,
    authorization,
  };
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

/**
 * 读取并解析 JSON 请求体。
 *
 * 必须先 Buffer.concat 再整体解码：多字节 UTF-8 字符（如中文占 3 字节）
 * 可能跨 TCP 包边界被切开，逐 chunk 隐式 toString 会把两半各自解成 U+FFFD。
 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
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

// ===== Entry Point =====

export function startGateway(config?: Partial<GatewayConfig>): Gateway {
  const env = process.env;
  const finalConfig: GatewayConfig = {
    host: config?.host ?? env.GATEWAY_HOST ?? "127.0.0.1",
    port: config?.port ?? Number(env.GATEWAY_PORT ?? 18789),
    workspace: config?.workspace ?? env.YOOMCLAW_WORKSPACE ?? env.CLAW_WORKSPACE ?? process.cwd(),
    agentConfig: config?.agentConfig ?? {
      provider: "jimo",
      model: env.DEFAULT_MODEL ?? "jimo-default",
    },
    jimoConfig: config?.jimoConfig ?? {
      baseUrl: env.JIMO_API_BASE_URL ?? "https://jimoai-bot-api.xiaohuodui.cn",
      shareId: env.JIMO_SHARE_ID ?? "",
      authorization: env.JIMO_AUTHORIZATION ?? "",
    },
    dataDir: config?.dataDir ?? env.YOOMCLAW_DATA_DIR,
    staticDir: config?.staticDir,
    runtime: config?.runtime,
    visionConfig: config?.visionConfig ?? readVisionConfig(env),
  };

  const gateway = new Gateway(finalConfig);
  gateway.start();
  return gateway;
}

// 注意：本文件是库，不再自执行。启动请用 ./bin.ts。
