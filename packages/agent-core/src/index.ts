/**
 * @yoomclaw/agent-core - Agent runtime
 *
 * Session store + ReAct 循环。
 *
 * 关键背景（已实测）：积墨 AI 是一个**有状态 agent 应用 API**，不是模型 API。
 *  - 不支持原生 function calling，传 tools 字段会被忽略 + 模型幻觉；
 *  - 不接受 system role，传了完全无效；
 *  - 不接受客户端历史，传了也按 sessionId 的服务器上下文走；
 *  - 但 sessionId 的上下文记忆有效，且能稳定遵循在 user 消息正文里约定的 JSON 工具协议。
 *
 * 因此：Agent 不再注入 systemPrompt、不再拼历史，每轮只发一条 user 消息；
 * 工具协议靠 ReAct（用户消息正文里写规则 + 自行解析模型输出的 JSON）实现。
 */

import type {
  ChatMessage,
  ContentPart,
  Session,
  SessionSummary,
  SessionRun,
  AgentConfig,
  AgentEvent,
  SafetyMode,
  ToolRisk,
  ToolsetId,
} from "@yoomclaw/protocol";

import type { LLMProvider } from "@yoomclaw/llm-provider";

import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  type ToolContext,
  type BrowserToolController,
  type ToolOutcome,
} from "./tools.js";
import type { ToolServices } from "./services.js";
import {
  parseToolCall,
  callFingerprint,
  buildToolPrompt,
  buildSafetyPrompt,
  type ParsedToolCall,
} from "./react.js";
import { MAX_TOOL_RESULT_CHARS, truncateResult } from "./sandbox.js";
import path from "node:path";
import { RunLogger, truncate, formatArgs } from "./logger.js";
import { FileSessionRepository, type SessionRepository } from "./session-repository.js";
import {
  MemoryStore,
  PromptStore,
  SkillStore,
  type MemoryStoreName,
} from "./config.js";
import { HermesPromptAssembler, type PromptAssembler, textFromMessage } from "./prompt.js";

// ===== Session Store =====

const DEFAULT_SESSION_TITLE = "\u65b0\u5bf9\u8bdd";
const SESSION_TITLE_MAX_LENGTH = 80;

function isGeneratedSessionTitle(title: string): boolean {
  return title === DEFAULT_SESSION_TITLE
    || /^Session \d+$/.test(title)
    // Titles produced by older desktop clients included a timestamp.
    || /^\u65b0\u7684\u5bf9\u8bdd(?:\s.*)?$/.test(title);
}

