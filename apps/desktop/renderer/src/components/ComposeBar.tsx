import { useState, useRef, KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "./icons";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  confirmMode: "confirm" | "no-confirm";
  onToggleConfirmMode: () => void;
}

export default function ComposeBar({ onSend, onStop, disabled, streaming, confirmMode, onToggleConfirmMode }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || streaming) return;
    onSend(trimmed);
    setText("");
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

  const canSend = text.trim() && !disabled && !streaming;

  return (
    <div className="compose-bar">
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
              : "给 YoomClaw 发送消息 · Enter 发送 · Shift+Enter 换行"
          }
          rows={1}
          disabled={disabled}
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
      <div className="compose-footer">
        <button
          type="button"
          className={`mode-toggle ${confirmMode}`}
          onClick={onToggleConfirmMode}
          title="切换工具执行确认模式：无需确认时写/执行类工具自动放行"
        >
          {confirmMode === "no-confirm" ? "无需确认" : "需确认"}
        </button>
        <span className="footer-note">YoomClaw 可能产生不准确的信息 · 请验证重要细节</span>
      </div>

      <style jsx>{`
        .compose-bar {
          border-top: 1px solid var(--border);
          background: var(--bg-secondary);
          padding: 10px 20px 6px;
          flex-shrink: 0;
        }
        .compose-inner {
          max-width: 860px;
          margin: 0 auto;
          display: flex;
          gap: 8px;
          align-items: flex-end;
          background: var(--bg-input);
          border-radius: 14px;
          padding: 8px 8px 8px 14px;
          border: 1px solid var(--border);
          transition: border-color 0.15s;
        }
        .compose-inner:focus-within {
          border-color: var(--accent);
        }
        .compose-input {
          flex: 1;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-family: inherit;
          font-size: 14.5px;
          line-height: 1.5;
          resize: none;
          outline: none;
          max-height: 200px;
          overflow-y: auto;
        }
        .compose-input::placeholder { color: var(--text-muted); }
        .compose-input:disabled { cursor: not-allowed; opacity: 0.5; }
        .send-btn, .stop-btn {
          width: 34px;
          height: 34px;
          border-radius: 8px;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          color: white;
          transition: background 0.15s;
        }
        .send-btn {
          background: var(--accent);
        }
        .send-btn:hover:not(:disabled) {
          background: var(--accent-hover);
        }
        .send-btn:disabled {
          background: var(--bg-tertiary);
          color: var(--text-muted);
          cursor: not-allowed;
        }
        .stop-btn {
          background: #ef4444;
        }
        .stop-btn:hover {
          background: #dc2626;
        }
        .compose-footer {
          max-width: 860px;
          margin: 4px auto 0;
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .mode-toggle {
          font-size: 11px;
          padding: 2px 10px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-tertiary);
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.15s;
        }
        .mode-toggle:hover {
          border-color: var(--accent);
        }
        .mode-toggle.no-confirm {
          background: rgba(63, 185, 80, 0.18);
          border-color: #3fb950;
          color: #3fb950;
        }
        .footer-note {
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}
