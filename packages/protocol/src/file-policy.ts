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