function titleFromFirstUserMessage(message: ChatMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text = typeof message.content === "string"
    ? message.content
    : message.content
      .filter((part) => part.type === "text")
      .map((part) => part.type === "text" ? part.text : "")
      .join(" ");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized) {
    return normalized.length > SESSION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
      : normalized;
  }
  if (Array.isArray(message.content) && message.content.some((part) => part.type !== "text")) {
    return "\u9644\u4ef6";
  }
  return undefined;
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly repository?: SessionRepository,
    private readonly defaultWorkspace?: string,
  ) {
    for (const session of repository?.load() ?? []) {
      if (!session.workspace) session.workspace = defaultWorkspace;
      this.sessions.set(session.id, session);
    }
    for (const session of this.sessions.values()) {
      for (const run of session.runs ?? []) {
        if (run.status === "running") {
          run.status = "interrupted";
          run.endedAt = Date.now();
        }
      }
      this.persist(session);
    }
  }

  create(title?: string): Session {
    const id = generateId();
    const now = Date.now();
    const requestedTitle = typeof title === "string" ? title.trim() : "";
    const session: Session = {
      id,
      title: requestedTitle || DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
      messages: [],
      schemaVersion: 2,
      workspace: this.defaultWorkspace,
      providerSessionId: id,
      runs: [],
    };
    this.sessions.set(id, session);
    this.persist(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        archived: s.archived === true,
        pinned: s.pinned === true,
      }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  search(query: string): SessionSummary[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return this.list();
    return this.list().filter((summary) => {
      const session = this.sessions.get(summary.id);
      if (!session) return false;
      const haystack = [
        session.title,
        ...session.messages.map((message) => typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)),
      ].join("\n").toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }

  appendMessage(sessionId: string, message: ChatMessage): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (
      isGeneratedSessionTitle(session.title)
      && message.role === "user"
      && !session.messages.some((item) => item.role === "user")
    ) {
      const title = titleFromFirstUserMessage(message);
      if (title) session.title = title;
    }
    session.messages.push(message);
    session.updatedAt = Date.now();
    this.persist(session);
    return session;
  }

  truncateMessages(sessionId: string, messageCount: number): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isInteger(messageCount) || messageCount < 0 || messageCount > session.messages.length) {
      return undefined;
    }
    session.messages = session.messages.slice(0, messageCount);
    // A branch starts with a fresh execution timeline; old tool events belong to the discarded branch.
    session.runs = [];
    session.updatedAt = Date.now();
    this.persist(session);
    return session;
  }

  setMeta(sessionId: string, patch: Record<string, unknown>): Session {
    const session = this.require(sessionId);
    session.meta = { ...(session.meta ?? {}), ...patch };
    session.updatedAt = Date.now();
    this.persist(session);
    return session;
  }

  delete(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    try {
      this.repository?.delete(id);
    } catch (error) {
      console.error("Failed to delete persisted session:", error);
      return false;
    }
    this.sessions.delete(id);
    return true;
  }

  /** 导出所有会话，用于落盘持久化。 */
  dump(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** 从落盘数据恢复会话。 */
  load(sessions: Session[]): void {
    for (const s of sessions) {
      const normalized: Session = {
        ...s,
        schemaVersion: s.schemaVersion ?? 2,
        workspace: s.workspace ?? this.defaultWorkspace,
        providerSessionId: s.providerSessionId ?? s.id,
        runs: s.runs ?? [],
      };
      this.sessions.set(normalized.id, normalized);
      this.persist(normalized);
    }
  }

  rename(id: string, title: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.title = title;
    session.updatedAt = Date.now();
    this.persist(session);
    return session;
  }

  setFlags(
    id: string,
    patch: { archived?: boolean; pinned?: boolean },
  ): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (patch.archived !== undefined) session.archived = patch.archived;
    if (patch.pinned !== undefined) session.pinned = patch.pinned;
    session.updatedAt = Date.now();
    this.persist(session);
    return session;
  }

  startRun(sessionId: string, runId: string): SessionRun {
    const session = this.require(sessionId);
    const run: SessionRun = {
      runId,
      status: "running",
      startedAt: Date.now(),
      events: [],
    };
    session.runs = [...(session.runs ?? []), run];
    session.updatedAt = Date.now();
    this.persist(session);
    return run;
  }

  appendRunEvent(sessionId: string, runId: string, event: AgentEvent): void {
    const session = this.require(sessionId);
    const run = (session.runs ?? []).find((item) => item.runId === runId);
    if (!run) return;
    run.events.push(event);
    session.updatedAt = Date.now();
    this.persist(session);
  }

  finishRun(
    sessionId: string,
    runId: string,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ): void {
    const session = this.require(sessionId);
    const run = (session.runs ?? []).find((item) => item.runId === runId);
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    if (error) run.error = error;
    session.updatedAt = Date.now();
    this.persist(session);
  }

  findRun(runId: string): { sessionId: string; run: SessionRun } | undefined {
    for (const session of this.sessions.values()) {
      const run = (session.runs ?? []).find((item) => item.runId === runId);
      if (run) return { sessionId: session.id, run };
    }
    return undefined;
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private persist(session: Session): void {
    this.repository?.save(session);
  }
}

// ===== Confirm 机制 =====

/** 一次需要用户确认的待执行工具调用。 */
export interface ConfirmRequest {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  reason: string;
}

/** 确认回调：返回 true 表示放行，false 表示拒绝。 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;

export interface RunOptions {
  /** 取消信号，透传给 provider.chat 与 confirm 等待。 */
  signal?: AbortSignal;
  /**
   * 危险工具确认回调。
   * 不传时，confirm 级工具会被自动放行（适用于可信的 CLI / 本地环境）；
   * 交互式 UI 必须传入，否则用户无法拦截写操作。
   */
  confirm?: ConfirmFn;
  /** Permission policy for this run; defaults to the agent runtime setting. */
  safetyMode?: SafetyMode;
  /** Optional per-run toolset restriction; it can only narrow the Agent config. */
  toolsets?: ToolsetId[];
  /** Stable id used by Gateway cancellation and persisted run events. */
  runId?: string;
}

