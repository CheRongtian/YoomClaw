import type {
  FileUploadRequest,
  FileUploadResponse,
} from "@yoomclaw/protocol";

export interface ImageHostConfig {
  /** Multipart upload endpoint for public images/documents. */
  uploadUrl: string;
  /** Upload token. This must stay inside the Gateway process. */
  uploadToken: string;
  /** Maximum decoded image size accepted before contacting the image host. */
  maxBytes?: number;
}

export interface ImageHostUploadPayload {
  ok?: boolean;
  url?: string;
  filename?: string;
  size?: number;
  expires_at?: string | null;
  error?: string;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  ...IMAGE_MIME_TYPES,
  "application/pdf",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
};

export function dataUrlMimeType(value: string): string | undefined {
  const match = /^data:([^;,]+);base64,/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

export function isImageDataUrl(value: string): boolean {
  const mimeType = dataUrlMimeType(value);
  return mimeType ? IMAGE_MIME_TYPES.has(mimeType) : false;
}

export function isHostableDataUrl(value: string): boolean {
  const mimeType = dataUrlMimeType(value);
  return mimeType ? ALLOWED_UPLOAD_MIME_TYPES.has(mimeType) : false;
}

function decodeImageDataUrl(value: string): { mimeType: string; bytes: Buffer } {
  const trimmed = value.trim();
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Image input must be a base64 data URL");
  }

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new Error("Only PNG, JPEG, GIF, WEBP, BMP, or PDF files are supported");
  }

  const encoded = match[2].replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Image data URL contains invalid base64");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    throw new Error("Image data is empty");
  }
  return { mimeType, bytes };
}

function safeUploadFileName(fileName: string | undefined, mimeType: string): string {
  const original = (fileName ?? "image").split(/[\\/]/).pop() || "image";
  const sanitized = original.replace(/[^A-Za-z0-9._-]/g, "_") || "image";
  if (/\.[A-Za-z0-9]{2,5}$/.test(sanitized)) return sanitized;
  return sanitized + (MIME_EXTENSIONS[mimeType] ?? ".png");
}

function toFileUploadResponse(
  request: FileUploadRequest,
  payload: ImageHostUploadPayload,
  fallbackFileName: string,
): FileUploadResponse {
 if (!payload.url || !payload.filename) {
   throw new Error(payload.error || "Image host did not return a valid HTTPS image URL");
 }
  let isHttpsUrl = false;
  try {
    isHttpsUrl = new URL(payload.url).protocol === "https:";
  } catch {
    // Treat malformed URLs as invalid image-host responses.
  }
  if (!isHttpsUrl) {
    throw new Error("Image host must return an HTTPS image URL");
  }

 const now = Date.now();
  return {
    id: 0,
    source: request.source ?? "api",
    processId: null,
    fileName: payload.filename || fallbackFileName,
    fileId: payload.filename || fallbackFileName,
    type: 1,
    url: payload.url,
    content: null,
    extra: JSON.stringify({
      provider: "image-host",
      size: payload.size ?? null,
      expiresAt: payload.expires_at ?? null,
    }),
    createAt: now,
    updateAt: now,
    deleted: false,
  };
}

/**
 * Uploads renderer-provided image/document data URLs to the existing
 * self-hosted host. The returned URL is public HTTPS and can be passed to
 * the main Jimo agent.
 */
export class ImageHostClient {
  constructor(private readonly config: ImageHostConfig) {}

  async upload(
    request: FileUploadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileUploadResponse> {
    const decoded = decodeImageDataUrl(request.url);
    const maxBytes = this.config.maxBytes ?? DEFAULT_MAX_BYTES;
    if (decoded.bytes.length > maxBytes) {
      throw new Error("Image exceeds the configured image-host size limit");
    }

    const fileName = safeUploadFileName(request.fileName, decoded.mimeType);
    const form = new FormData();
    form.append(
      "file",
      new Blob([decoded.bytes], { type: decoded.mimeType }),
      fileName,
    );

    const response = await fetch(this.config.uploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Upload-Token": this.config.uploadToken,
      },
      body: form,
      signal: options?.signal,
    });

    const payload = await response.json().catch(() => ({})) as ImageHostUploadPayload;
    if (!response.ok) {
      throw new Error(
        "Image host upload failed (HTTP " + response.status + "): " +
        (payload.error || response.statusText || "Unknown error"),
      );
    }

    return toFileUploadResponse(request, payload, fileName);
  }
}
