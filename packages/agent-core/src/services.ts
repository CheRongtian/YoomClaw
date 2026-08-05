import type { PlanState, SafetyMode } from "@yoomclaw/protocol";

/** Stable context passed to optional services used by advanced built-in tools. */
export interface ToolServiceContext {
  sessionId: string;
  workspace: string;
  dataDir?: string;
  safetyMode?: SafetyMode;
  signal?: AbortSignal;
}

export interface PlanStore {
  get(sessionId: string): PlanState | undefined;
  set(sessionId: string, plan: PlanState): void | Promise<void>;
}

export interface VisionRequest {
  paths?: string[];
  fileIds?: string[];
  prompt?: string;
}

export interface VisionService {
  analyze(
    request: VisionRequest,
    context: ToolServiceContext,
  ): Promise<{ text: string; metadata?: Record<string, unknown> }>;
}

export interface DocumentRequest {
  path?: string;
  fileId?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  maxChars?: number;
}

export interface DocumentReadResult {
  text: string;
  fileName?: string;
  kind?: string;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DocumentService {
  read(
    request: DocumentRequest,
    context: ToolServiceContext,
  ): Promise<DocumentReadResult>;
}

export interface WebFetchRequest {
  url: string;
  maxChars?: number;
}

export interface WebFetchResult {
  url: string;
  title?: string;
  text: string;
  truncated?: boolean;
}

export interface WebSearchRequest {
  query: string;
  domains?: string[];
  limit?: number;
  recency?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
}

export interface WebService {
  fetch(request: WebFetchRequest, context: ToolServiceContext): Promise<WebFetchResult>;
  search?(request: WebSearchRequest, context: ToolServiceContext): Promise<WebSearchResult[]>;
}

export interface CodeRunRequest {
  language: "javascript" | "python";
  code: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export interface CodeRunner {
  run(request: CodeRunRequest, context: ToolServiceContext): Promise<CodeRunResult>;
}

export interface ParallelCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface SubagentRequest {
  task: string;
  toolsets?: string[];
}

export interface SubagentResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  files?: string[];
}

export interface SubagentService {
  delegate(request: SubagentRequest, context: ToolServiceContext): Promise<SubagentResult>;
}

export interface McpToolSummary {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  server?: string;
}

export interface McpService {
  search(query: string, context: ToolServiceContext): Promise<McpToolSummary[]>;
  invoke(
    name: string,
    args: Record<string, unknown>,
    context: ToolServiceContext,
  ): Promise<{ result: string; isError?: boolean }>;
}

export interface TrashService {
  move(filePath: string): Promise<void>;
}

export interface ToolServices {
  trash?: TrashService;
  planStore?: PlanStore;
  vision?: VisionService;
  documents?: DocumentService;
  web?: WebService;
  codeRunner?: CodeRunner;
  subagents?: SubagentService;
  mcp?: McpService;
}
