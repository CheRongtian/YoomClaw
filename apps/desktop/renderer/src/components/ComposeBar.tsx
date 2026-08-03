import {
  useState,
  useRef,
  useEffect,
  KeyboardEvent,
  ChangeEvent,
} from "react";
import { SendIcon, StopIcon, PaperclipIcon } from "./icons";

export interface ComposePrefill {
  text: string;
  nonce: number;
}

interface Props {
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  prefill?: ComposePrefill | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ComposeBar({ onSend, onStop, disabled, streaming, prefill }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevStreaming = useRef(streaming);

  // 回复结束后自动聚焦输入框，用户无需再次点击即可继续打字
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      textareaRef.current?.focus();
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  // 外部预填（空状态建议 chip 点击后把提示词放进输入框）
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [prefill]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled || streaming) return;
    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) return;
      handleSubmit();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) setAttachments((prev) => [...prev, ...files]);
    e.target.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const canSend = (text.trim() || attachments.length > 0) && !disabled && !streaming;

  return (
    <div className="compose-bar">
      {attachments.length > 0 && (
        <div className="compose-attachments">
          {attachments.map((f, i) => (
            <span className="attach-chip" key={`${f.name}-${i}`}>
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">{formatSize(f.size)}</span>
              <button
                type="button"
                className="attach-remove"
                onClick={() => removeAttachment(i)}
                aria-label={`移除 ${f.name}`}
                title="移除"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="compose-inner">
        <textarea
          ref={textareaRef}
          className="compose-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            disabled
              ? "请先选择或新建对话..."
              : "给 YoomClaw 发送消息…"
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
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .compose-inner:focus-within {
          border-color: var(--composer-focus-border);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--composer-focus-border) 18%, transparent);
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
        }
        .send-btn:disabled {
          background: var(--bg-element);
          color: var(--text-muted);
          cursor: not-allowed;
        }
        .stop-btn {
          background: var(--error);
          color: var(--on-error);
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
        .compose-footer {
          max-width: 860px;
          margin: 6px auto 0;
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
      `}</style>
    </div>
  );
}
