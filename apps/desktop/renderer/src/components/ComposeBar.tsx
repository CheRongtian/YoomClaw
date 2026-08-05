import {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
} from "react";
import {
  classifyFileInput,
  extractLocalFilePathCandidates,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
} from "@yoomclaw/protocol";
import { SendIcon, StopIcon, PaperclipIcon, CloseIcon } from "./icons";

export interface ComposePrefill {
  text: string;
  nonce: number;
}

export interface ComposeAttachment {
  file: File;
  /** Native path when this File is backed by a local desktop file. */
  path?: string;
  /** True when the file is kept for local file operations without uploading its bytes. */
  pathOnly?: boolean;
}

interface Props {
  onSend: (text: string, files: ComposeAttachment[]) => boolean | Promise<boolean>;
  onStop: () => void;
  disabled?: boolean;
  ready?: boolean;
  creating?: boolean;
  streaming: boolean;
  prefill?: ComposePrefill | null;
  draftKey?: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getNativeFilePath(file: File): string | undefined {
  try {
    const nativePath = window.yoomclaw?.getPathForFile?.(file);
    if (typeof nativePath === "string" && nativePath.trim()) return nativePath;
  } catch {
    // Browser mode and synthetic test files do not have a native path.
  }
  // Keep compatibility with older Electron versions that augmented File with
  // a non-standard `path` property.
  const legacyPath = (file as File & { path?: unknown }).path;
  return typeof legacyPath === "string" && legacyPath.trim() ? legacyPath : undefined;
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function clipboardLocalPaths(data: DataTransfer): string[] {
  const values: string[] = [];
  for (const format of ["text/uri-list", "text/plain"]) {
    try {
      const value = data.getData(format);
      if (value) values.push(value);
    } catch {
      // Some browser clipboard implementations reject unsupported formats.
    }
  }
  return [...new Set(values.flatMap((value) => extractLocalFilePathCandidates(value)))];
}

async function nativeClipboardLocalPaths(): Promise<string[]> {
  try {
    const paths = await window.yoomclaw?.getClipboardFilePaths?.();
    return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string") : [];
  } catch {
    // Browser mode and platforms without native file clipboard formats fall
    // back to the paths exposed by the ClipboardEvent itself.
    return [];
  }
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).pop() || normalized || "local-file";
}

function formatRejection(fileName: string, code: string | undefined, maxBytes?: number): string {
  if (code === "FILE_TOO_LARGE" && maxBytes !== undefined) {
    return `${fileName}（文件过大，单个上限 ${formatSize(maxBytes)}）`;
  }
  if (code === "TOO_MANY_IMAGES") return `${fileName}（单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片）`;
  if (code === "TOO_MANY_FILES") return `${fileName}（单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件）`;
  if (code === "UNSUPPORTED_FILE_TYPE") return `${fileName}（不支持的文件类型）`;
  return `${fileName}（${code ?? "文件不可用"}）`;
}

export default function ComposeBar({ onSend, onStop, disabled, ready = true, creating = false, streaming, prefill, draftKey }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const prevStreaming = useRef(streaming);
  const focusPendingRef = useRef(false);
  const previousDraftKeyRef = useRef<string | null>(draftKey ?? null);
  const draftKeyRef = useRef<string | null>(draftKey ?? null);
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  draftKeyRef.current = draftKey ?? null;
  textRef.current = text;
  attachmentsRef.current = attachments;

  const focusTextarea = useCallback(() => {
    if (disabled) return;
    const focusInput = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      if (document.activeElement === textarea) focusPendingRef.current = false;
    };
    const focusWindow = window.yoomclaw?.focusWindow;
    if (focusWindow) {
      void focusWindow().then(focusInput, focusInput);
    } else {
      focusInput();
    }
  }, [disabled]);

  useEffect(() => {
    const saved = draftKey ? localStorage.getItem(`yoomclaw:draft:${draftKey}`) : null;
    const previousDraftKey = previousDraftKeyRef.current;
    const carryingPendingCompose = previousDraftKey === null && Boolean(draftKey) && saved === null;
    if (!carryingPendingCompose) setText(saved ?? "");
    if (!carryingPendingCompose) setAttachments([]);
    previousDraftKeyRef.current = draftKey ?? null;
    focusPendingRef.current = Boolean(draftKey) || creating;
    if ((!draftKey && !creating) || disabled) return;
    const frame = window.requestAnimationFrame(focusTextarea);
    return () => window.cancelAnimationFrame(frame);
  }, [draftKey, disabled, creating, focusTextarea]);

