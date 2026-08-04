import { Fragment, useEffect, useRef, useState } from "react";
import type { AgentEvent, ChatMessage, ContentPart } from "@yoomclaw/protocol";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import SpiralLogo from "./SpiralLogo";
import {
  WrenchIcon,
  EditIcon,
  RefreshIcon,
  CopyIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  LoaderIcon,
} from "./icons";

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

export function toolCardsFromEvents(events: AgentEvent[]): ToolCard[] {
  const cards: ToolCard[] = [];
  const byId = new Map<string, ToolCard>();
  const add = (card: ToolCard) => {
    cards.push(card);
    byId.set(card.callId, card);
  };

  for (const event of events) {
    if (event.type === "tool_confirm") {
      const existing = byId.get(event.callId);
      if (existing) {
        existing.name = event.name;
        existing.args = event.args;
        existing.status = "pending";
      } else {
        add({
          callId: event.callId,
          name: event.name,
          args: event.args,
          status: "pending",
        });
      }
    } else if (event.type === "tool_start") {
      const existing = byId.get(event.callId);
      if (existing) {
        existing.status = "running";
        existing.args = event.args;
        existing.name = event.name;
      } else {
        add({
          callId: event.callId,
          name: event.name,
          args: event.args,
          status: "running",
        });
      }
    } else if (event.type === "tool_end") {
      const existing = byId.get(event.callId);
      if (existing) {
        existing.status = event.isError ? "error" : "done";
        existing.result = event.result;
        existing.isError = event.isError;
        existing.durationMs = event.durationMs;
        existing.name = event.name;
      } else {
        add({
          callId: event.callId,
          name: event.name,
          args: {},
          status: event.isError ? "error" : "done",
          result: event.result,
          isError: event.isError,
          durationMs: event.durationMs,
        });
      }
    }
  }
  return cards;
}

function sanitizeUserText(text: string): string {
  return text.replace(
    /\[本地 PDF 内容：([^\]\r\n]+)\][\s\S]*?(?:\n\[PDF 内容已截断[^\]\r\n]*\]|$)/g,
    (_match, fileName: string) => `[已解析 PDF：${fileName}]`,
  );
}

interface Props {
  messages: ChatMessage[];
  historicalTools?: ToolCard[];
  live?: LiveAssistant;
  onEditUser?: (index: number, message: ChatMessage) => void;
  onRetryAssistant?: (index: number) => void;
}

export default function MessageStream({
  messages,
  historicalTools = [],
  live,
  onEditUser,
  onRetryAssistant,
}: Props) {
  const lastAssistantIndex = messages.reduce(
    (last, message, index) => message.role === "assistant" ? index : last,
    -1,
  );
  const insertionIndex = historicalTools.length > 0
    ? (lastAssistantIndex >= 0 ? lastAssistantIndex : messages.length)
    : -1;
  const messageKeyCounts = new Map<string, number>();
  return (
    <div className="message-stream">
      {messages.map((msg, idx) => {
        const baseKey = `${msg.role}:${msg.tool_call_id ?? ""}:${messageText(msg.content).slice(0, 120)}`;
        const occurrence = messageKeyCounts.get(baseKey) ?? 0;
        messageKeyCounts.set(baseKey, occurrence + 1);
        return (
          <Fragment key={`${baseKey}:${occurrence}`}>
            {idx === insertionIndex && <HistoricalToolsRow tools={historicalTools} />}
            <MessageRow
              message={msg}
              index={idx}
              onEditUser={onEditUser}
              onRetryAssistant={onRetryAssistant}
            />
          </Fragment>
        );
      })}
      {insertionIndex === messages.length && <HistoricalToolsRow tools={historicalTools} />}
      {live && <LiveRow live={live} />}
      <style jsx>{`
        .message-stream {
          flex: 1;
          overflow-y: auto;
          padding: 16px 0;
          scroll-behavior: auto;
        }
      `}</style>
    </div>
  );
}

export function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image_url") return "[图片附件]";
    return `[文件附件${part.file_url.fileId ? `：${part.file_url.fileId}` : ""}]`;
  }).join("\n");
}

function MarkdownContent({ text }: { text: string }) {
  return (
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
      {text}
    </ReactMarkdown>
  );
}

function isRenderableUrl(value: string): boolean {
  return /^(?:https?:|data:)/i.test(value);
}

