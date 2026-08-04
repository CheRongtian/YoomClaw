import {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
  ChangeEvent,
  DragEvent,
} from "react";
import {
  classifyFileInput,
  FILE_INPUT_ACCEPT,
  MAX_FILES_PER_MESSAGE,
} from "@yoomclaw/protocol";
import { SendIcon, StopIcon, PaperclipIcon, CloseIcon } from "./icons";

export interface ComposePrefill {
  text: string;
  nonce: number;
}

interface Props {
  onSend: (text: string, files: File[]) => boolean | Promise<boolean>;
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

export default function ComposeBar({ onSend, onStop, disabled, ready = true, creating = false, streaming, prefill, draftKey }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
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

  const addAttachments = (files: File[]) => {
    if (!files.length) return;
    setAttachments((prev) => {
      const available = Math.max(0, MAX_FILES_PER_MESSAGE - prev.length);
      const accepted: File[] = [];
      const rejected: string[] = [];
      for (const file of files) {
        const descriptor = classifyFileInput(file.name, file.size, file.type);
        if (!descriptor.accepted) {
          rejected.push(`${file.name} (${descriptor.rejectionCode})`);
          continue;
        }
        if (accepted.length >= available) {
          rejected.push(`${file.name} (TOO_MANY_FILES)`);
          continue;
        }
        accepted.push(file);
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
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="compose-attachments">
          {attachments.map((f, i) => (
            <span className="attach-chip" key={`${f.name}-${i}`} style={{ animationDelay: `${Math.min(i, 5) * 24}ms` }}>
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">{formatSize(f.size)}</span>
              <button
                type="button"
                className="attach-remove"
                onClick={() => removeAttachment(i)}
                aria-label={`移除 ${f.name}`}
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
            onClick={() => fileInputRef.current?.click()}
            title="添加附件"
            aria-label="添加附件"
          >
            <PaperclipIcon size={20} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            hidden
            onChange={handleFileChange}
          />
          {streaming ? (
            <button className="stop-btn" onClick={onStop} title="停止生成">
              <StopIcon size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSubmit}
              disabled={!canSend}
              title="发送 (Enter)"
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
          padding: 10px 24px 8px;
          flex-shrink: 0;
        }
        .compose-inner {
          max-width: 860px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: var(--composer-bg);
          border-radius: 12px;
          padding: 12px 12px 10px;
          border: 1px solid var(--composer-border);
          position: relative;
          transition: border-color 0.15s, box-shadow 0.15s;
          animation: yc-fade-up 220ms var(--ease-standard) both;
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
          transition: background 0.15s, color 0.15s;
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
          transition: background 0.15s, filter 0.15s;
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
          max-width: 860px;
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
          transition: all 0.15s;
        }
        .attach-remove:hover {
          background: var(--bg-panel);
          color: var(--text);
        }
        .attach-remove :global(svg) { display: block; }
        .compose-footer {
          max-width: 860px;
          margin: 6px auto 0;
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
        .attachment-notice {
          max-width: 860px;
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
