import { Fragment, memo, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AgentEvent, ChatMessage, ContentPart, PlanState } from "@yoomclaw/protocol";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import SpiralLogo from "./SpiralLogo";
import {
  WrenchIcon,
  ChevronRightIcon,
  EditIcon,
  RefreshIcon,
  CopyIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  LoaderIcon,
} from "./icons";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight];
const MARKDOWN_COMPONENTS = {
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
};

export interface ToolCard {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  isError?: boolean;
  code?: string;
  metadata?: Record<string, unknown>;
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
        existing.code = event.code;
        existing.metadata = event.metadata;
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
          code: event.code,
          metadata: event.metadata,
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
  plan?: PlanState | null;
  live?: LiveAssistant;
  endRef?: RefObject<HTMLDivElement | null>;
  onEditUser?: (index: number, message: ChatMessage) => void;
  onRetryAssistant?: (index: number) => void;
}

export default function MessageStream({
  messages,
  historicalTools = [],
  plan = null,
  live,
  endRef,
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
      {plan && <PlanCard plan={plan} />}
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
      {endRef && <div ref={endRef} className="message-stream-end" aria-hidden="true" />}
      <style jsx>{`
        .message-stream {
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow-y: auto;
          overflow-anchor: none;
          padding: 16px 0 20px;
          scroll-behavior: auto;
        }
        .message-stream-end {
          height: 1px;
          scroll-margin-bottom: 12px;
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

export function messageTextWithPaths(message: ChatMessage): string {
  const content = messageText(message.content).trim();
  const paths = (message.localPaths ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return [
    content,
    ...paths.map((value) => `[本地文件路径："${value}"]`),
  ].filter(Boolean).join("\n");
}

const PlanCard = memo(function PlanCard({ plan }: { plan: PlanState }) {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  return (
    <section className="plan-card" aria-label="当前任务计划">
      <div className="plan-heading">
        <span>任务计划</span>
        <span className="plan-count">{completed}/{plan.items.length}</span>
      </div>
      <ol className="plan-items">
        {plan.items.map((item) => (
          <li key={item.id} className={`plan-item ${item.status}`}>
            <span className="plan-status" aria-hidden="true">
              {item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : item.status === "cancelled" ? "×" : "○"}
            </span>
            <span className="plan-title">{item.title}</span>
          </li>
        ))}
      </ol>
      {plan.note && <div className="plan-note">{plan.note}</div>}
      <style jsx>{`
        .plan-card {
          margin: 0 auto 16px;
          width: min(720px, calc(100% - 32px));
          padding: 12px 14px;
          border: 1px solid var(--border-subtle, #303044);
          border-radius: 12px;
          background: var(--surface-raised, rgba(32, 31, 52, .72));
        }
        .plan-heading { display: flex; justify-content: space-between; font-size: 13px; font-weight: 650; }
        .plan-count { color: var(--text-muted, #9a98b5); font-weight: 500; }
        .plan-items { margin: 9px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
        .plan-item { display: flex; gap: 8px; align-items: baseline; color: var(--text-muted, #a9a6c0); font-size: 13px; }
        .plan-item.in_progress { color: var(--text-primary, #f3f0ff); font-weight: 600; }
        .plan-item.completed { color: #7fd4a5; }
        .plan-item.cancelled { text-decoration: line-through; opacity: .65; }
        .plan-status { width: 14px; text-align: center; color: currentColor; }
        .plan-note { margin-top: 9px; color: var(--text-muted, #9a98b5); font-size: 12px; white-space: pre-wrap; }
      `}</style>
    </section>
  );
});

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});

/** Keep the hot streaming path to a single text node. Full Markdown parsing
 * (especially syntax highlighting and KaTeX) happens once after completion. */
function StreamingContent({ text }: { text: string }) {
  return (
    <div className="streaming-text">
      <span>{text}</span>
      <span className="streaming-caret" aria-hidden="true" />
    </div>
  );
}

const SIGNAL_BARS = [0, 1, 2, 3, 4];

const ResponseSignal = memo(function ResponseSignal({ label }: { label: string }) {
  return (
    <div className="response-signal" role="status" aria-live="polite">
      <span className="signal-core" aria-hidden="true">
        <span className="signal-ring signal-ring-one" />
        <span className="signal-ring signal-ring-two" />
        <span className="signal-dot" />
      </span>
      <span className="signal-wave" aria-hidden="true">
        {SIGNAL_BARS.map((bar) => <span key={bar} />)}
      </span>
      <span className="signal-label">{label}</span>
      <span className="signal-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
    </div>
  );
});

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

function LocalPathList({ paths }: { paths: string[] }) {
  const visiblePaths = paths.map((value) => value.trim()).filter(Boolean);
  if (visiblePaths.length === 0) return null;
  return (
    <div className="local-paths" data-testid="message-local-paths">
      <div className="local-path-label">本地文件路径</div>
      {visiblePaths.map((value, index) => (
        <code className="local-path" data-testid="message-local-path" key={`${value}-${index}`}>{value}</code>
      ))}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
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
    const text = messageTextWithPaths(message);
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
    <div className={`message-row ${isUser ? "user" : "assistant"}`} data-testid={`message-row-${index}`}>
      {!isUser && (
        <div className="message-avatar">
          <SpiralLogo size={18} />
        </div>
      )}
      <div className="message-body">
        <div className="message-bubble">
          <div className="content">
            <MessageContent message={message} isUser={isUser} />
            {isUser && <LocalPathList paths={message.localPaths ?? []} />}
          </div>
        </div>
        {messageTextWithPaths(message) && (
          <div className="message-actions">
            {isUser && onEditUser && (
              <button className="message-action" data-testid="message-edit" data-message-index={index} type="button" onClick={() => onEditUser(index, message)} title="编辑并重发" aria-label="编辑并重发">
                <EditIcon size={13} />
                <span className="sr-only">编辑</span>
              </button>
            )}
            {!isUser && onRetryAssistant && (
              <button className="message-action" data-testid="message-retry" data-message-index={index} type="button" onClick={() => onRetryAssistant(index)} title="重试此回复" aria-label="重试此回复">
                <RefreshIcon size={13} />
                <span className="sr-only">重试</span>
              </button>
            )}
            <button className={`message-action ${copied ? "copied" : ""}`} data-testid="message-copy" data-message-index={index} type="button" onClick={() => void copy()} title={copied ? "已复制" : "复制消息"} aria-label={copied ? "已复制" : "复制消息"}>
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              <span className="sr-only">{copied ? "已复制" : "复制"}</span>
            </button>
          </div>
        )}
      </div>

      <style jsx>{`
        .content {
          font-size: 14.5px;
          line-height: 1.7;
          word-break: break-word;
        }
        .local-paths {
          display: grid;
          gap: 3px;
          margin-top: 9px;
          padding-top: 8px;
          border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .local-path-label {
          font-size: 10px;
          letter-spacing: .04em;
          opacity: .8;
        }
        .local-path {
          display: block;
          overflow-wrap: anywhere;
          color: inherit;
          font: 10.5px var(--font-mono);
        }
        .message-body {
          min-width: 0;
          max-width: calc(100% - 36px);
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
        }
        .message-body .message-bubble {
          width: 100%;
          max-width: 100%;
          flex: 0 1 auto;
        }
        .message-row.user .message-body {
          max-width: min(100%, 720px);
          flex: 0 1 auto;
          align-items: flex-end;
        }
        .message-row.user .message-body .message-bubble {
          width: auto;
          max-width: 100%;
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
          align-self: flex-end;
          min-height: 24px;
          margin-top: 3px;
          opacity: 0;
          transform: translateY(-2px);
          pointer-events: none;
          transition: opacity var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
        }
        .message-row:hover .message-actions,
        .message-row:focus-within .message-actions { opacity: 1; transform: translateY(0); pointer-events: auto; }
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
});

const HistoricalToolsRow = memo(function HistoricalToolsRow({ tools }: { tools: ToolCard[] }) {
  return (
    <div className="message-row assistant historical-tools-row">
      <div className="message-avatar">
        <SpiralLogo size={18} />
      </div>
      <div className="message-bubble">
        <div className="tools">
          {tools.map((tool) => <ToolCardView key={tool.callId} card={tool} />)}
        </div>
        <div className="history-label">
          <span>执行记录</span>
          <span>{tools.length} 个动作</span>
        </div>
      </div>
      <style jsx>{`
        .historical-tools-row { margin-bottom: 8px; animation-delay: 40ms; }
        .tools {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .history-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 5px;
          color: var(--text-muted);
          font-size: 11px;
        }
        .history-label span:last-child { color: var(--text-dim); font-size: 10px; }
      `}</style>
    </div>
  );
});

const LiveRow = memo(function LiveRow({ live }: { live: LiveAssistant }) {
  const responseLabel = live.text
    ? "正在生成回复"
    : (live.progress?.name ?? "正在准备回复");
  return (
    <div className="message-row assistant live-row">
      <div className="message-avatar">
        <SpiralLogo size={18} />
      </div>
      <div className="message-bubble live-bubble">
        {(live.progress || live.text) && (
          <ResponseSignal label={responseLabel} />
        )}

        {live.tools.length > 0 && (
          <>
            <div className="live-tools-label">
              <span>执行步骤</span>
              <span>{live.tools.length} 个动作</span>
            </div>
            <div className="tools">
              {live.tools.map((t) => (
                <ToolCardView key={t.callId} card={t} />
              ))}
            </div>
          </>
        )}

        {live.text && (
          <div className="content">
            <StreamingContent text={live.text} />
          </div>
        )}
      </div>

      <style jsx>{`
        .response-signal {
          position: relative;
          display: flex;
          align-items: center;
          min-height: 32px;
          min-width: 0;
          gap: 8px;
          margin: 0 0 12px;
          padding: 5px 10px 5px 7px;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid color-mix(in srgb, var(--primary) 24%, var(--border));
          border-radius: 999px;
          background:
            radial-gradient(circle at 16px 50%, color-mix(in srgb, var(--primary) 18%, transparent), transparent 21px),
            linear-gradient(105deg, color-mix(in srgb, var(--primary) 8%, var(--assistant-bubble-bg)), var(--assistant-bubble-bg));
          box-shadow: 0 5px 20px color-mix(in srgb, var(--primary) 8%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent);
        }
        .response-signal::before {
          content: "";
          position: absolute;
          z-index: -1;
          top: -80%;
          left: -35%;
          width: 34%;
          height: 260%;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--primary) 20%, transparent), transparent);
          transform: skewX(-18deg) translateX(-180%);
          animation: yc-signal-sweep 2.8s ease-in-out infinite;
          will-change: transform;
        }
        .signal-core {
          position: relative;
          display: grid;
          width: 20px;
          height: 20px;
          flex: 0 0 20px;
          place-items: center;
        }
        .signal-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--primary);
          box-shadow: 0 0 8px color-mix(in srgb, var(--primary) 88%, transparent), 0 0 16px color-mix(in srgb, var(--primary) 32%, transparent);
          animation: yc-signal-core 1.6s ease-in-out infinite;
        }
        .signal-ring {
          position: absolute;
          inset: 3px;
          border: 1px solid color-mix(in srgb, var(--primary) 64%, transparent);
          border-radius: 50%;
          animation: yc-signal-ring 1.8s cubic-bezier(.2, .8, .2, 1) infinite;
        }
        .signal-ring-two {
          animation-delay: .55s;
        }
        .signal-wave {
          display: flex;
          align-items: center;
          width: 24px;
          height: 20px;
          gap: 2px;
          flex: 0 0 24px;
        }
        .signal-wave span {
          width: 2px;
          height: 7px;
          border-radius: 999px;
          background: linear-gradient(to bottom, var(--secondary), var(--primary));
          transform-origin: center;
          animation: yc-signal-wave 1.05s ease-in-out infinite;
        }
        .signal-wave span:nth-child(2) { animation-delay: .12s; }
        .signal-wave span:nth-child(3) { animation-delay: .24s; }
        .signal-wave span:nth-child(4) { animation-delay: .36s; }
        .signal-wave span:nth-child(5) { animation-delay: .48s; }
        .signal-label {
          min-width: 0;
          overflow: hidden;
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: .01em;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .signal-dots {
          display: inline-flex;
          min-width: 17px;
          color: var(--primary);
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 2px;
          line-height: 1;
        }
        .signal-dots i {
          font-style: normal;
          animation: yc-signal-dot 1.2s ease-in-out infinite;
        }
        .signal-dots i:nth-child(2) { animation-delay: .16s; }
        .signal-dots i:nth-child(3) { animation-delay: .32s; }
        .live-bubble {
          position: relative;
        }
        .live-tools-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 0 1px 7px;
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 650;
        }
        .live-tools-label span:last-child {
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 400;
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
        .streaming-text {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .streaming-caret {
          display: inline-block;
          width: 2px;
          height: 1.05em;
          margin-left: 4px;
          vertical-align: -.16em;
          border-radius: 2px;
          background: var(--primary);
          box-shadow: 0 0 8px color-mix(in srgb, var(--primary) 72%, transparent);
          animation: yc-stream-caret 1s steps(1, end) infinite;
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
});

interface SearchResultCard {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
}

function parseSearchResults(card: ToolCard): SearchResultCard[] | null {
  if (card.name !== "web_search" || !card.result || card.isError) return null;
  try {
    const value = JSON.parse(card.result) as unknown;
    if (!Array.isArray(value)) return null;
    const results = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        title: typeof item.title === "string" ? item.title : "未命名结果",
        url: typeof item.url === "string" ? item.url : "",
        snippet: typeof item.snippet === "string" ? item.snippet : typeof item.summary === "string" ? item.summary : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
        publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : undefined,
      }))
      .filter((item) => /^https?:\/\//i.test(item.url));
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

function documentMetadata(card: ToolCard): string[] {
  if (card.name !== "read_document" || !card.metadata) return [];
  const metadata = card.metadata;
  const labels: string[] = [];
  if (typeof metadata.fileName === "string") labels.push(metadata.fileName);
  if (typeof metadata.kind === "string") labels.push(metadata.kind.toUpperCase());
  if (typeof metadata.page === "number") labels.push(`第 ${metadata.page} 页`);
  if (typeof metadata.slide === "number") labels.push(`第 ${metadata.slide} 张幻灯片`);
  if (typeof metadata.sheet === "string") labels.push(`工作表：${metadata.sheet}`);
  if (metadata.truncated === true) labels.push("内容已截断");
  return labels;
}

const ToolCardView = memo(function ToolCardView({ card }: { card: ToolCard }) {
  const [expanded, setExpanded] = useState(() => card.status !== "done");
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
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
  const searchResults = parseSearchResults(card);
  const documentLabels = documentMetadata(card);
  const duration = formatToolDuration(card.durationMs);
  const summary = toolSummary(card, searchResults, documentLabels);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (card.status === "pending" || card.status === "running" || card.status === "error") {
      setExpanded(true);
    } else if (card.status === "done") {
      setExpanded(false);
    }
  }, [card.status]);

  const copyResult = async () => {
    if (card.result === undefined || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(card.result);
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
    <div
      className={`tool-card ${card.status} ${expanded ? "is-expanded" : "is-collapsed"}`}
      data-testid="tool-card"
      data-tool-name={card.name}
      data-tool-status={card.status}
    >
      <div className="tool-head">
        <span className="tool-icon">
          <WrenchIcon size={14} />
        </span>
        <div className="tool-title">
          <span className="tool-label">{toolLabel(card.name)}</span>
          <span className="tool-name">{card.name}</span>
        </div>
        {duration && <span className="tool-duration">{duration}</span>}
        <span className={`tool-status ${card.status}`}>
          {statusIcon}
          {statusLabel[card.status]}
        </span>
        <button
          type="button"
          className="tool-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `收起${toolLabel(card.name)}详情` : `展开${toolLabel(card.name)}详情`}
          title={expanded ? "收起详情" : "展开详情"}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
      <div className={`tool-summary ${card.status === "error" ? "err" : ""}`}>
        <span>{summary}</span>
        {!expanded && (Object.keys(card.args).length > 0 || card.result !== undefined) && (
          <span className="tool-summary-hint">点击查看详情</span>
        )}
      </div>
      {documentLabels.length > 0 && (
        <div className="tool-tags">
          {documentLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
      )}
      {expanded && (
        <div className="tool-details">
          {Object.keys(card.args).length > 0 && (
            <div className="tool-section">
              <div className="tool-section-head">
                <span>输入参数</span>
                <span className="tool-section-kind">JSON</span>
              </div>
              <pre className="tool-args">{JSON.stringify(card.args, null, 2)}</pre>
            </div>
          )}
          {card.result !== undefined && (
            <div className="tool-section">
              <div className="tool-section-head">
                <span>输出结果</span>
                {searchResults
                  ? <span className="tool-section-kind">{searchResults.length} 条结果</span>
                  : (
                    <button type="button" className="tool-copy" onClick={() => void copyResult()}>
                      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                      {copied ? "已复制" : "复制"}
                    </button>
                  )}
              </div>
              {searchResults ? (
                <div className="search-results">
                  {searchResults.map((item) => (
                    <a className="search-result" key={`${item.url}:${item.title}`} href={item.url} target="_blank" rel="noreferrer">
                      <span className="search-result-title">{item.title}</span>
                      <span className="search-result-url">{item.url}</span>
                      {item.snippet && <span className="search-result-snippet">{item.snippet}</span>}
                      {(item.source || item.publishedAt) && (
                        <span className="search-result-meta">{[item.source, item.publishedAt].filter(Boolean).join(" · ")}</span>
                      )}
                    </a>
                  ))}
                </div>
              ) : (
                <pre className={`tool-result ${card.isError ? "err" : ""}`}>
                  {card.result}
                </pre>
              )}
            </div>
          )}
          {card.code && <div className="tool-meta tool-code">错误代码：{card.code}</div>}
        </div>
      )}

      <style jsx>{`
        .tool-card {
          position: relative;
          min-width: 0;
          max-width: 100%;
          overflow: hidden;
          border: 1px solid color-mix(in srgb, var(--tool-call-border) 84%, var(--border));
          border-radius: 12px;
          padding: 10px 11px;
          background: color-mix(in srgb, var(--tool-call-bg) 82%, var(--assistant-bubble-bg));
          box-shadow: inset 2px 0 0 color-mix(in srgb, var(--text-muted) 14%, transparent);
          animation: yc-fade-up 220ms var(--ease-standard) both;
        }
        .tool-card.pending {
          border-color: color-mix(in srgb, var(--status-attention) 72%, var(--border));
          box-shadow: inset 2px 0 0 var(--status-attention);
        }
        .tool-card.running {
          border-color: color-mix(in srgb, var(--status-running) 72%, var(--border));
          box-shadow: inset 2px 0 0 var(--status-running);
        }
        .tool-card.running::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: linear-gradient(105deg, transparent 30%, color-mix(in srgb, var(--status-running) 5%, transparent) 50%, transparent 70%);
          background-size: 220% 100%;
          animation: yc-shimmer 1.8s ease-in-out infinite;
        }
        .tool-card.error {
          border-color: color-mix(in srgb, var(--status-unavailable) 72%, var(--border));
          box-shadow: inset 2px 0 0 var(--status-unavailable);
        }
        .tool-head {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          min-width: 0;
          gap: 7px;
          font-size: 13px;
        }
        .tool-icon {
          width: 24px;
          height: 24px;
          align-items: center;
          justify-content: center;
          border-radius: 7px;
          color: var(--primary);
          background: color-mix(in srgb, var(--primary) 10%, transparent);
          display: flex;
          flex-shrink: 0;
        }
        .tool-title {
          display: grid;
          min-width: 0;
          gap: 1px;
        }
        .tool-label {
          min-width: 0;
          overflow: hidden;
          color: var(--text);
          font-size: 12px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tool-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-muted);
          font-size: 10px;
          font-family: var(--font-mono);
        }
        .tool-duration {
          margin-left: auto;
          color: var(--text-muted);
          font: 10px var(--font-mono);
          white-space: nowrap;
        }
        .tool-status {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          padding: 3px 7px;
          border-radius: 999px;
          background: var(--bg-element);
          color: var(--text-muted);
          white-space: nowrap;
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
        .tool-spinner { animation: yc-spin 0.85s linear infinite; }
        .tool-toggle {
          display: inline-flex;
          width: 24px;
          height: 24px;
          flex: 0 0 24px;
          align-items: center;
          justify-content: center;
          border: 1px solid transparent;
          border-radius: 7px;
          color: var(--text-muted);
        }
        .tool-toggle:hover {
          color: var(--text);
          border-color: var(--border-active);
          background: var(--bg-element);
        }
        .tool-toggle :global(svg) {
          transition: transform var(--motion-fast) var(--ease-standard);
        }
        .tool-card.is-expanded .tool-toggle :global(svg) { transform: rotate(90deg); }
        .tool-summary {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: baseline;
          min-width: 0;
          gap: 8px;
          margin: 8px 31px 0;
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.45;
        }
        .tool-summary > span:first-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tool-summary.err { color: var(--status-unavailable); }
        .tool-summary-hint {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-size: 10px;
        }
        .tool-details {
          position: relative;
          z-index: 1;
          display: grid;
          gap: 9px;
          margin-top: 10px;
          padding-top: 9px;
          border-top: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
          animation: yc-fade-up 160ms var(--ease-standard) both;
        }
        .tool-section { min-width: 0; }
        .tool-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 20px;
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 600;
        }
        .tool-section-kind {
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 400;
        }
        .tool-copy {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 5px;
          border-radius: 5px;
          color: var(--text-muted);
          font-size: 10px;
        }
        .tool-copy:hover { color: var(--primary); background: var(--bg-element); }
        .tool-args,
        .tool-result {
          margin: 5px 0 0;
          padding: 8px;
          border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.5;
          background: color-mix(in srgb, var(--code-bg) 76%, var(--tool-call-bg));
          max-height: 360px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .tool-args { max-height: 220px; }
        .tool-result.err {
          color: var(--status-unavailable);
        }
        .tool-tags {
          position: relative;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin: 8px 31px 0;
        }
        .tool-tags span {
          padding: 2px 7px;
          border-radius: 999px;
          color: var(--text-secondary);
          background: var(--bg-element);
          font-size: 11px;
        }
        .search-results { display: grid; gap: 6px; margin-top: 6px; }
        .search-result {
          display: grid;
          gap: 2px;
          padding: 8px;
          border-radius: 7px;
          color: inherit;
          background: var(--code-bg);
          text-decoration: none;
        }
        .search-result:hover { background: var(--bg-element); }
        .search-result-title { color: var(--text); font-weight: 600; }
        .search-result-url,
        .search-result-meta { color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
        .search-result-snippet { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
        .tool-code { color: var(--status-unavailable); }
        .tool-meta {
          margin-top: 0;
          font-size: 11px;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
});

const TOOL_LABELS: Record<string, string> = {
  web_search: "搜索网页",
  read_document: "读取文档",
  bash: "运行命令",
  run_command: "运行命令",
  write_file: "写入文件",
  edit_file: "修改文件",
  browser: "操作浏览器",
  computer: "操作电脑",
  memory_search: "检索记忆",
  subagent: "调用子 Agent",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/[_-]+/g, " ");
}

function compactText(value: string, maxLength = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return compactText(value, 72);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return compactText(JSON.stringify(value), 72);
  } catch {
    return String(value);
  }
}

function toolInputSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${compactValue(value)}`)
    .join(" · ");
}

function formatToolDuration(durationMs?: number): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function toolSummary(
  card: ToolCard,
  searchResults: SearchResultCard[] | null,
  documentLabels: string[],
): string {
  if (card.status === "pending") return "等待确认后执行";
  if (card.status === "running") {
    const input = toolInputSummary(card.args);
    return input ? `正在处理 · ${input}` : "正在处理";
  }
  if (card.status === "error" || card.isError) {
    return card.code ? `执行失败 · ${card.code}` : "执行失败，点击查看错误详情";
  }
  if (searchResults) return `找到 ${searchResults.length} 条网页结果`;
  if (documentLabels.length > 0) return documentLabels[0];
  if (card.result !== undefined) {
    const result = compactText(card.result);
    return result || "已完成";
  }
  const input = toolInputSummary(card.args);
  return input ? `已完成 · ${input}` : "已完成";
}
