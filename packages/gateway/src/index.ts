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
import { WebSocketServer, WebSocket } from "ws";
import {
  Agent,
  SessionStore,
  BUILTIN_TOOLS,
  type BuiltinTool,
  type ConfirmFn,
} from "@yoomclaw/agent-core";
import { JimoProvider } from "@yoomclaw/llm-provider";
import type {
  ChatMessage,
  SessionSummary,
  GatewayMessage,
  FileUploadResponse,
  AgentEvent,
  Session,
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
}

// ===== Gateway Server =====

interface PendingConfirm {
  ws: WebSocket;
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
}

export class Gateway {
  private httpServer: http.Server;
  private wsServer: WebSocketServer;
  private sessions: SessionStore;
  private tools: BuiltinTool[];
  private agent: Agent;
  private config: GatewayConfig;
  /** callId → 等待用户确认的裁决。 */
  private pendingConfirm = new Map<string, PendingConfirm>();
  /** 每个连接当前的工具确认模式；默认需确认，no-confirm 时自动放行。 */
  private confirmModes = new Map<WebSocket, "confirm" | "no-confirm">();
  private sessionsFile: string;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.sessions = new SessionStore();
    this.tools = BUILTIN_TOOLS;

    const provider = new JimoProvider(config.jimoConfig);
    this.agent = new Agent(
      config.agentConfig,
      provider,
      this.sessions,
      this.tools,
      config.workspace,
    );

    this.sessionsFile = path.join(
      config.dataDir ?? path.join(config.workspace, ".claw-data"),
      "sessions.json",
    );
    this.loadSessions();

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
    return new Promise((resolve) => {
      this.wsServer.close();
      this.httpServer.close(() => resolve());
    });
  }

  // ===== HTTP =====

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

      if (path === "/api/sessions" && req.method === "GET") {
        return this.sendJson(res, 200, this.sessions.list());
      }

      if (path === "/api/sessions" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { title?: string };
        const session = this.sessions.create(body?.title);
        this.saveSessions();
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
          if (deleted) this.saveSessions();
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
      this.saveSessions();
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
        this.saveSessions();
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
        if (this.sessions.delete(msg.sessionId)) this.saveSessions();
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
        const message = msg.message;
        const ac = new AbortController();
        const onClose = () => ac.abort();
        ws.once("close", onClose);

        // 危险工具确认：把裁决请求挂起，等前端 tool.decision 回来再放行。
        // no-confirm 模式下直接放行，不再弹确认框（事件也不转发给前端）。
        const confirm: ConfirmFn = (req) =>
          new Promise<boolean>((resolve, reject) => {
            if (this.confirmModes.get(ws) === "no-confirm") {
              resolve(true);
              return;
            }
            this.pendingConfirm.set(req.callId, { ws, resolve, reject });
          });

        try {
          for await (const ev of this.agent.run(msg.sessionId, message, {
            signal: ac.signal,
            confirm,
          })) {
            // no-confirm 模式：不把 tool_confirm 事件发给前端，避免闪一下确认框
            if (
              ev.type === "tool_confirm" &&
              this.confirmModes.get(ws) === "no-confirm"
            ) {
              continue;
            }
            ws.send(JSON.stringify({
              type: "chat.event",
              sessionId: msg.sessionId,
              event: ev,
            } satisfies GatewayMessage));
          }
          ws.send(JSON.stringify({
            type: "chat.end",
            sessionId: msg.sessionId,
          } satisfies GatewayMessage));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }));
        } finally {
          ws.off("close", onClose);
          this.saveSessions();
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

  // ===== Session 持久化 =====

  private loadSessions(): void {
    try {
      const raw = fs.readFileSync(this.sessionsFile, "utf8");
      const arr = JSON.parse(raw) as Session[];
      if (Array.isArray(arr)) this.sessions.load(arr);
    } catch {
      // 还没有持久化文件，跳过
    }
  }

  private saveSessions(): void {
    try {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions.dump()), "utf8");
    } catch (err) {
      console.error("[Gateway] 保存会话失败:", err);
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
    workspace: config?.workspace ?? env.CLAW_WORKSPACE ?? process.cwd(),
    agentConfig: config?.agentConfig ?? {
      provider: "jimo",
      model: env.DEFAULT_MODEL ?? "jimo-default",
    },
    jimoConfig: config?.jimoConfig ?? {
      baseUrl: env.JIMO_API_BASE_URL ?? "https://jimoai-bot-api.xiaohuodui.cn",
      shareId: env.JIMO_SHARE_ID ?? "",
      authorization: env.JIMO_AUTHORIZATION ?? "",
    },
    dataDir: config?.dataDir,
    staticDir: config?.staticDir,
  };

  const gateway = new Gateway(finalConfig);
  gateway.start();
  return gateway;
}

// 注意：本文件是库，不再自执行。启动请用 ./bin.ts。
