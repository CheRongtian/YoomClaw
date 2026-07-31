import { useEffect, useState, useRef, useCallback } from "react";
import type { ChatMessage, SessionSummary, AgentEvent } from "@yoomclaw/protocol";
import MessageStream, { type LiveAssistant } from "./MessageStream";
import SessionSidebar from "./SessionSidebar";
import ComposeBar from "./ComposeBar";
import WindowFrame from "./WindowFrame";
import SpiralLogo from "./SpiralLogo";
import SettingsPanel from "./SettingsPanel";
import { MenuIcon, PlusIcon, WarningIcon } from "./icons";

const GATEWAY_URL = "http://localhost:18789";
const CONFIRM_MODE_KEY = "yoomclaw-confirm-mode";

interface SessionData {
  id: string;
  title: string;
  messages: ChatMessage[];
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
  const [confirmMode, setConfirmMode] = useState<"confirm" | "no-confirm">(
    () =>
      (localStorage.getItem(CONFIRM_MODE_KEY) as "confirm" | "no-confirm") ||
      "confirm",
  );
  const confirmModeRef = useRef<"confirm" | "no-confirm">("confirm");
  confirmModeRef.current = confirmMode;

  const wsRef = useRef<WebSocket | null>(null);
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
        }
      } catch (err) {
        console.error("Failed to load session:", err);
        setCurrentMessages([]);
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
    };
    socket.onmessage = (e) => handleWsMessage(e.data.toString());
    socket.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!disposedRef.current) setTimeout(connectWs, 1500);
    };
    socket.onerror = () => {
      /* 会紧接着触发 close */
    };
  }, [apiBase]);

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
        commitLive();
        setStreaming(false);
        refreshSessions();
      } else if (msg.type === "error") {
        applyEvent({ type: "error", message: String(msg.message ?? "未知错误") });
        commitLive();
        setStreaming(false);
        refreshSessions();
      }
    },
    [applyEvent, commitLive, refreshSessions],
  );

  const stopStreaming = useCallback(() => {
    wsRef.current?.close();
    commitLive();
    setStreaming(false);
  }, [commitLive]);

  const toggleConfirmMode = useCallback(() => {
    setConfirmMode((m) => (m === "confirm" ? "no-confirm" : "confirm"));
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!currentSessionId || streaming) return;
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) {
        console.warn("WebSocket 未连接，无法发送");
        return;
      }

      const userMsg: ChatMessage = { role: "user", content: text };
      setCurrentMessages((prev) => [...prev, userMsg]);

      const fresh: LiveAssistant = { text: "", tools: [], progress: null };
      liveRef.current = fresh;
      setLive(fresh);
      setStreaming(true);

      sock.send(
        JSON.stringify({
          type: "chat",
          sessionId: currentSessionId,
          message: userMsg,
        }),
      );
    },
    [currentSessionId, streaming],
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
    <WindowFrame onOpenSettings={() => setSettingsOpen(true)}>
      <div className="app-shell">
        <SessionSidebar
          sessions={sessions}
          currentId={currentSessionId}
          open={sidebarOpen}
          onSelect={selectSession}
          onCreate={createSession}
          onDelete={deleteSession}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="chat-main">
          <header className="chat-header">
            <button
              className="header-btn"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开侧栏"
              title="打开侧栏"
            >
              <MenuIcon size={18} />
            </button>
            <h1 className="chat-title">
              <SpiralLogo size={18} /> {currentSession?.title ?? "YoomClaw"}
            </h1>
            <span
              className={`conn ${connected ? "on" : "off"}`}
              title={connected ? "已连接" : "连接中…"}
            />
            <button
              className="header-btn new-chat"
              onClick={createSession}
              title="新建对话"
            >
              <PlusIcon size={18} />
            </button>
          </header>

          {!currentSessionId ? (
            <div className="empty-state">
              <SpiralLogo size={72} />
              <h2>YoomClaw</h2>
              <p>
                你的本地 AI 助手 · 点击 <b>＋</b> 开始对话
              </p>
            </div>
          ) : (
            <MessageStream messages={currentMessages} live={live ?? undefined} />
          )}

          <ComposeBar
            onSend={sendMessage}
            onStop={stopStreaming}
            disabled={!currentSessionId || !connected}
            streaming={streaming}
            confirmMode={confirmMode}
            onToggleConfirmMode={toggleConfirmMode}
          />
          <div ref={messagesEndRef} />
        </main>
      </div>

      {confirmDialog && (
        <div className="modal-mask" onClick={() => confirmDecision(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              <WarningIcon size={16} /> 需要确认
            </div>
            <div className="modal-name">
              工具：<b>{confirmDialog.name}</b>
            </div>
            <pre className="modal-args">
              {JSON.stringify(confirmDialog.args, null, 2)}
            </pre>
            <div className="modal-reason">{confirmDialog.reason}</div>
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
          gap: 12px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-panel);
          -webkit-app-region: drag;
        }
        .header-btn {
          -webkit-app-region: no-drag;
          font-size: 18px;
          padding: 6px 8px;
          border-radius: 6px;
          color: var(--text-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .header-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .header-btn.new-chat {
          width: 32px;
          height: 32px;
        }
        .chat-title {
          flex: 1;
          font-size: 14px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .chat-title :global(svg) {
          color: var(--primary);
        }
        .conn {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .conn.on {
          background: var(--success);
        }
        .conn.off {
          background: var(--error);
        }
        .empty-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: var(--text-secondary);
        }
        .empty-state :global(svg) {
          color: var(--primary);
          margin-bottom: 8px;
        }
        .empty-state h2 {
          font-size: 28px;
          color: var(--text);
          font-weight: 600;
          letter-spacing: -0.5px;
        }
        .modal-mask {
          position: fixed;
          inset: 0;
          background: var(--modal-mask);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .modal {
          width: 420px;
          max-width: 90vw;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 18px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
        }
        .modal-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .modal-title :global(svg) {
          color: var(--warning);
        }
        .modal-name {
          font-size: 13px;
          color: var(--text-secondary);
          margin-bottom: 8px;
        }
        .modal-args {
          background: var(--code-bg);
          padding: 10px;
          border-radius: 8px;
          font-size: 12px;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          margin: 0 0 10px;
        }
        .modal-reason {
          font-size: 13px;
          color: var(--warning);
          margin-bottom: 16px;
        }
        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }
        .btn {
          padding: 8px 18px;
          border-radius: 8px;
          font-size: 13px;
          border: none;
          cursor: pointer;
        }
        .btn.deny {
          background: var(--bg-element);
          color: var(--text);
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
