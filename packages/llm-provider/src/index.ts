/**
 * @yoomclaw/llm-provider - LLM Provider Abstraction Layer
 *
 * Supports the JimoAI SSE format defined in api.md:
 *   POST /v2/chat/completions/share?shareId=xxx
 *   Authorization: <token>
 *   Body: { messages, sessionId, source, extra }
 *   Response: SSE stream with event:data / event:end
 */

import type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionChunk,
  FileUploadRequest,
  FileUploadResponse,
} from "@yoomclaw/protocol";

// ===== Provider Interface =====

/** 上游返回的流式片段：正文增量，或执行节点进度。 */
export type ProviderChunk =
  | { kind: "content"; content: string }
  | { kind: "progress"; name: string; percent: number; status: number };

export interface LLMProvider {
  /** Provider id (e.g. "jimo"). */
  readonly id: string;

  /** Send a chat completion request, return an async iterable of chunks. */
  chat(
    request: ChatCompletionRequest,
    options?: LLMRequestOptions,
  ): AsyncIterable<ProviderChunk>;

  /** Upload a file and get a fileId back. */
  uploadFile(
    request: FileUploadRequest,
    options?: LLMRequestOptions,
  ): Promise<FileUploadResponse>;
}

export interface LLMRequestOptions {
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional bearer token override. */
  authorization?: string;
  /** Optional shareId override. */
  shareId?: string;
}

// ===== JimoAI Provider =====

export interface JimoProviderConfig {
  /** Base URL, e.g. https://jimoai-bot-api.xiaohuodui.cn */
  baseUrl: string;
  /** Share ID from the platform. */
  shareId: string;
  /** Authorization token. */
  authorization: string;
}

export class JimoProvider implements LLMProvider {
  readonly id = "jimo";

  constructor(private config: JimoProviderConfig) {}

  /**
   * Send chat completion and stream SSE chunks.
   *
   * The JimoAI API returns SSE events like:
   *   data: {"role":"assistant","content":"..."}
   *   event: data
   *
   *   data: {'end':{},'role':'assistant'}
   *   event: end
   */
  async *chat(
    request: ChatCompletionRequest,
    options?: LLMRequestOptions,
  ): AsyncIterable<ProviderChunk> {
    const url = new URL("/v2/chat/completions/share", this.config.baseUrl);
    url.searchParams.set(
      "shareId",
      options?.shareId ?? this.config.shareId,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: options?.authorization ?? this.config.authorization,
      Accept: "text/event-stream",
    };

    const body = JSON.stringify({
      messages: request.messages,
      sessionId: request.sessionId,
      source: request.source ?? "api",
      extra: request.extra ?? {},
    });

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `JimoAPI error ${response.status}: ${text || response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error("JimoAPI: no response body");
    }

    // Parse SSE stream manually
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 归一化换行：SSE 规范允许 CRLF，若不处理则按 \n\n 切分永远切不出事件
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        // SSE events are separated by \n\n
        const events = buffer.split("\n\n");
        // Keep the last incomplete chunk in buffer
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const parsed = parseSSEEvent(rawEvent);
          if (!parsed) continue;

          if (parsed.event === "end") {
            return; // Stream finished
          }

          if (parsed.event === "data") {
            try {
              const chunk = JSON.parse(parsed.data) as ChatCompletionChunk;
              if (chunk.role === "assistant" && typeof chunk.content === "string") {
                yield { kind: "content", content: chunk.content };
              }
            } catch {
              // Skip malformed JSON
            }
          } else if (parsed.event === "event") {
            // 积墨的执行节点进度，形如
            // {"node":"chat_entrance_v3","name":"开始","percent":33,"status":0}
            try {
              const node = JSON.parse(parsed.data) as {
                name?: string;
                percent?: number;
                status?: number;
              };
              if (typeof node.name === "string") {
                yield {
                  kind: "progress",
                  name: node.name,
                  percent: typeof node.percent === "number" ? node.percent : 0,
                  status: typeof node.status === "number" ? node.status : 0,
                };
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Upload a file via /v2/upload/file/share */
  async uploadFile(
    request: FileUploadRequest,
    options?: LLMRequestOptions,
  ): Promise<FileUploadResponse> {
    const url = new URL("/v2/upload/file/share", this.config.baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: options?.authorization ?? this.config.authorization,
    };

    const body = JSON.stringify({
      url: request.url,
      source: request.source ?? "api",
    });

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `JimoAPI upload error ${response.status}: ${text || response.statusText}`,
      );
    }

    return (await response.json()) as FileUploadResponse;
  }
}

// ===== SSE Parser =====

interface SSEParsedEvent {
  event: string;
  data: string;
}

function parseSSEEvent(raw: string): SSEParsedEvent | null {
  let event = "message";
  let data = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // 空行与注释行（如积墨的心跳 ":probe"）直接跳过
    if (!trimmed || trimmed.startsWith(":")) continue;

    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      // data can span multiple lines; concatenate with \n
      const dataLine = trimmed.slice(5).trim();
      data = data ? data + "\n" + dataLine : dataLine;
    }
  }

  if (!data) return null;
  return { event, data };
}

// ===== Provider Factory =====

export type ProviderConfig = JimoProviderConfig;

export function createProvider(
  type: "jimo",
  config: ProviderConfig,
): LLMProvider;

export function createProvider(type: string, config: unknown): LLMProvider;

export function createProvider(
  type: string,
  config: unknown,
): LLMProvider {
  switch (type) {
    case "jimo":
      return new JimoProvider(config as JimoProviderConfig);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

// ===== Helpers =====

/** Build a simple text-only ChatMessage. */
export function textMessage(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return { role, content };
}

/** Build a multimodal message with image. */
export function imageMessage(
  role: ChatMessage["role"],
  text: string,
  imageUrl: string,
): ChatMessage {
  return {
    role,
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
}

/** Build a file-attached message. */
export function fileMessage(
  role: ChatMessage["role"],
  text: string,
  fileUrl: string,
  fileId: string,
): ChatMessage {
  return {
    role,
    content: [
      { type: "text", text },
      { type: "file_url", file_url: { url: fileUrl, fileId } },
    ],
  };
}