function AttachmentPart({ part }: { part: Exclude<ContentPart, { type: "text" }> }) {
  if (part.type === "image_url") {
    return isRenderableUrl(part.image_url.url) ? (
      <a className="attachment-image-link" href={part.image_url.url} target="_blank" rel="noreferrer">
        <img className="attachment-image" src={part.image_url.url} alt="图片附件" />
      </a>
    ) : (
      <span className="attachment-chip">图片附件</span>
    );
  }
  const label = part.file_url.fileId ? `文件附件：${part.file_url.fileId}` : "文件附件";
  return isRenderableUrl(part.file_url.url) ? (
    <a className="attachment-link" href={part.file_url.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <span className="attachment-chip">{label}</span>
  );
}

function MessageContent({ message, isUser }: { message: ChatMessage; isUser: boolean }) {
  if (typeof message.content === "string") {
    return isUser
      ? <div className="user-text">{sanitizeUserText(message.content)}</div>
      : <MarkdownContent text={message.content} />;
  }
  return (
    <div className="content-parts">
      {message.content.map((part, index) => (
        part.type === "text" ? (
          isUser
            ? <div className="user-text" key={index}>{sanitizeUserText(part.text)}</div>
            : <MarkdownContent key={index} text={part.text} />
        ) : <AttachmentPart key={index} part={part} />
      ))}
    </div>
  );
}

function MessageRow({
  message,
  index,
  onEditUser,
  onRetryAssistant,
}: {
  message: ChatMessage;
  index: number;
  onEditUser?: (index: number, message: ChatMessage) => void;
  onRetryAssistant?: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);
  if (message.role === "tool") {
    return (
      <HistoricalToolsRow
        tools={[{
          callId: message.tool_call_id ?? `tool-${message.name ?? "result"}`,
          name: message.name ?? "tool",
          args: {},
          status: "done",
          result: messageText(message.content),
        }]}
      />
    );
  }
  const isUser = message.role === "user";
  const copy = async () => {
    const text = messageText(message.content);
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1200);
    } catch {
      // Clipboard permissions are optional in browser mode.
    }
  };

  return (
    <div className={`row ${isUser ? "user" : "assistant"}`}>
      {!isUser && (
        <div className="avatar">
          <SpiralLogo size={18} />
        </div>
      )}
      <div className="bubble">
        <div className="content">
          <MessageContent message={message} isUser={isUser} />
        </div>
        {messageText(message.content) && (
          <div className="message-actions">
            {isUser && onEditUser && (
              <button className="message-action" type="button" onClick={() => onEditUser(index, message)} title="编辑并重发" aria-label="编辑并重发">
                <EditIcon size={13} />
                <span className="sr-only">编辑</span>
              </button>
            )}
            {!isUser && onRetryAssistant && (
              <button className="message-action" type="button" onClick={() => onRetryAssistant(index)} title="重试此回复" aria-label="重试此回复">
                <RefreshIcon size={13} />
                <span className="sr-only">重试</span>
              </button>
            )}
            <button className={`message-action ${copied ? "copied" : ""}`} type="button" onClick={() => void copy()} title={copied ? "已复制" : "复制消息"} aria-label={copied ? "已复制" : "复制消息"}>
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              <span className="sr-only">{copied ? "已复制" : "复制"}</span>
            </button>
          </div>
        )}
      </div>

      <style jsx>{`
        .row {
          display: flex;
          gap: 12px;
          max-width: 860px;
          margin: 0 auto 18px;
          padding: 0 24px;
          align-items: flex-start;
          animation: yc-fade-up 220ms var(--ease-standard) both;
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
        .content-parts {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .attachment-image-link {
          display: block;
          width: fit-content;
          max-width: min(420px, 100%);
        }
        .attachment-image {
          display: block;
          max-width: 100%;
          max-height: 280px;
          border-radius: 8px;
          border: 1px solid var(--border);
          object-fit: contain;
        }
        .attachment-link,
        .attachment-chip {
          display: inline-flex;
          width: fit-content;
          align-items: center;
          padding: 5px 8px;
          border-radius: 6px;
          background: var(--bg-element);
          color: var(--text-secondary);
          font-size: 12px;
          text-decoration: none;
        }
        .attachment-link:hover { color: var(--primary); }
        .message-actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 5px;
          opacity: 0;
          transform: translateY(3px);
          pointer-events: none;
          transition: opacity var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
        }
        .row:hover .message-actions,
        .row:focus-within .message-actions { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .message-action {
          width: 26px;
          height: 24px;
          border: 0;
          padding: 0;
          border-radius: 6px;
          color: var(--text-muted);
          background: transparent;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .message-action:hover {
          color: var(--text);
          background: var(--bg-element);
        }
        .message-action.copied { color: var(--success); }
        .message-action.copied :global(svg) { animation: yc-pop 180ms var(--ease-emphasized) both; }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
      `}</style>
    </div>
  );
}

function HistoricalToolsRow({ tools }: { tools: ToolCard[] }) {
  return (
    <div className="row assistant historical-tools-row">
      <div className="avatar">
        <SpiralLogo size={18} />
      </div>
      <div className="bubble">
        <div className="tools">
          {tools.map((tool) => <ToolCardView key={tool.callId} card={tool} />)}
        </div>
        <div className="history-label">历史工具调用</div>
      </div>
      <style jsx>{`
        .historical-tools-row { margin-bottom: 8px; animation-delay: 40ms; }
        .tools {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .history-label {
          margin-top: 5px;
          color: var(--text-muted);
          font-size: 11px;
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
              <LoaderIcon size={13} className="spinner" /> {live.progress.name}
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
          display: inline-block;
          color: var(--primary);
          animation: yc-spin 0.85s linear infinite;
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
  const statusIcon = card.status === "pending"
    ? <ClockIcon size={14} />
    : card.status === "running"
      ? <LoaderIcon size={14} className="tool-spinner" />
      : card.status === "error"
        ? <CircleXIcon size={14} />
        : <CircleCheckIcon size={14} />;
  return (
    <div className={`tool-card ${card.status}`}>
      <div className="tool-head">
        <span className="tool-icon">
          {card.status === "running" ? statusIcon : <WrenchIcon size={14} />}
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
          position: relative;
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 8px 10px;
          background: var(--tool-call-bg);
          animation: yc-fade-up 220ms var(--ease-standard) both;
        }
        .tool-card.pending {
          border-color: var(--status-attention);
        }
        .tool-card.running {
          border-color: var(--status-running);
        }
        .tool-card.running::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: linear-gradient(105deg, transparent 30%, color-mix(in srgb, var(--status-running) 8%, transparent) 50%, transparent 70%);
          background-size: 220% 100%;
          animation: yc-shimmer 1.8s ease-in-out infinite;
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
          flex-shrink: 0;
        }
        .tool-spinner { animation: yc-spin 0.85s linear infinite; color: var(--status-running); }
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