  useEffect(() => {
    const handleWindowFocus = () => {
      if (!focusPendingRef.current) return;
      window.requestAnimationFrame(focusTextarea);
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [focusTextarea]);

  useEffect(() => {
    if (!draftKey) return;
    const key = `yoomclaw:draft:${draftKey}`;
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  }, [draftKey, text]);

  // 回复结束后自动聚焦输入框，用户无需再次点击即可继续打字
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      focusTextarea();
    }
    prevStreaming.current = streaming;
  }, [streaming, focusTextarea]);

  // 外部预填（空状态建议 chip 点击后把提示词放进输入框）
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    const ta = textareaRef.current;
    if (ta) {
      focusTextarea();
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [prefill, focusTextarea]);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (
      (!trimmed && attachments.length === 0) ||
      disabled ||
      !ready ||
      streaming ||
      submitting
    ) return;
    const textAtSubmit = text;
    const attachmentsAtSubmit = attachments;
    const draftKeyAtSubmit = draftKeyRef.current;
    setSubmitting(true);
    try {
      const accepted = await onSend(trimmed, attachmentsAtSubmit);
      if (!accepted) return;
      if (
        draftKeyRef.current === draftKeyAtSubmit &&
        textRef.current === textAtSubmit &&
        attachmentsRef.current === attachmentsAtSubmit
      ) {
        setText("");
        setAttachments([]);
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming || submitting) return;
      void handleSubmit();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const addAttachments = (files: File[], explicitPaths: string[] = []) => {
    if (!files.length) return;
    setAttachments((prev) => {
      const available = Math.max(0, MAX_FILES_PER_MESSAGE - prev.length);
      const existingImageCount = prev.reduce((count, attachment) => (
        count + (classifyFileInput(attachment.file.name, attachment.file.size, attachment.file.type).kind === "image" ? 1 : 0)
      ), 0);
      const accepted: ComposeAttachment[] = [];
      const rejected: string[] = [];
      let acceptedImageCount = 0;
      for (const [index, file] of files.entries()) {
        const explicitPath = explicitPaths[index];
        const nativePath = getNativeFilePath(file);
        const localPath = nativePath ?? explicitPath;
        const descriptor = classifyFileInput(file.name, file.size, file.type);
        // A native desktop path is useful even when the provider upload policy
        // rejects the bytes (for example .txt, .zip or an oversized file).
        // Keep that attachment as path-only so file-operation requests still
        // reach the Agent.
        if (!descriptor.accepted && !localPath) {
          rejected.push(formatRejection(file.name, descriptor.rejectionCode, descriptor.maxBytes));
          continue;
        }
        if (descriptor.accepted && descriptor.kind === "image" && existingImageCount + acceptedImageCount >= MAX_IMAGES_PER_MESSAGE) {
          rejected.push(formatRejection(file.name, "TOO_MANY_IMAGES"));
          continue;
        }
        if (accepted.length >= available) {
          rejected.push(formatRejection(file.name, "TOO_MANY_FILES"));
          continue;
        }
        accepted.push({
          file,
          path: localPath,
          // A pasted Explorer file can have real bytes and an explicit path
          // even when webUtils cannot resolve the File object. Upload those
          // bytes as usual; reserve path-only mode for rejected/empty files.
          pathOnly: Boolean(localPath && (!descriptor.accepted || file.size === 0)),
        });
        if (descriptor.accepted && descriptor.kind === "image") acceptedImageCount += 1;
      }
      setAttachmentNotice(
        rejected.length > 0
          ? `已忽略 ${rejected.length} 个附件：${rejected.join("、")}`
          : null,
      );
      return [...prev, ...accepted];
    });
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    addAttachments(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (disabled || streaming) return;
    const files = clipboardFiles(e.clipboardData);
    const eventPaths = clipboardLocalPaths(e.clipboardData);
    const hasNativeFiles = Array.from(e.clipboardData.types).includes("Files");
    const attachFiles = (localPaths: string[]) => {
      const paths = [...new Set([...eventPaths, ...localPaths])];
      const explicitPaths = files.map((file) => {
        const fileName = file.name.toLocaleLowerCase();
        return paths.find((filePath) => fileNameFromPath(filePath).toLocaleLowerCase() === fileName)
          ?? (files.length === 1 ? paths[0] : "");
      });
      addAttachments(files, explicitPaths);
    };
    if (files.length > 0) {
      e.preventDefault();
      void nativeClipboardLocalPaths().then(attachFiles);
      return;
    }
    if (eventPaths.length > 0) {
      e.preventDefault();
      addAttachments(
        eventPaths.map((filePath) => new File([], fileNameFromPath(filePath), { type: "application/octet-stream" })),
        eventPaths,
      );
      return;
    }
    // Explorer may expose only the native file-drop format. Prevent the
    // browser's default paste and ask the main process for those paths.
    if (!hasNativeFiles) return;
    e.preventDefault();
    void nativeClipboardLocalPaths().then((paths) => {
      if (paths.length === 0) return;
      addAttachments(
        paths.map((filePath) => new File([], fileNameFromPath(filePath), { type: "application/octet-stream" })),
        paths,
      );
    });
  };

  const hasFiles = (e: DragEvent<HTMLDivElement>) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const clearDragState = () => {
    dragDepthRef.current = 0;
    setDragActive(false);
  };

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || streaming || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || streaming || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !streaming) {
      addAttachments(Array.from(e.dataTransfer.files));
    }
    clearDragState();
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const canSend = (text.trim() || attachments.length > 0) && !disabled && ready && !streaming && !submitting;

  return (
    <div
      className={`compose-bar${dragActive ? " is-drag-active" : ""}`}
      data-testid="compose-bar"
      onPaste={handlePaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="compose-attachments">
          {attachments.map((attachment, i) => (
            <span className="attach-chip" data-testid="attachment-chip" data-attachment-index={i} key={`${attachment.file.name}-${i}`} title={attachment.path ?? attachment.file.name} style={{ animationDelay: `${Math.min(i, 5) * 24}ms` }}>
              <span className="attach-name">{attachment.file.name}</span>
              <span className="attach-size">{attachment.pathOnly ? "仅路径" : formatSize(attachment.file.size)}</span>
              <button
                type="button"
                className="attach-remove"
                data-testid="attachment-remove"
                data-attachment-index={i}
                onClick={() => removeAttachment(i)}
                aria-label={`移除 ${attachment.file.name}`}
                title="移除"
              >
                <CloseIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="compose-inner">
        {dragActive && (
          <div className="drop-overlay" aria-live="polite">
            <PaperclipIcon size={22} />
            <span>松开以上传文件</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="compose-input"
          data-testid="compose-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onFocus={() => { focusPendingRef.current = false; }}
          placeholder={
            disabled
              ? "请先选择或新建对话..."
              : creating
                ? "姝ｅ湪鍒涘缓瀵硅瘽鈥﹀彲浠ュ厛杈撳叆娑堟伅"
              : !draftKey
                ? "\u53ef\u4ee5\u5148\u8f93\u5165\uff0c\u521b\u5efa\u5bf9\u8bdd\u540e\u53d1\u9001"
                : ready
                ? "给 YoomClaw 发送消息…"
                : "正在连接…可以先输入消息"
          }
          rows={1}
          disabled={disabled}
        />
        <div className="compose-toolbar">
          <button
            type="button"
            className="tool-btn"
            data-testid="attachment-add"
            onClick={() => fileInputRef.current?.click()}
            title="添加附件"
            aria-label="添加附件"
          >
            <PaperclipIcon size={20} />
          </button>
          {/* The desktop path is also valid when the provider cannot upload the bytes. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={handleFileChange}
          />
          {streaming ? (
            <button className="stop-btn" data-testid="message-stop" onClick={onStop} title="停止生成" aria-label="停止生成">
              <StopIcon size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              data-testid="message-send"
              onClick={handleSubmit}
              disabled={!canSend}
              title="发送 (Enter)"
              aria-label="发送"
            >
              <SendIcon size={16} />
            </button>
          )}
        </div>
      </div>

      {attachmentNotice && (
        <div className="attachment-notice" role="status" aria-live="polite">
          {attachmentNotice}
        </div>
      )}

      <div className="compose-footer">
        <span className="footer-note">
          Enter 发送 · Shift+Enter 换行 · YoomClaw 可能产生不准确的信息
        </span>
      </div>

      <style jsx>{`
        .compose-bar {
          position: relative;
          z-index: 2;
          padding: 10px var(--chat-content-gutter) 8px;
          flex-shrink: 0;
          background: var(--bg);
        }
        .compose-inner {
          width: 100%;
          max-width: var(--chat-content-width);
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: var(--composer-bg);
          border-radius: 12px;
          padding: 12px 12px 10px;
          border: 1px solid var(--composer-border);
          position: relative;
          transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-emphasized);
          animation: yc-fade-up var(--motion-normal) var(--ease-standard) both;
        }
        .compose-bar.is-drag-active .compose-inner {
          border-color: var(--composer-focus-border);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--composer-focus-border) 18%, transparent);
        }
        .drop-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border-radius: 11px;
          border: 1px dashed var(--composer-focus-border);
          background: color-mix(in srgb, var(--composer-bg) 94%, transparent);
          color: var(--text);
          font-size: 14px;
          pointer-events: none;
          animation: yc-fade-up 180ms var(--ease-standard) both;
        }
        .compose-inner:focus-within {
          border-color: var(--composer-focus-border);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--composer-focus-border) 18%, transparent);
          transform: translateY(-1px);
        }
        .compose-input {
          width: 100%;
          border: none;
          background: transparent;
          color: var(--text);
          font-family: inherit;
          font-size: 14px;
          line-height: 1.5;
          resize: none;
          outline: none;
          max-height: 200px;
          overflow-y: auto;
        }
        .compose-input::placeholder { color: var(--text-muted); }
        .compose-input:disabled { cursor: not-allowed; opacity: 0.5; }
        /* 工具行：附件居左，发送/停止居右 */
        .compose-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .tool-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);
        }
        .tool-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .send-btn, .stop-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: background var(--motion-fast) var(--ease-standard), filter var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-emphasized);
        }
        .send-btn {
          background: var(--send-bg);
          color: var(--send-fg);
        }
        .send-btn:hover:not(:disabled) {
          background: var(--send-bg-hover);
          box-shadow: 0 5px 16px color-mix(in srgb, var(--primary) 22%, transparent);
        }
        .send-btn:disabled {
          background: var(--bg-element);
          color: var(--text-muted);
          cursor: not-allowed;
        }
        .stop-btn {
          background: var(--error);
          color: var(--on-error);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--error) 12%, transparent);
        }
        .stop-btn:hover {
          filter: brightness(1.08);
        }
        .compose-attachments {
          width: 100%;
          max-width: var(--chat-content-width);
          margin: 0 auto 6px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .attach-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: 240px;
          padding: 5px 8px 5px 12px;
          border-radius: 999px;
          background: var(--bg-element);
          border: 1px solid var(--border);
          animation: yc-fade-up 200ms var(--ease-standard) both;
        }
        .attach-name {
          font-size: 12px;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 150px;
        }
        .attach-size {
          font-size: 10.5px;
          color: var(--text-muted);
        }
        .attach-remove {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-size: 15px;
          line-height: 1;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-emphasized);
        }
        .attach-remove:hover {
          background: var(--bg-panel);
          color: var(--text);
        }
        .attach-remove :global(svg) { display: block; }
        .compose-footer {
          width: 100%;
          max-width: var(--chat-content-width);
          margin: 6px auto 0;
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
        .attachment-notice {
          width: 100%;
          max-width: var(--chat-content-width);
          margin: 4px auto 0;
          color: var(--warning, #d97706);
          font-size: 11px;
          line-height: 1.4;
          animation: yc-fade-up 180ms var(--ease-standard) both;
        }
      `}</style>
    </div>
  );
}
