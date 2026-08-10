/**
 * @yoomclaw/protocol - Core message protocol types for YoomClaw
 *
 * Inspired by OpenClaw's gateway-protocol package.
 * These types define the contract between Gateway, Agent, Channels, and UI.
 */

export * from "./file-policy.js";
import type { FileInputKind } from "./file-policy.js";

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
  /**
   * Native local paths associated with the visible file attachments.
   * Persisted so edit/retry/session recovery can reconstruct the Agent input.
   */
  localPaths?: string[];
  /** Internal-only context for the Agent; never persisted or rendered by the UI. */
  agentContext?: string | ContentPart[];
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
  /** Persisted session schema version. Older sessions may omit this field. */
  schemaVersion?: number;
  /** Workspace used by the agent for this session. */
  workspace?: string;
  /** Stable provider-side session id. */
  providerSessionId?: string;
  /** Persisted execution records for resumable UI state. */
  runs?: SessionRun[];
  /** Optional metadata. */
  meta?: Record<string, unknown>;
  /** Hide the session from the default recent-session view without deleting it. */
  archived?: boolean;
  /** Keep the session at the top of the recent-session view. */
  pinned?: boolean;
}

export type SessionRunStatus =
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export interface SessionRun {
  runId: string;
  status: SessionRunStatus;
  startedAt: number;
  endedAt?: number;
  events: AgentEvent[];
  error?: string;
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
  /** Original renderer filename, used only to preserve a safe extension. */
  fileName?: string;
  /** Browser MIME type, if available. */
  mimeType?: string;
  /** Normalized upload category derived from the filename. */
  kind?: FileInputKind;
  /** Original local byte size, when the caller has it. */
  sizeBytes?: number;
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

/** A local file resolved by the desktop media preprocessor. */
export interface LocalFileReadResponse {
  ok: true;
  fileName: string;
  extension: string;
  mimeType: string;
  kind: FileInputKind;
  sizeBytes: number;
  dataUrl: string;
}

export interface PdfReadResponse {
  ok: true;
  fileName: string;
  pages: number;
  extractedPages: number;
  text: string;
  truncated: boolean;
}

// ===== Tool / Skill Types =====

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Hermes-style logical toolset. */
  toolset?: ToolsetId;
}

export type ToolsetId =
  | "coding"
  | "memory"
  | "skills"
  | "browser"
  | "planning"
  | "web"
  | "execution"
  | "orchestration"
  | "mcp"
  | "computer";

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
  /** Optional machine-readable error code for UI and integrations. */
  code?: string;
  /** Optional structured metadata; never required by legacy clients. */
  metadata?: Record<string, unknown>;
}

/** 工具的风险等级，决定是否需要用户确认。 */
export type ToolRisk = "safe" | "confirm";

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  detail?: string;
}

export interface PlanState {
  items: PlanItem[];
  note?: string;
  updatedAt: number;
}

// ===== Agent 事件流 =====

/**
 * Agent 运行时向上层吐出的结构化事件。
 *
 * 之所以不用裸文本 chunk：ReAct 循环里一次用户提问会产生
 * "思考 → 调用工具 → 拿结果 → 再思考" 的多段过程，
 * UI 需要区分这些阶段才能渲染出工具卡片和进度。
 */
export type AgentEvent =
  | { type: "run"; runId: string; status: SessionRunStatus }
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
      code?: string;
      metadata?: Record<string, unknown>;
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
  | {
      type: "memory";
      action: "saved" | "updated" | "deleted" | "skipped";
      store: "memory" | "user";
      detail?: string;
    }
  | {
      type: "skill_draft";
      skillId: string;
      name: string;
      status: "created" | "applied" | "rejected";
    }
  | {
      type: "browser";
      status: "connected" | "disconnected" | "error";
      url?: string;
      message?: string;
    }
  | { type: "plan"; plan: PlanState }
  | {
      type: "subagent";
      status: "started" | "updated" | "completed" | "error";
      taskId: string;
      message?: string;
      childSessionId?: string;
    }
  | { type: "final"; text: string }
  /** 出错 */
  | { type: "error"; message: string };

/** 用户对危险工具的裁决。 */
export interface ToolDecision {
  callId: string;
  approved: boolean;
}

// ===== Gateway Protocol (WebSocket) =====

/** Runtime permission policy selected by the user. */
export type SafetyMode = "confirm" | "workspace-auto" | "full-access";

export type GatewayMessage =
  | { type: "chat"; sessionId: string; message: ChatMessage; safetyMode?: SafetyMode }
  | {
      type: "chat.start";
      sessionId: string;
      runId: string;
      message: ChatMessage;
      /** Permission mode captured by the desktop client for this run. */
      safetyMode?: SafetyMode;
    }
  | { type: "chat.cancel"; sessionId: string; runId: string }
  | { type: "chat.stream"; sessionId: string; chunk: ChatCompletionChunk }
  | {
      type: "chat.event";
      sessionId: string;
      event: AgentEvent;
      runId?: string;
    }
  | {
      type: "chat.end";
      sessionId: string;
      runId?: string;
      status?: SessionRunStatus;
    }
  | { type: "tool.decision"; sessionId: string; decision: ToolDecision }
  /** `no-confirm` is retained for older desktop clients and maps to workspace-auto. */
  | { type: "setConfirmMode"; mode: SafetyMode | "no-confirm" }
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
  archived?: boolean;
  pinned?: boolean;
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
  /** Enabled Hermes-style toolsets. */
  toolsets?: ToolsetId[];
  /** Where the main agent's behavior prompt is maintained. */
  promptMode?: "provider" | "local";
  /** Run the separate provider-backed memory review after successful tasks. */
  autoMemoryReview?: boolean;
  /** Workspace execution policy. */
  safetyMode?: SafetyMode;
  /** Maximum ReAct tool rounds. */
  maxToolRounds?: number;
  /** Repeated identical calls before stopping. */
  spinThreshold?: number;
}

// ===== Hermes-style runtime/config types =====

export interface RuntimeConfig {
  promptMode: "provider" | "local";
  autoMemoryReview: boolean;
  workspace: string;
  dataDir: string;
  toolsets: ToolsetId[];
  safetyMode: SafetyMode;
  browserCdpUrl?: string;
  computerEnabled?: boolean;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: "active" | "draft";
  source: "global" | "project";
}

export interface BrowserStatus {
  connected: boolean;
  cdpUrl: string;
  pageUrl?: string;
  title?: string;
  activeTabId?: string;
  message?: string;
}

export type BrowserTargetKind =
  | "css"
  | "role"
  | "text"
  | "label"
  | "placeholder"
  | "testId";

export interface BrowserTarget {
  kind: BrowserTargetKind;
  value: string;
  name?: string;
  exact?: boolean;
  index?: number;
}

export type BrowserLocator = string | BrowserTarget;

export interface BrowserActionOptions {
  tabId?: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  aria?: string;
  tabId?: string;
}

export interface BrowserScreenshot {
  url: string;
  title: string;
  path?: string;
  tabId?: string;
}

export interface ComputerStatus {
  enabled: boolean;
  available: boolean;
  platform: string;
  helperVersion?: string;
  message?: string;
}
