import type { ChatMessage } from "@yoomclaw/protocol";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import SpiralLogo from "./SpiralLogo";
import { WrenchIcon } from "./icons";

export interface ToolCard {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface LiveAssistant {
  text: string;
  tools: ToolCard[];
  progress: { name: string; percent: number } | null;
}

interface Props {
  messages: ChatMessage[];
  live?: LiveAssistant;
}

export default function MessageStream({ messages, live }: Props) {
  return (
    <div className="message-stream">
      {messages.map((msg, idx) => (
        <MessageRow key={idx} message={msg} />
      ))}
      {live && <LiveRow live={live} />}
      <style jsx>{`
        .message-stream {
          flex: 1;
          overflow-y: auto;
          padding: 16px 0;
          scroll-behavior: smooth;
        }
      `}</style>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((p) =>
              p.type === "text"
                ? p.text
                : p.type === "image_url"
                  ? "[image]"
                  : "[file]",
            )
            .join("")
        : "";

  return (
    <div className={`row ${isUser ? "user" : "assistant"}`}>
      {!isUser && (
        <div className="avatar">
          <SpiralLogo size={18} />
        </div>
      )}
      <div className="bubble">
        <div className="content">
          {isUser ? (
            <div className="user-text">{content}</div>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
              components={{
                code: ({ inline, className, children, ...props }: any) => {
                  if (inline) {
                    return (
                      <code className="inline-code" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
      </div>

      <style jsx>{`
        .row {
          display: flex;
          gap: 12px;
          max-width: 860px;
          margin: 0 auto 18px;
          padding: 0 24px;
          align-items: flex-start;
        }
        .row.user {
          justify-content: flex-end;
        }
        /* AI 侧只留品牌标记，不再套圆形底色 */
        .avatar {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          color: var(--primary);
          margin-top: 2px;
        }
        /* AI 回复平铺（工作伙伴式文本流），用户消息才用气泡 */
        .bubble {
          max-width: calc(100% - 40px);
          padding: 2px 0;
        }
        .row.user .bubble {
          background: var(--bg-element);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 10px 14px;
          color: var(--text);
        }
        .content {
          font-size: 14.5px;
          line-height: 1.7;
          word-break: break-word;
        }
        .content :global(p) {
          margin: 0 0 10px;
        }
        .content :global(p:last-child) {
          margin-bottom: 0;
        }
        .content :global(ul),
        .content :global(ol) {
          margin: 6px 0 10px;
          padding-left: 24px;
        }
        .content :global(li) {
          margin: 2px 0;
        }
        .content :global(h1),
        .content :global(h2),
        .content :global(h3),
        .content :global(h4) {
          margin: 14px 0 6px;
          font-weight: 600;
        }
        .content :global(pre) {
          background: var(--code-bg);
          border-radius: 8px;
          padding: 12px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .content :global(.inline-code) {
          background: var(--code-bg);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 13px;
        }
        .content :global(table) {
          border-collapse: collapse;
          margin: 8px 0;
        }
        .content :global(th),
        .content :global(td) {
          border: 1px solid var(--border);
          padding: 6px 12px;
        }
        .content :global(blockquote) {
          border-left: 3px solid var(--primary);
          padding-left: 12px;
          color: var(--text-secondary);
          margin: 8px 0;
        }
        .user-text {
          white-space: pre-wrap;
        }
      `}</style>
    </div>
  );
}

function LiveRow({ live }: { live: LiveAssistant }) {
  return (
    <div className="row assistant">
      <div className="avatar">
        <SpiralLogo size={18} />
      </div>
      <div className="bubble">
        {live.progress && (
          <div className="progress">
            <div className="progress-label">
              <span className="spinner" /> {live.progress.name}
              <span className="progress-pct">{live.progress.percent}%</span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${live.progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {live.tools.length > 0 && (
          <div className="tools">
            {live.tools.map((t) => (
              <ToolCardView key={t.callId} card={t} />
            ))}
          </div>
        )}

        {live.text && (
          <div className="content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
              components={{
                code: ({ inline, className, children, ...props }: any) => {
                  if (inline) {
                    return (
                      <code className="inline-code" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {live.text}
            </ReactMarkdown>
          </div>
        )}
      </div>

      <style jsx>{`
        .avatar {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          color: var(--primary);
          margin-top: 2px;
        }
        .bubble {
          max-width: calc(100% - 40px);
          padding: 2px 0;
        }
        .progress {
          margin-bottom: 10px;
        }
        .progress-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 4px;
        }
        .progress-pct {
          margin-left: auto;
          color: var(--text-muted);
        }
        .spinner {
          width: 10px;
          height: 10px;
          border: 2px solid var(--primary);
          border-top-color: transparent;
          border-radius: 50%;
          display: inline-block;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        .progress-track {
          height: 4px;
          background: var(--bg-element);
          border-radius: 2px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: var(--primary);
          transition: width 0.3s ease;
        }
        .tools {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 10px;
        }
        .content {
          font-size: 14.5px;
          line-height: 1.7;
          word-break: break-word;
        }
        .content :global(p) {
          margin: 0 0 10px;
        }
        .content :global(p:last-child) {
          margin-bottom: 0;
        }
        .content :global(pre) {
          background: var(--code-bg);
          border-radius: 8px;
          padding: 12px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .content :global(.inline-code) {
          background: var(--code-bg);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

function ToolCardView({ card }: { card: ToolCard }) {
  const statusLabel: Record<ToolCard["status"], string> = {
    pending: "等待确认",
    running: "执行中",
    done: "完成",
    error: "失败",
  };
  return (
    <div className={`tool-card ${card.status}`}>
      <div className="tool-head">
        <span className="tool-icon">
          <WrenchIcon size={14} />
        </span>
        <span className="tool-name">{card.name}</span>
        <span className={`tool-status ${card.status}`}>
          {statusLabel[card.status]}
        </span>
      </div>
      {Object.keys(card.args).length > 0 && (
        <pre className="tool-args">{JSON.stringify(card.args, null, 2)}</pre>
      )}
      {card.result !== undefined && (
        <pre className={`tool-result ${card.isError ? "err" : ""}`}>
          {card.result}
        </pre>
      )}
      {card.durationMs !== undefined && (
        <div className="tool-meta">{card.durationMs}ms</div>
      )}

      <style jsx>{`
        .tool-card {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 8px 10px;
          background: var(--tool-call-bg);
        }
        .tool-card.pending {
          border-color: var(--status-attention);
        }
        .tool-card.running {
          border-color: var(--status-running);
        }
        .tool-card.error {
          border-color: var(--status-unavailable);
        }
        .tool-head {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
        }
        .tool-icon {
          color: var(--text-secondary);
          display: flex;
        }
        .tool-name {
          font-weight: 600;
          font-family: var(--font-mono);
        }
        .tool-status {
          margin-left: auto;
          font-size: 11px;
          padding: 1px 7px;
          border-radius: 10px;
          background: var(--bg-element);
          color: var(--text-muted);
        }
        .tool-status.pending {
          background: color-mix(in srgb, var(--status-attention) 22%, transparent);
          color: var(--status-attention);
        }
        .tool-status.running {
          background: color-mix(in srgb, var(--status-running) 22%, transparent);
          color: var(--status-running);
        }
        .tool-status.error {
          background: color-mix(in srgb, var(--status-unavailable) 22%, transparent);
          color: var(--status-unavailable);
        }
        .tool-args,
        .tool-result {
          margin: 6px 0 0;
          padding: 8px;
          border-radius: 6px;
          font-size: 12px;
          background: var(--code-bg);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .tool-result.err {
          color: var(--status-unavailable);
        }
        .tool-meta {
          margin-top: 4px;
          font-size: 11px;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}
