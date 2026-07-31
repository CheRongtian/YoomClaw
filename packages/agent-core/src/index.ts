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
  Session,
  SessionSummary,
  AgentConfig,
  AgentEvent,
  ToolRisk,
} from "@yoomclaw/protocol";

import type { LLMProvider } from "@yoomclaw/llm-provider";

import { BUILTIN_TOOLS, type BuiltinTool, type ToolContext } from "./tools.js";
import {
  buildToolPrompt,
  buildToolResultPrompt,
  parseToolCall,
  callFingerprint,
  type ParsedToolCall,
} from "./react.js";
import { truncateResult } from "./sandbox.js";
import path from "node:path";
import { RunLogger, truncate, formatArgs } from "./logger.js";

// ===== Session Store =====

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(title?: string): Session {
    const id = generateId();
    const now = Date.now();
    const session: Session = {
      id,
      title: title ?? `Session ${this.sessions.size + 1}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(id, session);
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
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  appendMessage(sessionId: string, message: ChatMessage): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.updatedAt = Date.now();
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** 导出所有会话，用于落盘持久化。 */
  dump(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** 从落盘数据恢复会话。 */
  load(sessions: Session[]): void {
    for (const s of sessions) this.sessions.set(s.id, s);
  }

  rename(id: string, title: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.title = title;
    session.updatedAt = Date.now();
    return session;
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
}

// ===== Agent (ReAct) =====

const MAX_TOOL_ROUNDS = 12;
const SPIN_THRESHOLD = 3;

export class Agent {
  readonly config: AgentConfig;
  private logger: RunLogger;

  constructor(
    config: AgentConfig,
    private provider: LLMProvider,
    private sessions: SessionStore,
    private tools: BuiltinTool[] = BUILTIN_TOOLS,
    private workspace: string = process.cwd(),
  ) {
    this.config = config;
    this.logger = new RunLogger(path.join(workspace, ".claw-data"));
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
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const userMessage: ChatMessage =
      typeof input === "string"
        ? { role: "user", content: input }
        : { role: input.role ?? "user", content: input.content };

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

    const defs = this.tools.map((t) => t.definition);
    const knownToolNames = new Set(defs.map((d) => d.name));
    const toolByName = new Map(this.tools.map((t) => [t.definition.name, t]));

    const rulePrompt = buildToolPrompt(defs);

    let finalText = "";
    let round = 0;
    let pendingCall: ParsedToolCall | null = null;
    let pendingResult = "";
    let pendingIsError = false;
    const fingerprintCounts = new Map<string, number>();

    try {
      while (true) {
        if (round >= MAX_TOOL_ROUNDS) {
          this.logger.error(
            "run",
            `已达最大工具轮次（${MAX_TOOL_ROUNDS}），停止以避免死循环`,
          );
          yield {
            type: "error",
            message: `已达最大工具轮次（${MAX_TOOL_ROUNDS}），停止以避免死循环`,
          };
          break;
        }
        round++;

        // 构造本轮要发的唯一 user 消息：
        //  - 第 1 轮：规则 prompt + 用户任务
        //  - 后续轮：工具结果回填
        const roundMessage: ChatMessage =
          round === 1
            ? {
                role: "user",
                content:
                  typeof userMessage.content === "string"
                    ? rulePrompt + userMessage.content
                    : [{ type: "text", text: rulePrompt }, ...userMessage.content],
              }
            : {
                role: "user",
                content: buildToolResultPrompt(
                  pendingCall!.tool,
                  pendingResult,
                  pendingIsError,
                ),
              };

        let modelText = "";
        try {
          for await (const chunk of this.provider.chat(
            { messages: [roundMessage], sessionId, source: "api", extra: {} },
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("run", `调用模型失败：${msg}`);
          yield { type: "error", message: `调用模型失败：${msg}` };
          break;
        }

        // 尝试解析工具调用；解析不出 = 自然语言作答 → 收敛
        const call = parseToolCall(modelText, knownToolNames);
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
        if (count > SPIN_THRESHOLD) {
          this.logger.error("run", "检测到模型重复调用相同工具，疑似死循环，已停止");
          yield {
            type: "error",
            message: "检测到模型重复调用相同工具，疑似死循环，已停止",
          };
          finalText = modelText;
          yield { type: "final", text: finalText };
          break;
        }

        const builtin = toolByName.get(call.tool)!;
        const callId = generateId();

        // 运行时确认判定：静态 risk + 工具的 assess 钩子
        const assessReason = builtin.assess ? builtin.assess(call.args) : null;
        const needConfirm = (builtin.risk as ToolRisk) === "confirm" || assessReason !== null;
        const reason = assessReason ?? "该工具会修改你的系统，需要确认";

        let approved = true;
        if (needConfirm) {
          if (options?.confirm) {
            yield {
              type: "tool_confirm",
              callId,
              name: call.tool,
              args: call.args,
              reason,
            };
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
            approved = true;
          }
        }

        this.logger.info("tool", `${call.tool} approved=${approved}${needConfirm ? " (需确认)" : ""}`);
        yield { type: "tool_start", callId, name: call.tool, args: call.args };

        const startedAt = Date.now();
        let outcome: { result: string; isError: boolean };
        if (!approved) {
          outcome = { result: "用户拒绝了该工具的执行", isError: true };
        } else {
          const ctx: ToolContext = { sessionId, workspace: this.workspace };
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
        const resultText = truncateResult(outcome.result);

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
        };

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
}

// ===== Utilities =====

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export { BUILTIN_TOOLS, type BuiltinTool } from "./tools.js";
export {
  buildToolPrompt,
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

export { createProvider, type LLMProvider, type ProviderConfig } from "@yoomclaw/llm-provider";
