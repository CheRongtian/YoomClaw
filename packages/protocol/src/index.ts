/**
 * @yoomclaw/protocol - Core message protocol types for YoomClaw
 *
 * Inspired by OpenClaw's gateway-protocol package.
 * These types define the contract between Gateway, Agent, Channels, and UI.
 */

// ===== Chat Message Types =====

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Content part for multimodal messages (text/image/file). */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface FileContentPart {
  type: "file_url";
  file_url: {
    url: string;
    fileId: string;
  };
}

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | FileContentPart;

export interface ChatMessage {
  role: MessageRole;
  content: string | ContentPart[];
  /** Optional name for tool messages. */
  name?: string;
  /** Tool call id, if this is a tool response. */
  tool_call_id?: string;
}

// ===== Session Types =====

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Optional metadata. */
  meta?: Record<string, unknown>;
}

// ===== Request/Response (compatible with JimoAI API format) =====

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  sessionId: string;
  source: string;
  extra?: Record<string, unknown>;
}

export interface ChatCompletionChunk {
  role: "assistant";
  content: string;
}

export interface ChatCompletionEnd {
  end: Record<string, never>;
  role: "assistant";
}

// SSE event types emitted by the LLM provider
export type SSEEvent =
  | { event: "data"; data: ChatCompletionChunk }
  | { event: "end"; data: ChatCompletionEnd };

// ===== File Upload =====

export interface FileUploadRequest {
  url: string;
  source: string;
}

export interface FileUploadResponse {
  id: number;
  source: string;
  processId: string | null;
  fileName: string;
  fileId: string;
  type: number;
  url: string;
  content: string | null;
  extra: string;
  createAt: number;
  updateAt: number;
  deleted: boolean;
}

// ===== Tool / Skill Types =====

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError?: boolean;
}

/** 工具的风险等级，决定是否需要用户确认。 */
export type ToolRisk = "safe" | "confirm";

// ===== Agent 事件流 =====

/**
 * Agent 运行时向上层吐出的结构化事件。
 *
 * 之所以不用裸文本 chunk：ReAct 循环里一次用户提问会产生
 * "思考 → 调用工具 → 拿结果 → 再思考" 的多段过程，
 * UI 需要区分这些阶段才能渲染出工具卡片和进度。
 */
export type AgentEvent =
  /** 模型正文增量 */
  | { type: "delta"; text: string }
  /** 上游节点进度（积墨 SSE 的 event:event） */
  | { type: "progress"; name: string; percent: number; status: number }
  /** 即将执行工具 */
  | { type: "tool_start"; callId: string; name: string; args: Record<string, unknown> }
  /** 工具执行完毕 */
  | {
      type: "tool_end";
      callId: string;
      name: string;
      result: string;
      isError: boolean;
      durationMs: number;
    }
  /** 危险工具等待用户确认 */
  | {
      type: "tool_confirm";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      reason: string;
    }
  /** 本轮收敛，附最终完整文本 */
  | { type: "final"; text: string }
  /** 出错 */
  | { type: "error"; message: string };

/** 用户对危险工具的裁决。 */
export interface ToolDecision {
  callId: string;
  approved: boolean;
}

// ===== Gateway Protocol (WebSocket) =====

export type GatewayMessage =
  | { type: "chat"; sessionId: string; message: ChatMessage }
  | { type: "chat.stream"; sessionId: string; chunk: ChatCompletionChunk }
  | { type: "chat.event"; sessionId: string; event: AgentEvent }
  | { type: "chat.end"; sessionId: string }
  | { type: "tool.decision"; sessionId: string; decision: ToolDecision }
  | { type: "setConfirmMode"; mode: "confirm" | "no-confirm" }
  | { type: "session.list" }
  | { type: "session.list.result"; sessions: SessionSummary[] }
  | { type: "session.create"; title?: string }
  | { type: "session.create.result"; session: SessionSummary }
  | { type: "session.get"; sessionId: string }
  | { type: "session.get.result"; session: Session }
  | { type: "session.delete"; sessionId: string }
  | { type: "error"; message: string; code?: string };

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ===== Agent Configuration =====

export interface AgentConfig {
  /** LLM provider id. */
  provider: string;
  /** Model identifier. */
  model: string;
  /** System prompt. */
  systemPrompt?: string;
  /** Max tokens per response. */
  maxTokens?: number;
  /** Temperature. */
  temperature?: number;
  /** Enabled tool names. */
  enabledTools?: string[];
}
