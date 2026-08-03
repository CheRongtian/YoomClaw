import { useEffect, useState, useRef, useCallback } from "react";
import type {
  ChatMessage,
  SessionSummary,
  AgentEvent,
  ContentPart,
  TextContentPart,
  FileUploadResponse,
} from "@yoomclaw/protocol";
import MessageStream, { type LiveAssistant } from "./MessageStream";
import SessionSidebar from "./SessionSidebar";
import ComposeBar, { type ComposePrefill } from "./ComposeBar";
import WindowFrame from "./WindowFrame";
import SpiralLogo from "./SpiralLogo";
import SettingsPanel from "./SettingsPanel";
import { PanelLeftIcon, PlusIcon, ShieldIcon, WarningIcon } from "./icons";

const GATEWAY_URL = "http://localhost:18789";
const CONFIRM_MODE_KEY = "yoomclaw-confirm-mode";

/** 读取本地文件为 data URL，用于通过网关 /api/upload/file 上传。 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface SessionData {
  id: string;
  title: string;
  messages: ChatMessage[];
  runs?: Array<{ status: "running" | "completed" | "interrupted" | "failed" }>;
}

interface ConfirmDialog {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  reason: string;
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentMessages, setCurrentMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveAssistant | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState<"confirm" | "no-confirm">(
    () =>
      (localStorage.getItem(CONFIRM_MODE_KEY) as "confirm" | "no-confirm") ||
      "confirm",
  );
  const confirmModeRef = useRef<"confirm" | "no-confirm">("confirm");
  confirmModeRef.current = confirmMode;

  const wsRef = useRef<WebSocket | null>(null);
  const runIdRef = useRef<string | null>(null);
  const liveRef = useRef<LiveAssistant | null>(null);
  const disposedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiBase = GATEWAY_URL;

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/sessions`);
      if (res.ok) {
        const data = (await res.json()) as SessionSummary[];
        setSessions(data);
        if (data.length > 0 && !currentSessionId) {
          selectSession(data[0].id);
        } else if (data.length === 0) {
          setCurrentSessionId(null);
          setCurrentMessages([]);
          setRunNotice(null);
        }
      }
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const selectSession = useCallback(
    async (id: string) => {
      setCurrentSessionId(id);
      liveRef.current = null;
      setLive(null);
      setConfirmDialog(null);
      try {
        const res = await fetch(`${apiBase}/api/sessions/${id}`);
        if (res.ok) {
          const data = (await res.json()) as SessionData;
          setCurrentMessages(data.messages ?? []);
          const lastRun = data.runs?.[data.runs.length - 1];
          setRunNotice(
            lastRun?.status === "interrupted"
              ? "上一轮任务在应用重启前已中断，可继续发送新任务。"
              : lastRun?.status === "failed"
                ? "上一轮任务执行失败，可查看历史消息后继续。"
                : null,
          );
        }
      } catch (err) {
        console.error("Failed to load session:", err);
        setCurrentMessages([]);
        setRunNotice(null);
      }
    },
    [apiBase],
  );

  const createSession = useCallback(async () => {
    try {
      const title = `新的对话 ${new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}`;
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        const session = (await res.json()) as SessionSummary;
        setSessions((prev) => [session, ...prev]);
        setCurrentSessionId(session.id);
        setCurrentMessages([]);
        setRunNotice(null);
      }
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  }, [apiBase]);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`${apiBase}/api/sessions/${id}`, { method: "DELETE" });
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (currentSessionId === id) {
          setCurrentSessionId(null);
          setCurrentMessages([]);
          setRunNotice(null);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [apiBase, currentSessionId],
  );

  // ===== WebSocket 连接 =====
  const sendConfirmMode = useCallback((mode: "confirm" | "no-confirm") => {
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "setConfirmMode", mode }));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(CONFIRM_MODE_KEY, confirmMode);
    sendConfirmMode(confirmMode);
  }, [confirmMode, sendConfirmMode]);

  const connectWs = useCallback(() => {
    const url = wsUrl(apiBase);
    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnected(true);
      sendConfirmMode(confirmModeRef.current);
      void refreshSessions();
    };
    socket.onmessage = (e) => handleWsMessage(e.data.toString());
    socket.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      setStreaming(false);
      if (!disposedRef.current) setTimeout(connectWs, 1500);
    };
    socket.onerror = () => {
      /* 会紧接着触发 close */
    };
  }, [apiBase, refreshSessions]);

  useEffect(() => {
    disposedRef.current = false;
    connectWs();
    return () => {
      disposedRef.current = true;
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWs]);

  const ensureLive = (l: LiveAssistant | null): LiveAssistant =>
    l ?? { text: "", tools: [], progress: null };

  const applyEvent = useCallback((ev: AgentEvent) => {
    const l = ensureLive(liveRef.current);
    let next: LiveAssistant;
    switch (ev.type) {
      case "delta":
        next = { ...l, text: l.text + ev.text };
        break;
      case "progress":
        next = { ...l, progress: { name: ev.name, percent: ev.percent } };
        break;
      case "tool_confirm":
        next = {
          ...l,
          text: "",
          progress: null,
          tools: [
            ...l.tools,
            { callId: ev.callId, name: ev.name, args: ev.args, status: "pending" },
          ],
        };
        break;
      case "tool_start":
        next = {
          ...l,
          text: "",
          progress: null,
          tools: l.tools.map((t) =>
            t.callId === ev.callId ? { ...t, status: "running" } : t,
          ),
        };
        break;
      case "tool_end":
        next = {
          ...l,
          tools: l.tools.map((t) =>
            t.callId === ev.callId
              ? {
                  ...t,
                  status: ev.isError ? "error" : "done",
                  result: ev.result,
                  isError: ev.isError,
                  durationMs: ev.durationMs,
                }
              : t,
          ),
        };
        break;
      case "final":
        next = { ...l, text: ev.text, progress: null };
        break;
      case "error":
        next = {
          ...l,
          progress: null,
          text: (l.text ? l.text + "\n\n" : "") + ev.message,
        };
        break;
      case "run":
        next = { ...l, progress: ev.status === "running" ? { name: "任务运行中", percent: 0 } : null };
        break;
      case "memory":
        next = { ...l, progress: { name: `记忆${ev.action}`, percent: 0 } };
        break;
      case "skill_draft":
        next = { ...l, progress: { name: `Skill ${ev.status}`, percent: 0 } };
        break;
      case "browser":
        next = { ...l, progress: { name: `浏览器${ev.status}`, percent: 0 } };
        break;
      case "vision":
        next = {
          ...l,
          progress: {
            name: ev.status === "error"
              ? `识图失败：${ev.message ?? "未知错误"}`
              : `识图${ev.status === "started" ? "中" : "完成"}`,
            percent: ev.status === "completed" ? 100 : 0,
          },
        };
        break;
      default:
        next = l;
    }
    liveRef.current = next;
    setLive(next);

    if (ev.type === "tool_confirm") {
      setConfirmDialog({
        callId: ev.callId,
        name: ev.name,
        args: ev.args,
        reason: ev.reason,
      });
    }
  }, []);

  const commitLive = useCallback(() => {
    const l = liveRef.current;
    if (l) {
      const text = l.text.trim();
      if (text || l.tools.length > 0) {
        setCurrentMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: text || "（已完成工具调用，无文本输出）",
          },
        ]);
      }
    }
    liveRef.current = null;
    setLive(null);
    setConfirmDialog(null);
  }, []);

  const handleWsMessage = useCallback(
    (raw: string) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "chat.event") {
        applyEvent(msg.event as AgentEvent);
      } else if (msg.type === "chat.end") {
        if (msg.status === "interrupted") applyEvent({ type: "error", message: "任务已中断" });
        if (msg.status === "failed") applyEvent({ type: "error", message: "任务执行失败" });
        commitLive();
        setStreaming(false);
        runIdRef.current = null;
        refreshSessions();
      } else if (msg.type === "error") {
        applyEvent({ type: "error", message: String(msg.message ?? "未知错误") });
        commitLive();
        setStreaming(false);
        runIdRef.current = null;
        refreshSessions();
      }
    },
    [applyEvent, commitLive, refreshSessions],
  );

  const stopStreaming = useCallback(() => {
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN && currentSessionId && runIdRef.current) {
      sock.send(JSON.stringify({
        type: "chat.cancel",
        sessionId: currentSessionId,
        runId: runIdRef.current,
      }));
    }
    commitLive();
    setStreaming(false);
    runIdRef.current = null;
  }, [commitLive, currentSessionId]);

  const toggleConfirmMode = useCallback(() => {
    setConfirmMode((m) => (m === "confirm" ? "no-confirm" : "confirm"));
  }, []);

  /** 空状态建议 chip：先建会话，再把提示词预填进输入框 */
  const startWithPrompt = useCallback(
    (text: string) => {
      createSession();
      setPrefill({ text, nonce: Date.now() });
    },
    [createSession],
  );

  const sendMessage = useCallback(
    async (text: string, files: File[]) => {
      if (!currentSessionId || streaming) return;
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) {
        console.warn("WebSocket 未连接，无法发送");
        return;
      }

      // 构造多模态消息：文本 + 已上传的附件
      const parts: ContentPart[] = [];
      const trimmed = text.trim();
      if (trimmed) parts.push({ type: "text", text: trimmed });

      for (const file of files) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const resp = await fetch(`${apiBase}/api/upload/file`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: dataUrl, source: "desktop" }),
          });
          if (resp.ok) {
            const up = (await resp.json()) as FileUploadResponse;
            if (file.type.startsWith("image/")) {
              parts.push({ type: "image_url", image_url: { url: up.url } });
            } else {
              parts.push({ type: "file_url", file_url: { url: up.url, fileId: up.fileId } });
            }
          } else {
            parts.push({ type: "text", text: `[附件 ${file.name} 上传失败]` });
          }
        } catch {
          parts.push({ type: "text", text: `[附件 ${file.name} 上传失败]` });
        }
      }

      const userMsg: ChatMessage =
        parts.length === 1 && parts[0].type === "text"
          ? { role: "user", content: (parts[0] as TextContentPart).text }
          : { role: "user", content: parts };

      setCurrentMessages((prev) => [...prev, userMsg]);

      const fresh: LiveAssistant = { text: "", tools: [], progress: null };
      liveRef.current = fresh;
      setLive(fresh);
      setStreaming(true);
      const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      runIdRef.current = runId;

      sock.send(
        JSON.stringify({
          type: "chat.start",
          sessionId: currentSessionId,
          runId,
          message: userMsg,
        }),
      );
    },
    [currentSessionId, streaming, apiBase],
  );

  const confirmDecision = useCallback(
    (approved: boolean) => {
      if (!confirmDialog || !currentSessionId) return;
      wsRef.current?.send(
        JSON.stringify({
          type: "tool.decision",
          sessionId: currentSessionId,
          decision: { callId: confirmDialog.callId, approved },
        }),
      );
      setConfirmDialog(null);
    },
    [confirmDialog, currentSessionId],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentMessages, live]);

  // 托盘菜单的"设置"入口
  useEffect(() => {
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (!claw?.on) return;
    return claw.on("menu:open-settings", () => setSettingsOpen(true));
  }, []);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  return (
    <WindowFrame>
      <div className="app-shell">
        <SessionSidebar
          sessions={sessions}
          currentId={currentSessionId}
          open={sidebarOpen}
          onSelect={selectSession}
          onCreate={createSession}
          onDelete={deleteSession}
          onClose={() => setSidebarOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="chat-main">
          <header className="chat-header">
            <div className="header-left">
              <button
                className="header-btn"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label="切换侧栏"
                title="切换侧栏"
              >
                <PanelLeftIcon size={20} />
              </button>
              <h1 className="chat-title">
                {currentSession?.title ?? "YoomClaw"}
              </h1>
            </div>
            <div className="header-right">
              <span
                className={`conn-chip ${connected ? "on" : "off"}`}
                title={connected ? "已连接" : "连接中…"}
              >
                <span className="conn-dot" />
                {connected ? "已连接" : "连接中"}
              </span>
              <button
                type="button"
                className={`mode-chip ${confirmMode}`}
                onClick={toggleConfirmMode}
                title="切换工具执行模式；工作区内安全操作自动执行，高风险操作始终需要确认"
              >
                <ShieldIcon size={16} />
                {confirmMode === "no-confirm" ? "工作区自动" : "高风险确认"}
              </button>
            </div>
          </header>

          {runNotice && <div className="run-notice">{runNotice}</div>}

          {!currentSessionId ? (
            <div className="empty-state">
              <SpiralLogo size={56} />
              <h2>YoomClaw</h2>
              <p>你的本地 AI 助手 · 数据不上传</p>
              <button className="empty-cta" onClick={createSession}>
                <PlusIcon size={16} />
                <span>开始新对话</span>
              </button>
              <div className="empty-chips">
                {["解释这段代码", "重构前端布局", "写一个单元测试"].map((t) => (
                  <button
                    key={t}
                    className="empty-chip"
                    onClick={() => startWithPrompt(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageStream messages={currentMessages} live={live ?? undefined} />
          )}

          <ComposeBar
            onSend={sendMessage}
            onStop={stopStreaming}
            disabled={!currentSessionId || !connected}
            streaming={streaming}
            prefill={prefill}
          />
          <div ref={messagesEndRef} />
        </main>
      </div>

      {confirmDialog && (
        <div className="modal-mask" onClick={() => confirmDecision(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-icon">
                <WarningIcon size={16} />
              </div>
              <div className="modal-titles">
                <div className="modal-title">需要确认</div>
                <div className="modal-sub">工具即将执行，确认后才会继续</div>
              </div>
            </div>

            <div className="modal-field">
              <div className="modal-label">工具名称</div>
              <div className="modal-name">{confirmDialog.name}</div>
            </div>

            <div className="modal-field">
              <div className="modal-label">调用参数</div>
              <pre className="modal-args">
                {JSON.stringify(confirmDialog.args, null, 2)}
              </pre>
            </div>

            {confirmDialog.reason && (
              <div className="modal-field">
                <div className="modal-label">说明</div>
                <div className="modal-reason">{confirmDialog.reason}</div>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn deny" onClick={() => confirmDecision(false)}>
                拒绝
              </button>
              <button className="btn allow" onClick={() => confirmDecision(true)}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <style jsx>{`
        .app-shell {
          display: flex;
          height: 100%;
          width: 100%;
          overflow: hidden;
        }
        .chat-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          background: var(--bg);
        }
        .chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 52px;
          padding: 0 16px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-panel);
          -webkit-app-region: drag;
          flex-shrink: 0;
        }
        .run-notice {
          flex-shrink: 0;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
          background: color-mix(in srgb, var(--warning) 10%, var(--bg));
          color: var(--warning);
          font-size: 12px;
        }
        /* 三段式：左侧导航组 / 右侧状态组 */
        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          -webkit-app-region: no-drag;
        }
        .header-right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          -webkit-app-region: no-drag;
        }
        /* 图标按钮统一 32×32、圆角 8 */
        .header-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          color: var(--text-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .header-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .chat-title {
          font-size: 14px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
        }
        /* 连接状态 chip：点 + 文字，可读性优于孤立圆点 */
        .conn-chip {
          display: flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          background: var(--bg-element);
          font-size: 12px;
          color: var(--text-secondary);
          white-space: nowrap;
        }
        .conn-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--error);
        }
        .conn-chip.on .conn-dot {
          background: var(--success);
        }
        /* 确认模式 chip：盾牌图标 + 文字；放行态转警示色 */
        .mode-chip {
          display: flex;
          align-items: center;
          gap: 5px;
          height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .mode-chip:hover {
          border-color: var(--border-active);
          color: var(--text);
        }
        .mode-chip.no-confirm {
          background: color-mix(in srgb, var(--warning) 14%, transparent);
          border-color: var(--warning);
          color: var(--warning);
        }
        .empty-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: var(--text-secondary);
        }
        .empty-state :global(svg) {
          color: var(--primary);
          margin-bottom: 4px;
        }
        .empty-state h2 {
          font-size: 26px;
          color: var(--text);
          font-weight: 600;
          letter-spacing: -0.5px;
        }
        .empty-state p {
          font-size: 13px;
        }
        .empty-cta {
          display: flex;
          align-items: center;
          gap: 6px;
          height: 40px;
          padding: 0 18px;
          margin-top: 4px;
          border-radius: 10px;
          background: var(--primary);
          color: var(--on-primary);
          font-size: 14px;
          font-weight: 500;
          transition: filter 0.15s;
        }
        .empty-cta:hover {
          background: var(--primary);
          filter: brightness(1.08);
        }
        .empty-chips {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }
        .empty-chip {
          padding: 9px 13px;
          border-radius: 10px;
          background: var(--bg-panel);
          border: 1px solid var(--border);
          font-size: 12.5px;
          color: var(--text-secondary);
          transition: border-color 0.15s, color 0.15s;
        }
        .empty-chip:hover {
          border-color: var(--border-active);
          color: var(--text);
        }
        .modal-mask {
          position: fixed;
          inset: 0;
          background: var(--modal-mask);
          backdrop-filter: blur(2px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
          padding: 20px;
        }
        .modal {
          width: 440px;
          max-width: 100%;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 20px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        }
        .modal-head {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .modal-icon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: color-mix(in srgb, var(--warning) 18%, transparent);
          color: var(--warning);
        }
        .modal-titles {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .modal-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text);
          line-height: 1.3;
        }
        .modal-sub {
          font-size: 12px;
          color: var(--text-muted);
          line-height: 1.3;
        }
        .modal-field {
          margin-bottom: 14px;
        }
        .modal-label {
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .modal-name {
          font-size: 13.5px;
          color: var(--text);
          font-weight: 500;
          font-family: var(--font-mono);
          word-break: break-word;
        }
        .modal-args {
          background: var(--code-bg);
          padding: 12px;
          border-radius: 10px;
          border: 1px solid var(--border);
          font-size: 12px;
          line-height: 1.5;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          margin: 0;
          font-family: var(--font-mono);
          color: var(--text-secondary);
        }
        .modal-reason {
          font-size: 13px;
          line-height: 1.5;
          color: var(--text-secondary);
          background: var(--bg-element);
          padding: 10px 12px;
          border-radius: 10px;
        }
        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 18px;
        }
        .btn {
          padding: 9px 20px;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 500;
          border: none;
          cursor: pointer;
          transition: filter 0.15s, background 0.15s;
        }
        .btn.deny {
          background: var(--bg-element);
          color: var(--text);
          border: 1px solid var(--border);
        }
        .btn.allow {
          background: var(--primary);
          color: var(--on-primary);
        }
        .btn:hover {
          filter: brightness(1.08);
        }
      `}</style>
    </WindowFrame>
  );
}

function wsUrl(apiBase: string): string {
  if (apiBase) {
    try {
      const u = new URL(apiBase);
      const proto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${u.host}/ws`;
    } catch {
      /* fallthrough */
    }
  }
  return "ws://localhost:18789/ws";
}
