import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PdfReadResult {
  pages: number;
  extractedPages: number;
  text: string;
  truncated: boolean;
}

export interface PdfReadOptions {
  signal?: AbortSignal;
  maxPages?: number;
  maxChars?: number;
}

/** PDF is a document upload and follows the provider's 10 MB document limit. */
export const LOCAL_PDF_MAX_BYTES = 10_000_000;
const DEFAULT_MAX_PAGES = 50;
// Keep extracted PDF context bounded when it is combined with several file
// references in one Jimo request. The source PDF remains local and intact.
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;

function helperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pdf_extract.py");
}

export function isPdfDataUrl(value: string): boolean {
  return /^data:application\/pdf;base64,/i.test(value.trim());
}

function decodePdfDataUrl(value: string): Buffer {
  const match = /^data:application\/pdf;base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) throw new Error("PDF must be supplied as a base64 data URL");
  const encoded = match[1].replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("PDF data URL contains invalid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error("PDF content is empty");
  if (bytes.length > LOCAL_PDF_MAX_BYTES) {
    throw new Error("PDF exceeds the 10MB document limit");
  }
  return bytes;
}

export class LocalPdfReader {
  constructor(
    private readonly pythonCommand = process.env.YOOMCLAW_PYTHON?.trim() || "python",
  ) {}

  async read(value: string, options: PdfReadOptions = {}): Promise<PdfReadResult> {
    return this.readBytes(decodePdfDataUrl(value), options);
  }

  /** Parse PDF bytes directly, avoiding the 4/3 Base64 expansion in HTTP JSON. */
  async readBytes(bytes: Buffer, options: PdfReadOptions = {}): Promise<PdfReadResult> {
    if (bytes.length === 0) throw new Error("PDF content is empty");
    if (bytes.length > LOCAL_PDF_MAX_BYTES) {
      throw new Error("PDF exceeds the 10MB document limit");
    }
    const script = helperPath();
    if (!fs.existsSync(script)) throw new Error("Local PDF helper is missing");

    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const input = JSON.stringify({
      base64: bytes.toString("base64"),
      maxPages,
      maxChars,
    });

    return new Promise<PdfReadResult>((resolve, reject) => {
      const child = spawn(this.pythonCommand, [script], {
        cwd: path.dirname(script),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error("Local PDF parsing timed out")));
      }, DEFAULT_TIMEOUT_MS);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        child.kill();
        const reason = options.signal?.reason as { name?: unknown } | undefined;
        const message = reason?.name === "TimeoutError"
          ? "Local PDF parsing timed out"
          : "Local PDF parsing cancelled";
        finish(() => reject(new Error(message)));
      };

      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
          child.kill();
          finish(() => reject(new Error("Local PDF parser returned too much text")));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          let helperError = "";
          try {
            const parsed = JSON.parse(stdout) as { error?: unknown };
            if (typeof parsed.error === "string") helperError = parsed.error;
          } catch {
            // Prefer stderr or the generic message when stdout is not JSON.
          }
          return finish(() => reject(new Error(helperError || stderr.trim() || "Local PDF parser failed")));
        }
        try {
          const result = JSON.parse(stdout) as Partial<PdfReadResult> & { error?: string };
          if (result.error) throw new Error(result.error);
          if (typeof result.pages !== "number" || typeof result.extractedPages !== "number" || typeof result.text !== "string") {
            throw new Error("Local PDF parser returned an invalid result");
          }
          const pages = result.pages;
          const extractedPages = result.extractedPages;
          const text = result.text;
          const truncated = Boolean(result.truncated);
          finish(() => resolve({
            pages,
            extractedPages,
            text,
            truncated,
          }));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
      child.stdin.end(input, "utf8");
    });
  }
}