export interface VisionAnalyzer {
  analyze(
    message: ChatMessage,
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface AgentRuntime {
  dataDir?: string;
  promptStore?: PromptStore;
  memoryStore?: MemoryStore;
  skillStore?: SkillStore;
  browser?: BrowserToolController;
  vision?: VisionAnalyzer;
  services?: ToolServices;
  promptAssembler?: PromptAssembler;
}

export interface AgentEngine {
  run(
    sessionId: string,
    input: string | ChatMessage,
    options?: RunOptions,
  ): AsyncIterable<AgentEvent>;
}

// ===== Agent (ReAct) =====

const MAX_TOOL_ROUNDS = 12;
const SPIN_THRESHOLD = 3;

export class Agent implements AgentEngine {
  readonly config: AgentConfig;
  private logger: RunLogger;
  private readonly promptAssembler: PromptAssembler;

  constructor(
    config: AgentConfig,
    private provider: LLMProvider,
    private sessions: SessionStore,
    private tools: BuiltinTool[] = BUILTIN_TOOLS,
    private workspace: string = process.cwd(),
    private runtime: AgentRuntime = {},
  ) {
    this.config = config;
    this.logger = new RunLogger(path.join(runtime.dataDir ?? path.join(workspace, ".claw-data"), "logs"));
    this.promptAssembler = runtime.promptAssembler ?? new HermesPromptAssembler();
    const dataDir = runtime.dataDir ?? path.join(workspace, ".claw-data");
    this.runtime = {
      ...runtime,
      dataDir,
      promptStore: runtime.promptStore ?? new PromptStore(workspace, dataDir),
      memoryStore: runtime.memoryStore ?? new MemoryStore(workspace, dataDir),
      skillStore: runtime.skillStore ?? new SkillStore(workspace, dataDir),
    };
  }

  /**
   * 运行一轮对话（ReAct 循环），产出结构化事件流。
   *
   * 协议要点（供上层 UI 渲染参考）：
   *  - 每个 delta 都是模型流式正文增量；中间轮的 JSON 工具调用也会作为 delta 流出，
   *    UI 收到 tool_start 时应将此前累积的「JSON 文本」移入工具卡片（或隐藏）。
   *  - 工具调用 = tool_start →（等 confirm）→ tool_end；confirm 级工具在 tool_start
   *    之前先发 tool_confirm，UI 据此弹确认框。
   *  - 模型转为自然语言作答时，发 final 事件（携带完整最终文本），本轮结束。
   *  - error 事件是终态，出错即停止。
   */
  async *run(
    sessionId: string,
    input: string | ChatMessage,
    options?: RunOptions,
  ): AsyncIterable<AgentEvent> {
    const runId = options?.runId ?? generateId();
    this.sessions.startRun(sessionId, runId);
    yield { type: "run", runId, status: "running" };

    let status: "completed" | "interrupted" | "failed" = "completed";
    let finalText = "";
    try {
      for await (const event of this.runInternal(sessionId, input, options)) {
        this.sessions.appendRunEvent(sessionId, runId, event);
        if (event.type === "final") finalText = event.text;
        if (event.type === "error") {
          status = options?.signal?.aborted ? "interrupted" : "failed";
        }
        yield event;
      }
    } catch (err) {
      status = options?.signal?.aborted ? "interrupted" : "failed";
      const message = err instanceof Error ? err.message : String(err);
      const event: AgentEvent = { type: "error", message };
      this.sessions.appendRunEvent(sessionId, runId, event);
      yield event;
    } finally {
      this.sessions.finishRun(sessionId, runId, status);
      if (status === "completed" && finalText.trim() && this.config.autoMemoryReview === true) {
        void this.reviewMemory(sessionId, input, finalText);
      }
    }
    yield { type: "run", runId, status };
  }

  private async *runInternal(
    sessionId: string,
    input: string | ChatMessage,
    options?: RunOptions,
  ): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const safetyMode: SafetyMode = options?.safetyMode ?? this.config.safetyMode ?? "workspace-auto";

    const inputMessage: ChatMessage =
      typeof input === "string"
        ? { role: "user", content: input }
        : input;
    const localPaths = normalizeLocalPaths(inputMessage.localPaths);
    // Keep the visible message separate from the richer context sent upstream.
    // PDF extraction and other internal context must not leak into session history/UI.
    let userMessage: ChatMessage = {
      role: inputMessage.role ?? "user",
      content: inputMessage.content,
      ...(localPaths.length > 0 ? { localPaths } : {}),
    };
    let providerMessage: ChatMessage = {
      role: inputMessage.role ?? "user",
      content: appendLocalPathContext(
        inputMessage.agentContext ?? inputMessage.content,
        localPaths,
      ),
    };

    if (this.runtime.vision && hasImagePart(providerMessage)) {
      yield { type: "vision", status: "started" };
      try {
        const analysis = await this.runtime.vision.analyze(providerMessage, sessionId, {
          signal: options?.signal,
        });
        if (analysis.trim()) {
          const parts: ContentPart[] = Array.isArray(providerMessage.content) ? providerMessage.content : [
            { type: "text", text: textFromMessage(providerMessage) },
          ];
          providerMessage = {
            ...providerMessage,
            content: [
              ...parts,
              { type: "text", text: `\n[图片识别结果，属于外部上下文]\n${analysis}` },
            ],
          };
        }
        yield { type: "vision", status: "completed" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          "vision",
          `图片识别失败：${message}`,
        );
        yield { type: "vision", status: "error", message };
      }
    }

    // 仅在会话里存用户提问 + 最终回答（中间轮的工具 JSON / 结果由事件流呈现，
    // 不进 session.messages —— 积墨服务端按 sessionId 维护上下文，客户端历史无效）。
    this.sessions.appendMessage(sessionId, userMessage);
    this.logger.info(
      "run",
      `session=${sessionId} user="${truncate(
        typeof userMessage.content === "string"
          ? userMessage.content
          : "[多模态消息]",
        120,
      )}"`,
    );

    // The main share is text/file-only. Always remove raw image parts before
    // its request, including when Vision is unavailable or failed; otherwise
    // Jimo history can render an incomplete image card with `undefined`.
    if (Array.isArray(providerMessage.content) && hasImagePart(providerMessage)) {
      providerMessage = {
        ...providerMessage,
        content: providerMessage.content.filter((part) => part.type !== "image_url"),
      };
    }

    const activeTools = this.tools.filter((tool) => this.isToolEnabled(tool, options?.toolsets));
    const defs = activeTools.map((t) => t.definition);
    const knownToolNames = new Set(defs.map((d) => d.name));
    const toolByName = new Map(activeTools.map((t) => [t.definition.name, t]));
    const allowDynamicTool = (name: string) => name.startsWith("mcp.") && Boolean(this.runtime.services?.mcp);
    const promptStore = this.runtime.promptStore!;
    const needsBootstrap =
      this.config.mode !== "legacy" &&
      this.config.promptMode === "local" &&
      session.meta?.hermesPromptInitialized !== true;
    const initialPrompt = needsBootstrap
      ? this.promptAssembler.buildInitialPrompt({
          globalPrompt: promptStore.readGlobalPrompt(),
          userProfile: promptStore.readUserProfile(),
          memory: [
            promptStore.readMemory(),
            this.runtime.memoryStore?.read("user") ?? "",
          ].filter(Boolean).join("\n\n"),
          projectPrompt: promptStore.readProjectPrompt(),
          enabledTools: defs,
          skillIndex: this.runtime.skillStore?.list(false) ?? [],
          userMessage: providerMessage,
          safetyMode,
        })
      : "";
    // Provider-backed sessions do not receive the local bootstrap prompt. Inject
    // the trusted runtime permission context into the task so the fixed backend
    // prompt can resolve {{safetyMode}} on every client run.
    if (!needsBootstrap) {
      providerMessage = withSafetyContext(providerMessage, safetyMode);
      if (this.config.promptMode === "provider" && this.config.mode !== "legacy") {
        const runtimeToolsPrompt = buildToolPrompt(defs);
        providerMessage = typeof providerMessage.content === "string"
          ? { ...providerMessage, content: `${runtimeToolsPrompt}\n${providerMessage.content}` }
          : {
              ...providerMessage,
              content: [{ type: "text", text: runtimeToolsPrompt }, ...providerMessage.content],
            };
      }
    }
    const legacyPrompt = this.config.mode === "legacy"
      ? `${buildToolPrompt(defs)}\n${textFromMessage(providerMessage)}`
      : "";
    let finalText = "";
    let round = 0;
    let pendingCall: ParsedToolCall | null = null;
    let pendingResult = "";
    let pendingIsError = false;
    const fingerprintCounts = new Map<string, number>();

    try {
      while (true) {
        const maxToolRounds = this.config.maxToolRounds ?? MAX_TOOL_ROUNDS;
        if (round >= maxToolRounds) {
          this.logger.error(
            "run",
            `已达最大工具轮次（${maxToolRounds}），停止以避免死循环`,
          );
          yield {
            type: "error",
            message: `已达最大工具轮次（${maxToolRounds}），停止以避免死循环`,
          };
          break;
        }
        round++;

        // 构造本轮要发的唯一 user 消息：
        //  - 第 1 轮：规则 prompt + 用户任务
        //  - 后续轮：工具结果回填
        const roundMessage: ChatMessage =
          round === 1 && needsBootstrap
            ? {
                role: "user",
                content:
                  typeof providerMessage.content === "string"
                    ? initialPrompt
                    : [{ type: "text", text: initialPrompt }, ...providerMessage.content],
              }
            : round === 1 && this.config.mode === "legacy"
              ? {
                  role: "user",
                  content: Array.isArray(providerMessage.content)
                    ? [{ type: "text", text: legacyPrompt }, ...providerMessage.content]
                    : legacyPrompt,
                }
              : round === 1
              ? providerMessage
              : {
                role: "user",
                content: this.promptAssembler.buildToolResultPrompt({
                    toolName: pendingCall!.tool,
                    result: pendingResult,
                    isError: pendingIsError,
                  }),
                };

        let modelText = "";
        try {
          for await (const chunk of this.provider.chat(
            {
              messages: [roundMessage],
              sessionId: session.providerSessionId ?? sessionId,
              source: "api",
              // Keep the machine-readable mode available to providers that
              // resolve runtime prompt placeholders from request metadata.
              extra: { safetyMode },
            },
            { signal: options?.signal },
          )) {
            if (chunk.kind === "content") {
              modelText += chunk.content;
              yield { type: "delta", text: chunk.content };
            } else {
              yield {
                type: "progress",
                name: chunk.name,
                percent: chunk.percent,
                status: chunk.status,
              };
            }
          }
          if (needsBootstrap && round === 1) {
            this.sessions.setMeta(sessionId, { hermesPromptInitialized: true });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("run", `调用模型失败：${msg}`);
          yield { type: "error", message: `调用模型失败：${msg}` };
          break;
        }

        // 尝试解析工具调用；解析不出 = 自然语言作答 → 收敛
        if (!modelText.trim()) {
          // Jimo can occasionally close a successful SSE stream without a
          // content chunk (especially for mixed file requests). Do not leave
          // the UI with an apparently completed run and no assistant row.
          const visibleSummary = textFromMessage(userMessage).trim();
          finalText = visibleSummary
            ? `已收到输入，但积墨未返回文本内容。\n${visibleSummary.slice(0, 600)}`
            : "已收到输入，但积墨未返回文本内容。";
          yield { type: "final", text: finalText };
          break;
        }

        const unknownTool = findUnknownToolName(modelText, knownToolNames, allowDynamicTool);
        if (unknownTool) {
          const visibleSummary = textFromMessage(userMessage).trim();
          finalText = visibleSummary
            ? `The provider requested an unavailable tool (\"${unknownTool}\"); it was not executed.\n${visibleSummary.slice(0, 600)}`
            : `The provider requested an unavailable tool (\"${unknownTool}\"); it was not executed.`;
          yield { type: "final", text: finalText };
          break;
        }

        const call = parseToolCall(modelText, knownToolNames, allowDynamicTool);
        if (!call) {
          finalText = modelText;
          yield { type: "final", text: finalText };
          break;
        }
        this.logger.info("tool", `${call.tool} args=${formatArgs(call.args)}`);

        // 死循环检测：同一指纹连续出现过多则停止
        const fp = callFingerprint(call);
        const count = (fingerprintCounts.get(fp) ?? 0) + 1;
        fingerprintCounts.set(fp, count);
        if (count > (this.config.spinThreshold ?? SPIN_THRESHOLD)) {
          this.logger.error("run", "检测到模型重复调用相同工具，疑似死循环，已停止");
          yield {
            type: "error",
            message: "检测到模型重复调用相同工具，疑似死循环，已停止",
          };
          finalText = modelText;
          yield { type: "final", text: finalText };
          break;
        }

        let builtin = toolByName.get(call.tool);
        if (!builtin && allowDynamicTool(call.tool)) {
          builtin = {
            risk: "confirm",
            definition: {
              name: call.tool,
              description: "由已配置 MCP Server 提供的动态工具。",
              parameters: { type: "object" },
              toolset: "mcp",
            },
            assess: () => `将调用动态 MCP 工具 ${call.tool}`,
            async run(args, ctx) {
              const service = ctx.services?.mcp;
              if (!service) return { result: "MCP 服务不可用", isError: true, code: "MCP_UNAVAILABLE" };
              const result = await service.invoke(call.tool, args, {
                sessionId: ctx.sessionId,
                workspace: ctx.workspace,
                dataDir: ctx.dataDir,
                safetyMode: ctx.safetyMode,
                signal: ctx.signal,
              });
              return { result: result.result, isError: Boolean(result.isError) };
            },
          };
          toolByName.set(call.tool, builtin);
          knownToolNames.add(call.tool);
        }
        if (!builtin) {
          finalText = `The provider requested an unavailable tool ("${call.tool}"); it was not executed.`;
          yield { type: "final", text: finalText };
          break;
        }
        const callId = generateId();

        // 运行时确认判定：静态 risk + 工具的 assess 钩子
        const assessReason = builtin.assess ? builtin.assess(call.args) : null;
        const needConfirm = this.requiresConfirmation(builtin, call.args, assessReason, safetyMode);
        const reason = assessReason ?? "该工具会修改你的系统，需要确认";

        let approved = true;
        if (needConfirm) {
          yield {
            type: "tool_confirm",
            callId,
            name: call.tool,
            args: call.args,
            reason,
          };
          if (options?.confirm) {
            try {
              approved = await options.confirm({
                callId,
                name: call.tool,
                args: call.args,
                reason,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.logger.error("run", `等待确认时被中断：${msg}`);
              yield { type: "error", message: `等待确认时被中断：${msg}` };
              break;
            }
          } else {
            // 无确认回调：可信环境下自动放行（CLI 场景）
            approved = false;
          }
        }

        this.logger.info("tool", `${call.tool} approved=${approved}${needConfirm ? " (需确认)" : ""}`);
        if (call.tool === "delegate_task" && approved) {
          yield {
            type: "subagent",
            status: "started",
            taskId: callId,
            message: typeof call.args.task === "string" ? call.args.task.slice(0, 500) : undefined,
          };
        }
        yield { type: "tool_start", callId, name: call.tool, args: call.args };

        const startedAt = Date.now();
        let outcome: ToolOutcome;
        if (!approved) {
          outcome = { result: "用户拒绝了该工具的执行", isError: true };
        } else {
          const ctx: ToolContext = {
            sessionId,
            workspace: this.workspace,
            dataDir: this.runtime.dataDir,
            signal: options?.signal,
            memory: this.runtime.memoryStore,
            skills: this.runtime.skillStore,
            browser: this.runtime.browser,
            safetyMode,
            services: this.runtime.services,
            toolRegistry: activeTools,
          };
          try {
            outcome = await builtin.run(call.args, ctx);
          } catch (err) {
            outcome = {
              result: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        }
        const durationMs = Date.now() - startedAt;
        const requestedResultLimit = Number(outcome.resultLimit);
        const resultLimit = Number.isFinite(requestedResultLimit)
          ? Math.min(200_000, Math.max(MAX_TOOL_RESULT_CHARS, requestedResultLimit))
          : MAX_TOOL_RESULT_CHARS;
        const resultText = truncateResult(outcome.result, resultLimit);

        this.logger.info(
          "tool",
          `${call.tool} ${outcome.isError ? "ERROR" : "ok"} ${durationMs}ms -> ${truncate(resultText, 160)}`,
        );

        yield {
          type: "tool_end",
          callId,
          name: call.tool,
          result: resultText,
          isError: outcome.isError,
          durationMs,
          ...(outcome.code ? { code: outcome.code } : {}),
          ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
        };

        const lifecycleEvent = toolLifecycleEvent(call.tool, call.args, resultText, outcome.isError, outcome.metadata);
        if (lifecycleEvent) yield lifecycleEvent;
        const subagentEvent = subagentLifecycleEvent(call.tool, callId, resultText, outcome.isError);
        if (subagentEvent) yield subagentEvent;

        // 把结果回填，进入下一轮
        pendingCall = call;
        pendingResult = resultText;
        pendingIsError = outcome.isError;
      }
    } finally {
      // 持久化最终回答（若有）
      if (finalText) {
        this.logger.info("run", `final ${finalText.length} 字符`);
        this.sessions.appendMessage(sessionId, {
          role: "assistant",
          content: finalText,
        });
      } else {
        // 出错但有一轮模型输出（如死循环时截断的 JSON）：存一条简短记录，避免空历史
        // 这里不强制落盘，保持会话干净。
      }
    }
  }

  private isToolEnabled(tool: BuiltinTool, runToolsets?: ToolsetId[]): boolean {
    const name = tool.definition.name;
    if (this.config.enabledTools && !this.config.enabledTools.includes(name)) return false;
    const toolset = tool.definition.toolset ?? "coding";
    const enabledToolsets = runToolsets ?? this.config.toolsets ?? [
      "coding", "memory", "skills", "browser", "vision", "planning", "web", "execution", "orchestration",
    ];
    return enabledToolsets.includes(toolset);
  }

  private requiresConfirmation(
    tool: BuiltinTool,
    args: Record<string, unknown>,
    assessReason: string | null,
    safetyMode: SafetyMode = this.config.safetyMode ?? "workspace-auto",
  ): boolean {
    if (safetyMode === "full-access") return false;
    if (safetyMode === "confirm") return true;
    const name = tool.definition.name;
    if (name === "write_file" || name === "edit_file") {
      return !isWorkspacePath(this.workspace, args.path);
    }
    if (name === "apply_patch") {
      // The patch tool validates every path before writing; workspace-auto can
      // apply an in-workspace patch without an extra prompt.
      return false;
    }
    if (name === "parallel") {
      const calls = Array.isArray(args.calls) ? args.calls : [];
      return calls.some((item) => {
        if (!item || typeof item !== "object") return true;
        const nameValue = (item as { tool?: unknown }).tool;
        const nested = this.tools.find((candidate) => candidate.definition.name === nameValue);
        return !nested || nested.risk === "confirm";
      });
    }
    if (name === "memory_save" || name === "memory_replace" || name === "skill_draft") {
      return false;
    }
    if (name === "browser_type" || name === "skill_apply") return true;
    if ((name === "bash" || name === "run_command") && assessReason) return true;
    if (name === "browser_click" && assessReason) return true;
    return (tool.risk as ToolRisk) === "confirm" && Boolean(assessReason);
  }

  private async reviewMemory(
    sessionId: string,
    input: string | ChatMessage,
    finalText: string,
  ): Promise<void> {
    if (this.config.mode === "legacy" || !this.runtime.memoryStore) return;

    const userText = sanitizeReviewText(
      typeof input === "string" ? input : textFromMessage(input),
    );
    const answerText = sanitizeReviewText(finalText);
    if (!userText && !answerText) return;

    const prompt = [
      "你是一个严格的记忆整理器。只输出 JSON，不要 Markdown，不要解释。",
      '格式必须是：{"memory": ["项目或环境长期事实"], "user": ["用户长期偏好"]}。',
      "只提炼未来任务确实有帮助、稳定且非敏感的信息；没有合适内容就返回空数组。",
      "不得保存密码、Token、Cookie、私钥、个人隐私、一次性任务细节或模型推测。每条不超过 240 个字符，最多各 3 条。",
      `用户任务：\n${userText.slice(0, 2_000)}`,
      `任务结果：\n${answerText.slice(0, 4_000)}`,
    ].join("\n\n");

    let raw = "";
    try {
      for await (const chunk of this.provider.chat({
        messages: [{ role: "user", content: prompt }],
        sessionId: `memory-review-${sessionId}-${Date.now()}`,
        source: "memory-review",
        extra: {},
      })) {
        if (chunk.kind === "content") raw += chunk.content;
      }
      const review = parseMemoryReview(raw);
      if (!review) return;
      for (const value of review.memory) {
        try { this.runtime.memoryStore.append("memory", value); } catch { /* ignore one invalid candidate */ }
      }
      for (const value of review.user) {
        try { this.runtime.memoryStore.append("user", value); } catch { /* ignore one invalid candidate */ }
      }
    } catch (err) {
      this.logger.warn("memory", `review skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function findUnknownToolName(
  text: string,
  knownTools: Set<string>,
  allowDynamicTool?: (name: string) => boolean,
): string | null {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    const tool = value.tool ?? value.name ?? value.tool_name;
    return typeof tool === "string" && !knownTools.has(tool) && !allowDynamicTool?.(tool) ? tool : null;
  } catch {
    return null;
  }
}

// ===== Utilities =====

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function hasImagePart(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === "image_url");
}

const MAX_LOCAL_PATHS_PER_MESSAGE = 32;
const MAX_LOCAL_PATH_LENGTH = 4_096;

function normalizeLocalPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, MAX_LOCAL_PATH_LENGTH)))]
    .slice(0, MAX_LOCAL_PATHS_PER_MESSAGE);
}

function appendLocalPathContext(
  content: string | ContentPart[],
  localPaths: string[],
): string | ContentPart[] {
  if (localPaths.length === 0) return content;
  const context = [
    "[本地附件路径（来自桌面客户端）]",
    ...localPaths.map((localPath) => `- ${localPath}`),
    "这些路径来自用户在桌面客户端选择的本地文件或目录。若用户要求在其中创建或修改内容，请把它当作目标目录，先用 list_dir 确认，再必须调用 write_file、edit_file 或其他文件工具实际写入；不要把完整源码直接作为最终回复。需要执行文件操作时，请使用完整路径作为工具 path 参数。",
  ].join("\n");
  if (typeof content === "string") return `${context}\n\n${content}`;
  return [{ type: "text", text: context }, ...content];
}

function isWorkspacePath(workspace: string, candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, candidate);
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const resCmp = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return resCmp === rootCmp || resCmp.startsWith(rootCmp + path.sep);
}

function withSafetyContext(message: ChatMessage, safetyMode: SafetyMode): ChatMessage {
  const policy = buildSafetyPrompt(safetyMode);
  if (typeof message.content === "string") {
    return {
      ...message,
      content: `${policy}\n\n## 当前用户任务\n${message.content}`,
    };
  }
  return {
    ...message,
    content: [
      { type: "text", text: `${policy}\n\n## 当前用户任务` },
      ...message.content,
    ],
  };
}

function sanitizeReviewText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi, "[redacted]")
    .replace(/(?:api[_-]?key|authorization|bearer|password|cookie)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/ghp_[a-z0-9]{20,}/gi, "[redacted]")
    .replace(/\b(?:sk|sk-proj|rk|xoxb|xoxp|github_pat)_[a-z0-9_-]{12,}/gi, "[redacted]");
}

function parseMemoryReview(raw: string): { memory: string[]; user: string[] } | null {
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const value = JSON.parse(candidate) as { memory?: unknown; user?: unknown };
    if (!Array.isArray(value.memory) || !Array.isArray(value.user)) return null;
    const clean = (items: unknown[]) => items
      .filter((item): item is string => typeof item === "string")
      .map((item) => sanitizeReviewText(item.trim()).slice(0, 240))
      .filter((item) => item.length > 0)
      .slice(0, 3);
    return { memory: clean(value.memory), user: clean(value.user) };
  } catch {
    return null;
  }
}

function toolLifecycleEvent(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  metadata?: Record<string, unknown>,
): AgentEvent | null {
  if (name === "update_plan" && !isError) {
    try {
      const plan = metadata?.plan && typeof metadata.plan === "object"
        ? metadata.plan as { items?: unknown; updatedAt?: unknown; note?: unknown }
        : JSON.parse(result) as { items?: unknown; updatedAt?: unknown; note?: unknown };
      if (Array.isArray(plan.items) && typeof plan.updatedAt === "number") {
        return {
          type: "plan",
          plan: {
            items: plan.items as import("@yoomclaw/protocol").PlanState["items"],
            updatedAt: plan.updatedAt,
            ...(typeof plan.note === "string" ? { note: plan.note } : {}),
          },
        };
      }
    } catch {
      // The tool result remains visible in the tool card.
    }
  }
  if (name === "memory_save" || name === "memory_replace" || name === "memory_delete") {
    const store = args.store === "user" ? "user" : args.store === "memory" ? "memory" : null;
    if (!store) return null;
    return {
      type: "memory",
      action: isError ? "skipped" : name === "memory_delete" ? "deleted" : name === "memory_replace" ? "updated" : "saved",
      store,
      detail: result,
    };
  }
  if (name === "skill_draft") {
    try {
      const draft = JSON.parse(result) as { id?: unknown; name?: unknown };
      if (typeof draft.id === "string") {
        return {
          type: "skill_draft",
          skillId: draft.id,
          name: typeof draft.name === "string" ? draft.name : draft.id,
          status: isError ? "rejected" : "created",
        };
      }
    } catch {
      // The tool result remains visible in the tool card.
    }
  }
  if (name === "skill_apply" && typeof args.id === "string") {
    return {
      type: "skill_draft",
      skillId: args.id,
      name: args.id,
      status: isError ? "rejected" : "applied",
    };
  }
  return null;
}

function subagentLifecycleEvent(
  name: string,
  callId: string,
  result: string,
  isError: boolean,
): AgentEvent | null {
  if (name !== "delegate_task") return null;
  let parsed: { taskId?: unknown; status?: unknown; summary?: unknown } = {};
  try {
    const value = JSON.parse(result) as unknown;
    if (value && typeof value === "object") parsed = value as typeof parsed;
  } catch {
    // The raw result is still shown in the tool card.
  }
  const childTaskId = typeof parsed.taskId === "string" ? parsed.taskId : callId;
  const completed = !isError && parsed.status === "completed";
  return {
    type: "subagent",
    status: completed ? "completed" : "error",
    taskId: childTaskId,
    childSessionId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
    message: typeof parsed.summary === "string" ? parsed.summary.slice(0, 1000) : result.slice(0, 1000),
  };
}

export { BUILTIN_TOOLS, type BuiltinTool } from "./tools.js";
export {
  buildToolPrompt,
  buildSafetyPrompt,
  buildToolResultPrompt,
  parseToolCall,
  callFingerprint,
  RULE_MARKER,
} from "./react.js";
export {
  resolveInWorkspace,
  judgeCommand,
  truncateResult,
  MAX_TOOL_RESULT_CHARS,
  MAX_FILE_BYTES,
  BASH_TIMEOUT_MS,
} from "./sandbox.js";
export { FileSessionRepository, type SessionRepository } from "./session-repository.js";
export { DefaultToolRegistry, type ToolRegistry } from "./tool-registry.js";
export {
  PromptStore,
  MemoryStore,
  SkillStore,
  loadRuntimeConfig,
  ensureAgentLayout,
  getAgentPaths,
} from "./config.js";
export { HermesPromptAssembler, type PromptContext, textFromMessage } from "./prompt.js";
export { ChromeCdpController } from "./browser.js";
export type {
  ToolServices,
  ToolServiceContext,
  PlanStore,
  VisionService,
  VisionRequest,
  DocumentService,
  DocumentRequest,
  DocumentReadResult,
  WebService,
  WebFetchRequest,
  WebFetchResult,
  WebSearchRequest,
  WebSearchResult,
  CodeRunner,
  CodeRunRequest,
  CodeRunResult,
  SubagentService,
  SubagentRequest,
  SubagentResult,
  McpService,
  McpToolSummary,
  TrashService,
} from "./services.js";

export { createProvider, type LLMProvider, type ProviderConfig } from "@yoomclaw/llm-provider";
