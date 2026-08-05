import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type {
  DocumentRequest,
  DocumentReadResult,
  DocumentService,
  McpService,
  McpToolSummary,
  ToolServiceContext,
  VisionRequest,
  VisionService,
} from "@yoomclaw/agent-core";
import { resolveInWorkspace } from "@yoomclaw/agent-core";
import type { ChatMessage, ContentPart } from "@yoomclaw/protocol";
import { LocalPdfReader } from "./pdf-reader.js";
import type { VisionProvider } from "@yoomclaw/llm-provider";

const MAX_DOCUMENT_BYTES = 10_000_000;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_MAX_CHARS = 100_000;
const MAX_ATTACHMENT_CACHE = 64;
const ATTACHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface AttachmentRecord {
  url: string;
  fileName?: string;
  mimeType?: string;
  updatedAt: number;
}

/** Short-lived local mapping for provider file ids used by tool calls. */
export class AttachmentStore {
  private readonly records = new Map<string, AttachmentRecord>();

  remember(fileId: string, url: string, fileName?: string, mimeType?: string): void {
    if (!fileId || !url) return;
    this.records.set(fileId, { url, fileName, mimeType, updatedAt: Date.now() });
    while (this.records.size > MAX_ATTACHMENT_CACHE) {
      const oldest = [...this.records.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  get(fileId: string): AttachmentRecord | undefined {
    const record = this.records.get(fileId);
    if (!record) return undefined;
    if (Date.now() - record.updatedAt > ATTACHMENT_CACHE_TTL_MS) {
      this.records.delete(fileId);
      return undefined;
    }
    record.updatedAt = Date.now();
    return record;
  }
}

function mimeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls": return "application/vnd.ms-excel";
    case ".csv": return "text/csv";
    case ".html":
    case ".htm": return "text/html";
    case ".json": return "application/json";
    case ".xml": return "application/xml";
    default: return "application/octet-stream";
  }
}

function dataUrlToBytes(value: string): { bytes: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  return { bytes, mimeType: match[1] || "application/octet-stream" };
}

function imageDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function resolveRequestedPath(requested: string, context: ToolServiceContext): string {
  const resolved = resolveInWorkspace(context.workspace, requested, {
    allowOutsideWorkspace: context.safetyMode === "full-access",
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.resolved;
}

export function createVisionService(
  provider: VisionProvider | undefined,
  attachments: AttachmentStore,
): VisionService | undefined {
  if (!provider) return undefined;
  return {
    async analyze(request: VisionRequest, context: ToolServiceContext) {
      const parts: ContentPart[] = [];
      const imagePaths = request.paths ?? [];
      const imageIds = request.fileIds ?? [];
      const sources: Array<{ bytes: Buffer; mimeType: string; name: string }> = [];
      for (const requested of imagePaths) {
        const resolved = resolveRequestedPath(requested, context);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) throw new Error(`${requested} 不是文件`);
        if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`${requested} 超过 10MB 限制`);
        const extension = path.extname(resolved).toLowerCase();
        if (!mimeForExtension(extension).startsWith("image/")) throw new Error(`${requested} 不是支持的图片格式`);
        sources.push({ bytes: await fs.readFile(resolved), mimeType: mimeForExtension(extension), name: path.basename(resolved) });
      }
      for (const fileId of imageIds) {
        const record = attachments.get(fileId);
        if (!record) throw new Error(`找不到附件 ${fileId}`);
        const data = dataUrlToBytes(record.url);
        if (!data) throw new Error(`附件 ${fileId} 没有本地内容`);
        if (data.bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`附件 ${fileId} 超过 10MB 限制`);
        sources.push({ bytes: data.bytes, mimeType: record.mimeType ?? data.mimeType, name: record.fileName ?? fileId });
      }
      for (const source of sources) {
        parts.push({ type: "image_url", image_url: { url: imageDataUrl(source.bytes, source.mimeType) } });
      }
      parts.unshift({
        type: "text",
        text: request.prompt?.trim() || "请分析这些图片，提取可见文字并说明关键内容。",
      });
      const message: ChatMessage = { role: "user", content: parts };
      const text = await provider.analyze(message, context.sessionId, { signal: context.signal });
      return { text, metadata: { imageCount: sources.length, names: sources.map((source) => source.name) } };
    },
  };
}

function textDecode(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

function stripMarkup(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parseOfficeDocument(
  bytes: Buffer,
  fileName: string,
  request: DocumentRequest,
  signal?: AbortSignal,
): Promise<DocumentReadResult> {
  const configuredDir = process.env.YOOMCLAW_HELPER_DIR?.trim();
  const script = [
    configuredDir ? path.join(configuredDir, "document_extract.py") : "",
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "document_extract.py"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "document_extract.py"),
  ].filter(Boolean).find((candidate) => fsSync.existsSync(candidate));
  if (!script) throw new Error("文档解析 helper 缺失");
  const input = JSON.stringify({
    fileName,
    base64: bytes.toString("base64"),
    page: request.page,
    slide: request.slide,
    sheet: request.sheet,
    maxChars: Math.min(MAX_MAX_CHARS, Math.max(1000, request.maxChars ?? DEFAULT_MAX_CHARS)),
  });
  return new Promise((resolve, reject) => {
    const command = process.env.YOOMCLAW_PYTHON?.trim() || "python";
    const child = spawn(command, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("文档解析已取消")));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      if (code !== 0) return finish(() => reject(new Error(stderr.trim() || "文档解析失败")));
      try {
        const parsed = JSON.parse(stdout) as DocumentReadResult & { error?: string };
        if (parsed.error) throw new Error(parsed.error);
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    child.stdin.end(input, "utf8");
  });
}

export function createDocumentService(
  pdfReader: LocalPdfReader,
  attachments: AttachmentStore,
): DocumentService {
  return {
    async read(request: DocumentRequest, context: ToolServiceContext): Promise<DocumentReadResult> {
      let bytes: Buffer;
      let fileName = "document";
      if (request.path) {
        const resolved = resolveRequestedPath(request.path, context);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) throw new Error("路径不是文件");
        if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("文档超过 10MB 限制");
        bytes = await fs.readFile(resolved);
        fileName = path.basename(resolved);
      } else if (request.fileId) {
        const record = attachments.get(request.fileId);
        if (!record) throw new Error(`找不到附件 ${request.fileId}`);
        const data = dataUrlToBytes(record.url);
        if (!data) throw new Error("附件没有本地内容");
        if (data.bytes.length > MAX_DOCUMENT_BYTES) throw new Error("文档超过 10MB 限制");
        bytes = data.bytes;
        fileName = record.fileName ?? request.fileId;
      } else {
        throw new Error("path 和 fileId 至少提供一个");
      }
      const extension = path.extname(fileName).toLowerCase();
      const maxChars = Math.min(MAX_MAX_CHARS, Math.max(1000, request.maxChars ?? DEFAULT_MAX_CHARS));
      if (extension === ".doc") {
        throw new Error("暂不支持旧版 DOC，请转换为 DOCX 后重试");
      }
      if (extension === ".pdf") {
        const result = await pdfReader.readBytes(bytes, { signal: context.signal, maxChars });
        return {
          text: result.text.slice(0, maxChars),
          fileName,
          kind: "pdf",
          truncated: result.truncated || result.text.length > maxChars,
          metadata: {
            pages: result.pages,
            extractedPages: result.extractedPages,
            ...(request.page ? { page: request.page } : {}),
          },
        };
      }
      if ([".pptx", ".docx", ".xlsx", ".xls"].includes(extension)) {
        const result = await parseOfficeDocument(bytes, fileName, request, context.signal);
        return {
          ...result,
          metadata: {
            ...result.metadata,
            ...(request.slide ? { slide: request.slide } : {}),
            ...(request.sheet ? { sheet: request.sheet } : {}),
          },
        };
      }
      const raw = textDecode(bytes);
      const text = extension === ".html" || extension === ".htm" ? stripMarkup(raw) : raw;
      return {
        text: text.slice(0, maxChars),
        fileName,
        kind: extension.slice(1) || "text",
        truncated: text.length > maxChars,
      };
    },
  };
}

export function createHttpMcpService(): McpService | undefined {
  const endpoint = process.env.YOOMCLAW_MCP_URL?.trim();
  if (!endpoint) return undefined;
  const token = process.env.YOOMCLAW_MCP_TOKEN?.trim();
  const configuredName = process.env.YOOMCLAW_MCP_SERVER_NAME?.trim();
  let serverName = configuredName;
  if (!serverName) {
    try {
      serverName = new URL(endpoint).hostname.replace(/[^A-Za-z0-9_-]+/g, "_");
    } catch {
      serverName = "server";
    }
  }
  serverName = (serverName || "server").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "server";
  interface CachedTool {
    summary: McpToolSummary;
    remoteName: string;
  }
  let sequence = 0;
  let cache: { expiresAt: number; tools: CachedTool[] } | undefined;

  const call = async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("MCP 请求超时")), 15_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let body: { error?: { message?: string }; result?: unknown };
      if (contentType.includes("text/event-stream")) {
        const payload = (await response.text())
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line && line !== "[DONE]")
          .pop();
        if (!payload) throw new Error("MCP SSE 响应为空");
        body = JSON.parse(payload) as { error?: { message?: string }; result?: unknown };
      } else {
        body = await response.json() as { error?: { message?: string }; result?: unknown };
      }
      if (body.error) throw new Error(body.error.message || "MCP JSON-RPC error");
      return body.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const list = async (signal?: AbortSignal): Promise<CachedTool[]> => {
    if (cache && cache.expiresAt > Date.now()) return cache.tools;
    const result = await call("tools/list", {}, signal) as { tools?: unknown } | undefined;
    const tools = Array.isArray(result?.tools)
      ? result.tools.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => {
          const remoteName = typeof item.name === "string" ? item.name : "";
          return {
            remoteName,
            summary: {
              name: remoteName ? `mcp.${serverName}.${remoteName}` : "",
              description: typeof item.description === "string" ? item.description : "",
              parameters: item.inputSchema && typeof item.inputSchema === "object" ? item.inputSchema as Record<string, unknown> : { type: "object" },
              server: serverName,
            },
          };
        })
        .filter((item) => item.summary.name)
      : [];
    cache = { expiresAt: Date.now() + 30_000, tools };
    return tools;
  };

  return {
    async search(query, context) {
      const needle = query.toLocaleLowerCase();
      return (await list(context.signal))
        .map((tool) => tool.summary)
        .filter((tool) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(needle));
    },
    async invoke(name, args, context) {
      const available = await list(context.signal);
      const candidate = available.find((tool) => tool.summary.name === name || tool.remoteName === name);
      if (!candidate) return { result: `MCP 工具不存在或未被发现：${name}`, isError: true };
      const result = await call("tools/call", { name: candidate.remoteName, arguments: args }, context.signal) as { content?: unknown; isError?: unknown } | undefined;
      const content = Array.isArray(result?.content)
        ? result.content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : JSON.stringify(part)).join("\n")
        : JSON.stringify(result ?? {});
      return { result: content, isError: result?.isError === true };
    },
  };
}
