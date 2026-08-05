/**
 * The file-input contract shared by the renderer, Gateway and test harness.
 *
 * The limits intentionally use decimal megabytes. Document/image/audio limits
 * mirror the provider's user-facing upload policy. Video uses an effective
 * transport-safe cap because Jimo receives the file as a base64 data URL
 * embedded in JSON; the advertised 120M raw-file limit produced an upstream
 * 413 for a 42.4M file in the current deployment.
 */

export type FileInputKind = "document" | "image" | "audio" | "video";

export type FileInputRejectionCode =
  | "TOO_MANY_FILES"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_SIZE";

export interface FileInputRule {
  readonly kind: FileInputKind;
  readonly maxBytes: number;
  readonly extensions: readonly string[];
}

export interface FileInputDescriptor {
  readonly fileName: string;
  readonly extension: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly kind?: FileInputKind;
  readonly accepted: boolean;
  readonly rejectionCode?: FileInputRejectionCode;
  readonly maxBytes?: number;
}

export const MAX_FILES_PER_MESSAGE = 10;
/** The upstream multimodal endpoint accepts at most ten image parts per message. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * Keep the base64 JSON request comfortably below the upstream request limit.
 * This value is shared by the renderer, Gateway and live test harness.
 */
export const MAX_VIDEO_UPLOAD_BYTES = 30_000_000;

export const FILE_INPUT_RULES = {
  document: {
    kind: "document",
    maxBytes: 10_000_000,
    extensions: [
      "pdf",
      "pptx",
      "doc",
      "docx",
      "xlsx",
      "xls",
      "html",
      "csv",
      "json",
      "xml",
      "md",
    ],
  },
  image: {
    kind: "image",
    maxBytes: 10_000_000,
    extensions: ["png", "jpeg", "jpg", "webp"],
  },
  audio: {
    kind: "audio",
    maxBytes: 30_000_000,
    extensions: [
      "aac",
      "amr",
      "flac",
      "m4a",
      "mp3",
      "mpeg",
      "ogg",
      "opus",
      "wav",
      "wma",
      "3gp",
      "mpeg4",
    ],
  },
  video: {
    kind: "video",
    maxBytes: MAX_VIDEO_UPLOAD_BYTES,
    extensions: ["mp4", "avi", "mkv", "mov", "webm", "flv", "wmv"],
  },
} as const satisfies Record<FileInputKind, FileInputRule>;

export const FILE_INPUT_ACCEPT = Object.values(FILE_INPUT_RULES)
  .flatMap((rule) => rule.extensions.map((extension) => `.${extension}`))
  .join(",");

const RULE_BY_EXTENSION = new Map<string, FileInputRule>(
  Object.values(FILE_INPUT_RULES).flatMap((rule) =>
    rule.extensions.map((extension) => [extension, rule] as const),
  ),
);

export function normalizeFileExtension(fileName: string): string {
  const baseName = fileName.trim().split(/[\\/]/).pop() ?? "";
  const dot = baseName.lastIndexOf(".");
  return dot >= 0 ? baseName.slice(dot + 1).toLowerCase() : "";
}

export function getFileInputRule(fileName: string): FileInputRule | undefined {
  return RULE_BY_EXTENSION.get(normalizeFileExtension(fileName));
}

export function classifyFileInput(
  fileName: string,
  sizeBytes: number,
  mimeType?: string,
): FileInputDescriptor {
  const extension = normalizeFileExtension(fileName);
  const rule = RULE_BY_EXTENSION.get(extension);
  const normalizedSize = Number.isFinite(sizeBytes) ? sizeBytes : -1;
  const base = {
    fileName,
    extension,
    mimeType: mimeType?.trim().toLowerCase() || undefined,
    sizeBytes: normalizedSize,
  };

  if (normalizedSize < 0) {
    return {
      ...base,
      accepted: false,
      rejectionCode: "INVALID_FILE_SIZE",
    };
  }
  if (!rule) {
    return {
      ...base,
      accepted: false,
      rejectionCode: "UNSUPPORTED_FILE_TYPE",
    };
  }
  if (normalizedSize > rule.maxBytes) {
    return {
      ...base,
      kind: rule.kind,
      maxBytes: rule.maxBytes,
      accepted: false,
      rejectionCode: "FILE_TOO_LARGE",
    };
  }
  return {
    ...base,
    kind: rule.kind,
    maxBytes: rule.maxBytes,
    accepted: true,
  };
}

export function countAttachmentParts(
  content: unknown,
): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return type === "image_url" || type === "file_url";
  }).length;
}

export function countImageAttachmentParts(
  content: unknown,
): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => {
    if (!part || typeof part !== "object") return false;
    return (part as { type?: unknown }).type === "image_url";
  }).length;
}

const LOCAL_PATH_TRAILING_PUNCTUATION = /[.,;:!?()\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09\u3011\u300B\]\}]+$/u;

function normalizeLocalPathToken(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/gu, "");
  if (!/^file:/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);
    // file:///C:/... is the clipboard form used by Windows browsers.
    if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1).replace(/\//g, "\\");
    if (url.hostname && url.hostname !== "localhost") {
      pathname = `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    return pathname;
  } catch {
    return trimmed;
  }
}

function isLocalPathLike(value: string): boolean {
  if (/^file:/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^\\\\/.test(value) ||
    /^\/{1}(?!\/)/.test(value) ||
    /^\.{0,2}[\\/]/.test(value)
  );
}

/**
 * Find explicit local file paths in user text without treating arbitrary URLs
 * or prose as attachments. Paths containing spaces must be quoted.
 */
export function extractLocalFilePathCandidates(text: string): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const paths = new Set<string>();
  const add = (raw: string): void => {
    let candidate = normalizeLocalPathToken(raw);
    candidate = candidate.replace(/^[([{<]+/u, "");
    candidate = candidate.replace(LOCAL_PATH_TRAILING_PUNCTUATION, "");
    if (!candidate || !isLocalPathLike(candidate)) return;
    paths.add(candidate);
  };

  const quoted = /(["'])(.*?)\1/g;
  for (const match of text.matchAll(quoted)) add(match[2] ?? "");

  // Unquoted paths intentionally stop at whitespace; quote paths containing spaces.
  const unquoted = /(?:file:\/\/{0,3}|[a-z]:[\\/]|\\\\|\/(?!\/)|\.{1,2}[\\/])[^\s"'<>]+/gi;
  for (const match of text.replace(quoted, " ").matchAll(unquoted)) add(match[0] ?? "");
  return [...paths];
}
