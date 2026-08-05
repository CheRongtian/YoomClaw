import { useEffect, useState, useRef, useCallback } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type {
  ChatMessage,
  SessionSummary,
  AgentEvent,
  ContentPart,
  FileUploadResponse,
  LocalFileReadResponse,
  PdfReadResponse,
  PlanState,
  SafetyMode,
} from "@yoomclaw/protocol";
import {
  classifyFileInput,
  countAttachmentParts,
  countImageAttachmentParts,
  extractLocalFilePathCandidates,
  getFileInputRule,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
} from "@yoomclaw/protocol";
import MessageStream, {
  type LiveAssistant,
  type ToolCard,
  messageTextWithPaths,
  toolCardsFromEvents,
} from "./MessageStream";
import SessionSidebar from "./SessionSidebar";
import ComposeBar, { type ComposeAttachment, type ComposePrefill } from "./ComposeBar";
import WindowFrame from "./WindowFrame";
import SpiralLogo from "./SpiralLogo";
import SettingsPanel from "./SettingsPanel";
import WorkbenchPanel from "./WorkbenchPanel";
import {
  PanelLeftIcon,
  PlusIcon,
  ShieldIcon,
  CheckIcon,
  WarningIcon,
  TaskIcon,
  ExportIcon,
  InfoIcon,
} from "./icons";

const GATEWAY_URL = "http://localhost:18789";
const SAFETY_MODE_KEY = "yoomclaw-safety-mode";
const SIDEBAR_WIDTH_KEY = "yoomclaw-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 440;

const SAFETY_MODE_OPTIONS: Array<{
  value: SafetyMode;
  label: string;
  detail: string;
}> = [
  {
    value: "confirm",
    label: "请求批准",
    detail: "编辑外部文件和使用互联网时始终询问",
  },
  {
    value: "workspace-auto",
    label: "替我审批",
    detail: "仅对检测到的风险操作请求批准",
  },
  {
    value: "full-access",
    label: "完全访问权限",
    detail: "不受限制地访问互联网和您电脑上的任何文件",
  },
];

function normalizeSafetyMode(value: unknown): SafetyMode {
  if (value === "confirm" || value === "workspace-auto" || value === "full-access") {
    return value;
  }
  // Older clients stored the two-state `no-confirm` value locally.
  if (value === "no-confirm") return "workspace-auto";
  return "workspace-auto";
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

const SESSION_TITLE_MAX_LENGTH = 80;

function firstInputTitle(content: ChatMessage["content"]): string | undefined {
  const text = typeof content === "string"
    ? content
    : content
      .filter((part) => part.type === "text")
      .map((part) => part.type === "text" ? part.text : "")
      .join(" ");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized) {
    return normalized.length > SESSION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
      : normalized;
  }
  return Array.isArray(content) && content.some((part) => part.type !== "text")
    ? "附件"
    : undefined;
}

function planFromEvents(events: AgentEvent[]): PlanState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "plan") return event.plan;
  }
  return null;
}

/** 读取本地文件为 data URL，用于通过网关 /api/upload/file 上传。 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function resolveLocalFilePath(
  apiBase: string,
  filePath: string,
): Promise<LocalFileReadResponse> {
  const response = await fetch(`${apiBase}/api/files/read-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as
    | (Partial<LocalFileReadResponse> & { code?: unknown; error?: unknown })
    | null;
  if (!response.ok || body?.ok !== true || typeof body.dataUrl !== "string") {
    const code = typeof body?.code === "string" ? body.code : `HTTP_${response.status}`;
    throw new Error(code);
  }
  return body as LocalFileReadResponse;
}

function appendPdfParts(
  fileName: string,
  parsed: PdfReadResponse,
  displayParts: ContentPart[],
  providerParts: ContentPart[],
): void {
  const extracted = parsed.text.trim();
  const content = extracted || "[PDF 中未提取到可复制文本，可能是扫描件]";
  const limitNotice = parsed.truncated
    ? "\n[PDF 内容已截断，仅发送前 50 页或 6 万字符]"
    : "";
  displayParts.push({
    type: "text",
    text: `[已解析 PDF：${fileName}，共 ${parsed.pages} 页${parsed.truncated ? "，内容已截断" : ""}]`,
  });
  providerParts.push({
    type: "text",
    text: `[本地 PDF 内容：${fileName}]\n${content}${limitNotice}`,
  });
}

function appendAttachmentFailure(
  fileName: string,
  reason: string,
  displayParts: ContentPart[],
  providerParts: ContentPart[],
  attachmentFailures: string[],
): void {
  const failure = `[附件 ${fileName} ${reason}]`;
  displayParts.push({ type: "text", text: failure });
  providerParts.push({ type: "text", text: failure });
  attachmentFailures.push(failure);
}

function describeLocalPathFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "LOCAL_FILE_BLOCKED") return "当前访问模式不允许读取工作区外文件";
  if (code === "FILE_TOO_LARGE") return "文件超过单文件大小限制";
  if (code === "UNSUPPORTED_FILE_TYPE") return "不支持的文件类型";
  if (code === "LOCAL_FILE_NOT_A_FILE") return "路径不是文件";
  if (code === "LOCAL_FILE_READ_FAILED") return "文件读取失败";
  return code || "本地路径不可用";
}

function contentFromParts(parts: ContentPart[]): string | ContentPart[] {
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n");
  }
  return parts;
}

function exportContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image_url") return `![图片附件](${part.image_url.url})`;
    return `[文件附件${part.file_url.fileId ? ` (${part.file_url.fileId})` : ""}](${part.file_url.url})`;
  }).join("\n\n");
}

function markdownForSession(title: string, messages: ChatMessage[], events: AgentEvent[]): string {
  const lines = [`# ${title || "YoomClaw 对话"}`, ""];
  for (const message of messages) {
    const role = message.role === "user" ? "用户" : message.role === "assistant" ? "YoomClaw" : message.role;
    lines.push(`## ${role}`, "", exportContent(message.content), "");
  }
  const tools = toolCardsFromEvents(events);
  if (tools.length > 0) {
    lines.push("## 工具活动", "");
    for (const tool of tools) {
      lines.push(`- **${tool.name}** (${tool.status})`);
      if (tool.result) lines.push("", "```text", tool.result, "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function sortSessionSummaries(items: SessionSummary[]): SessionSummary[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

interface SessionData {
  id: string;
  title: string;
  messages: ChatMessage[];
  meta?: Record<string, unknown>;
  runs?: Array<{
    status: "running" | "completed" | "interrupted" | "failed";
    events?: AgentEvent[];
  }>;
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
  const [historicalTools, setHistoricalTools] = useState<ToolCard[]>([]);
  const [runEvents, setRunEvents] = useState<AgentEvent[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const currentSessionTitleRef = useRef("YoomClaw");
  const sessionViewRevisionRef = useRef(0);
  const sessionRefreshRequestRef = useRef(0);
  const sessionDataRevisionRef = useRef(0);
  const sessionMutationRevisionRef = useRef(new Map<string, number>());
  const sessionMutationQueueRef = useRef(new Map<string, Promise<unknown>>());
  const sessionCreationRef = useRef(false);
  currentSessionIdRef.current = currentSessionId;
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveAssistant | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? clampSidebarWidth(saved)
      : DEFAULT_SIDEBAR_WIDTH;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
  const [editTargetIndex, setEditTargetIndex] = useState<number | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [safetyMode, setSafetyMode] = useState<SafetyMode>(() => normalizeSafetyMode(
    localStorage.getItem(SAFETY_MODE_KEY) ?? localStorage.getItem("yoomclaw-confirm-mode"),
  ));
  const safetyModeRef = useRef<SafetyMode>("workspace-auto");
  safetyModeRef.current = safetyMode;
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const runIdRef = useRef<string | null>(null);
  const liveRef = useRef<LiveAssistant | null>(null);
  const disposedRef = useRef(false);
  const wsGenerationRef = useRef(0);
  const wsReconnectTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modePickerRef = useRef<HTMLDivElement | null>(null);
  const selectedSafetyMode = SAFETY_MODE_OPTIONS.find((option) => option.value === safetyMode) ?? SAFETY_MODE_OPTIONS[1];

  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiBase = GATEWAY_URL;

  useEffect(() => {
    let alive = true;
    void fetch(`${apiBase}/api/config`)
      .then((res) => res.ok ? res.json() as Promise<{
        workspace?: string;
        safetyMode?: SafetyMode;
        promptMode?: "provider" | "local";
      }> : null)
      .then((config) => {
        if (!alive) return;
        if (config?.workspace) setWorkspace(config.workspace);
        if (config?.safetyMode) setSafetyMode(normalizeSafetyMode(config.safetyMode));
        // The Provider topic is the single source of static behavior rules.
        // Upgrade an older persisted local-mode setting when the chat opens so
        // the renderer never causes the full local prompt bundle to be sent.
        if (config?.promptMode === "local") {
          void fetch(`${apiBase}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptMode: "provider" }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!workbenchOpen) return;
    let alive = true;
    let attempts = 0;
    let retryTimer: number | null = null;
    const loadWorkspace = () => {
      void fetch(`${apiBase}/api/config`)
        .then((res) => res.ok ? res.json() as Promise<{ workspace?: string }> : null)
        .then((config) => {
          if (!alive) return;
          if (config?.workspace) {
            setWorkspace(config.workspace);
            return;
          }
          if (attempts < 5) {
            attempts += 1;
            retryTimer = window.setTimeout(loadWorkspace, 500);
          }
        })
        .catch(() => {
          if (alive && attempts < 5) {
            attempts += 1;
            retryTimer = window.setTimeout(loadWorkspace, 500);
          }
        });
    };
    loadWorkspace();
    return () => {
      alive = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [apiBase, workbenchOpen]);

  const refreshSessions = useCallback(async () => {
    const requestId = ++sessionRefreshRequestRef.current;
    const dataRevision = sessionDataRevisionRef.current;
    try {
      const res = await fetch(`${apiBase}/api/sessions`);
      if (res.ok) {
        const data = (await res.json()) as SessionSummary[];
        if (
          requestId !== sessionRefreshRequestRef.current ||
          dataRevision !== sessionDataRevisionRef.current
        ) {
          return;
        }
        setSessions(sortSessionSummaries(data));
        const currentId = currentSessionIdRef.current;
        if (data.length > 0 && !currentId) {
          selectSession(data[0].id);
        } else if (data.length === 0 && !currentId) {
          currentSessionIdRef.current = null;
          setCurrentSessionId(null);
          setCurrentMessages([]);
          setHistoricalTools([]);
          setRunEvents([]);
          setPlan(null);
          setRunNotice(null);
        } else if (currentId && !data.some((session) => session.id === currentId)) {
          sessionViewRevisionRef.current += 1;
          currentSessionIdRef.current = null;
          runIdRef.current = null;
          liveRef.current = null;
          setCurrentSessionId(null);
          setCurrentMessages([]);
          setHistoricalTools([]);
          setRunEvents([]);
          setPlan(null);
          setLive(null);
          setConfirmDialog(null);
          setStreaming(false);
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
      const revision = ++sessionViewRevisionRef.current;
      const previousSessionId = currentSessionIdRef.current;
      if (previousSessionId && previousSessionId !== id && runIdRef.current) {
        const socket = wsRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({
              type: "chat.cancel",
              sessionId: previousSessionId,
              runId: runIdRef.current,
            }));
          } catch {}
        }
        runIdRef.current = null;
        setStreaming(false);
      }
      currentSessionIdRef.current = id;
      setCurrentSessionId(id);
      liveRef.current = null;
      setLive(null);
      setHistoricalTools([]);
      setConfirmDialog(null);
      setEditTargetIndex(null);
      try {
        const res = await fetch(`${apiBase}/api/sessions/${id}`);
        if (!res.ok) throw new Error(`session load failed: ${res.status}`);
        if (res.ok) {
          const data = (await res.json()) as SessionData;
          if (
            revision !== sessionViewRevisionRef.current ||
            currentSessionIdRef.current !== id
          ) {
            return;
          }
          setCurrentMessages(data.messages ?? []);
          const lastRun = data.runs?.[data.runs.length - 1];
          setRunEvents(lastRun?.events ?? []);
          const persistedPlan = data.meta?.plan && typeof data.meta.plan === "object"
            ? data.meta.plan as PlanState
            : null;
          setPlan(planFromEvents(lastRun?.events ?? []) ?? persistedPlan);
          setHistoricalTools(toolCardsFromEvents(lastRun?.events ?? []));
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
        if (
          revision !== sessionViewRevisionRef.current ||
          currentSessionIdRef.current !== id
        ) {
          return;
        }
        setCurrentMessages([]);
        setRunEvents([]);
        setPlan(null);
        setHistoricalTools([]);
        setRunNotice(null);
      }
    },
    [apiBase],
  );

  const createSession = useCallback(async () => {
    if (sessionCreationRef.current) return;
    sessionCreationRef.current = true;
    const previousSessionId = currentSessionIdRef.current;
    const creationRevision = ++sessionViewRevisionRef.current;
    if (previousSessionId && runIdRef.current) {
      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({
            type: "chat.cancel",
            sessionId: previousSessionId,
            runId: runIdRef.current,
          }));
        } catch {}
      }
      runIdRef.current = null;
      setStreaming(false);
      liveRef.current = null;
      setLive(null);
    }
    sessionDataRevisionRef.current += 1;
    currentSessionIdRef.current = null;
    setCurrentSessionId(null);
    setCurrentMessages([]);
    setHistoricalTools([]);
    setRunEvents([]);
    setPlan(null);
    setRunNotice(null);
    setEditTargetIndex(null);
    setCreatingSession(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`session creation failed: ${res.status}`);
      const session = (await res.json()) as SessionSummary;
      sessionDataRevisionRef.current += 1;
      setSessions((prev) => sortSessionSummaries([session, ...prev]));
      if (
        creationRevision !== sessionViewRevisionRef.current ||
        currentSessionIdRef.current !== null
      ) {
        return;
      }
      sessionViewRevisionRef.current += 1;
      currentSessionIdRef.current = session.id;
      setCurrentSessionId(session.id);
      setCurrentMessages([]);
      setHistoricalTools([]);
      setRunEvents([]);
      setPlan(null);
      setRunNotice(null);
      setEditTargetIndex(null);
    } catch (err) {
      console.error("Failed to load session:", err);
      if (
        creationRevision === sessionViewRevisionRef.current &&
        currentSessionIdRef.current === null &&
        previousSessionId
      ) {
        currentSessionIdRef.current = previousSessionId;
        setCurrentSessionId(previousSessionId);
        void selectSession(previousSessionId);
      } else if (creationRevision === sessionViewRevisionRef.current) {
        setRunNotice("Session creation failed; please retry.");
      }
    } finally {
      sessionCreationRef.current = false;
      setCreatingSession(false);
    }
  }, [apiBase, selectSession]);

  const patchSession = useCallback(
    async (id: string, patch: { title?: string; archived?: boolean; pinned?: boolean }) => {
      const mutationRevision = (sessionMutationRevisionRef.current.get(id) ?? 0) + 1;
      sessionMutationRevisionRef.current.set(id, mutationRevision);
      const previous = sessionMutationQueueRef.current.get(id) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
        const res = await fetch(`${apiBase}/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) return null;
        return (await res.json()) as SessionSummary;
      });
      sessionMutationQueueRef.current.set(id, operation);
      try {
        const updated = await operation;
        if (
          !updated ||
          sessionMutationRevisionRef.current.get(id) !== mutationRevision
        ) return null;
        setSessions((previous) => sortSessionSummaries(previous.map((session) => (
          session.id === id ? updated : session
        ))));
        return updated;
      } finally {
        if (sessionMutationQueueRef.current.get(id) === operation) {
          sessionMutationQueueRef.current.delete(id);
        }
      }
    },
    [apiBase],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const nextTitle = title.trim();
      if (!nextTitle) return;
      try {
        await patchSession(id, { title: nextTitle });
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },
    [patchSession],
  );

  const updateSessionFlags = useCallback(
    (id: string, patch: { pinned?: boolean }) => {
      return patchSession(id, patch).catch((err) => {
        console.error("Failed to update session flags:", err);
        return null;
      });
    },
    [patchSession],
  );

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarOpen) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      currentWidth: sidebarWidth,
    };
    setSidebarResizing(true);
  }, [sidebarOpen, sidebarWidth]);

  const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = sidebarResizeRef.current;
    if (!resize) return;
    const nextWidth = clampSidebarWidth(resize.startWidth + event.clientX - resize.startX);
    resize.currentWidth = nextWidth;
    pendingSidebarWidthRef.current = nextWidth;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const previewWidth = pendingSidebarWidthRef.current;
      if (previewWidth !== null) {
        appShellRef.current?.style.setProperty("--sidebar-width", `${previewWidth}px`);
      }
    });
  }, []);

  const finishSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = sidebarResizeRef.current;
    if (!resize) return;
    sidebarResizeRef.current = null;
    pendingSidebarWidthRef.current = null;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    appShellRef.current?.style.setProperty("--sidebar-width", `${resize.currentWidth}px`);
    setSidebarWidth(resize.currentWidth);
    setSidebarResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }
  }, []);

  const searchSessions = useCallback(
    async (query: string): Promise<SessionSummary[] | null> => {
      const trimmed = query.trim();
      if (!trimmed) return null;
      try {
        const res = await fetch(`${apiBase}/api/sessions/search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) return null;
        return (await res.json()) as SessionSummary[];
      } catch {
        return null;
      }
    },
    [apiBase],
  );

  const exportCurrentSession = useCallback(async () => {
    const session = sessions.find((item) => item.id === currentSessionId);
    if (!session) return;
    const markdown = markdownForSession(session.title, currentMessages, runEvents);
    const safeTitle = (session.title || "yoomclaw-session")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .slice(0, 80);
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (claw?.saveTextFile) {
      try {
        await claw.saveTextFile({
          fileName: `${safeTitle || "yoomclaw-session"}.md`,
          content: markdown,
        });
        return;
      } catch (error) {
        console.warn("Native export failed; falling back to browser download", error);
      }
    }
    const blob = new Blob(
      [markdown],
      { type: "text/markdown;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeTitle || "yoomclaw-session"}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [currentMessages, currentSessionId, runEvents, sessions]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        exportCurrentSession();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [exportCurrentSession]);

  const deleteSession = useCallback(
    async (id: string) => {
      const deletingCurrent = currentSessionIdRef.current === id;
      const runId = deletingCurrent ? runIdRef.current : null;
      const socket = wsRef.current;
      const mutationRevision = (sessionMutationRevisionRef.current.get(id) ?? 0) + 1;
      sessionMutationRevisionRef.current.set(id, mutationRevision);
      sessionDataRevisionRef.current += 1;
      sessionRefreshRequestRef.current += 1;
      if (deletingCurrent) {
        sessionViewRevisionRef.current += 1;
        if (runId && socket?.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({
              type: "chat.cancel",
              sessionId: id,
              runId,
            }));
          } catch {}
        }
        runIdRef.current = null;
        liveRef.current = null;
        setLive(null);
        setConfirmDialog(null);
        setStreaming(false);
      }
      try {
        const res = await fetch(`${apiBase}/api/sessions/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`session deletion failed: ${res.status}`);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (currentSessionIdRef.current === id) {
          currentSessionIdRef.current = null;
          setCurrentSessionId(null);
          setCurrentMessages([]);
          setHistoricalTools([]);
          setRunEvents([]);
          setPlan(null);
          setRunNotice(null);
          setEditTargetIndex(null);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [apiBase],
  );

  // ===== WebSocket 连接 =====
  const sendSafetyMode = useCallback((mode: SafetyMode) => {
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(JSON.stringify({ type: "setConfirmMode", mode }));
      } catch {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SAFETY_MODE_KEY, safetyMode);
    sendSafetyMode(safetyMode);
  }, [safetyMode, sendSafetyMode]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!modePickerRef.current?.contains(event.target as Node)) setModeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModeMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modeMenuOpen]);

  const connectWs = useCallback(() => {
    if (disposedRef.current) return;
    if (wsReconnectTimerRef.current !== null) {
      window.clearTimeout(wsReconnectTimerRef.current);
      wsReconnectTimerRef.current = null;
    }
    const url = wsUrl(apiBase);
    const generation = ++wsGenerationRef.current;
    const socket = new WebSocket(url);
    wsRef.current = socket;
    const isCurrentSocket = () =>
      !disposedRef.current &&
      wsGenerationRef.current === generation &&
      wsRef.current === socket;
    socket.onopen = () => {
      if (!isCurrentSocket()) return;
      setConnected(true);
      sendSafetyMode(safetyModeRef.current);
      void refreshSessions();
    };
    socket.onmessage = (e) => {
      if (!isCurrentSocket()) return;
      handleWsMessage(e.data.toString());
    };
    socket.onclose = () => {
      if (wsGenerationRef.current !== generation || wsRef.current !== socket) return;
      setConnected(false);
      wsRef.current = null;
      setStreaming(false);
      runIdRef.current = null;
      liveRef.current = null;
      setLive(null);
      setConfirmDialog(null);
      if (!disposedRef.current && wsReconnectTimerRef.current === null) {
        wsReconnectTimerRef.current = window.setTimeout(() => {
          wsReconnectTimerRef.current = null;
          connectWs();
        }, 1500);
      }
    };
    socket.onerror = () => {
      /* 会紧接着触发 close */
    };
  }, [apiBase, refreshSessions, sendSafetyMode]);

  useEffect(() => {
    disposedRef.current = false;
    connectWs();
    return () => {
      disposedRef.current = true;
      wsGenerationRef.current += 1;
      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWs]);

  const ensureLive = (l: LiveAssistant | null): LiveAssistant =>
    l ?? { text: "", tools: [], progress: null };

  const applyEvent = useCallback((ev: AgentEvent) => {
    setRunEvents((previous) => [...previous, ev]);
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
      case "plan":
        setPlan(ev.plan);
        next = { ...l, progress: { name: "任务计划已更新", percent: 0 } };
        break;
      case "subagent":
        next = { ...l, progress: { name: `子 Agent ${ev.status}`, percent: ev.status === "completed" ? 100 : 0 } };
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
      if (l.tools.length > 0) {
        setHistoricalTools((previous) => [...previous, ...l.tools]);
      }
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
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      const messageSessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
      if (messageSessionId && messageSessionId !== currentSessionIdRef.current) return;
      if (msg.type === "chat.event") {
        if (!msg.event || typeof msg.event !== "object") return;
        const event = msg.event as Partial<AgentEvent>;
        if (typeof event.type !== "string") return;
        const eventRunId = typeof msg.runId === "string"
          ? msg.runId
          : typeof (event as { runId?: unknown }).runId === "string"
            ? (event as { runId: string }).runId
            : null;
        if (!runIdRef.current || eventRunId !== runIdRef.current) return;
        applyEvent(event as AgentEvent);
      } else if (msg.type === "chat.end") {
        if (typeof msg.runId !== "string" || msg.runId !== runIdRef.current) return;
        const completedTitle = currentSessionTitleRef.current;
        if (msg.status === "interrupted") applyEvent({ type: "error", message: "任务已中断" });
        if (msg.status === "failed") applyEvent({ type: "error", message: "任务执行失败" });
        commitLive();
        if (msg.status !== "interrupted" && msg.status !== "failed") {
          const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
          if (claw?.getSettings && claw.notify) {
            void claw.getSettings()
              .then((settings) => {
                if (settings.notifyOnComplete) {
                  claw.notify("YoomClaw", `${completedTitle} 已完成`);
                }
              })
              .catch(() => {});
          }
        }
        setStreaming(false);
        runIdRef.current = null;
        refreshSessions();
      } else if (msg.type === "error") {
        if (
          typeof msg.runId === "string"
            ? msg.runId !== runIdRef.current
            : !runIdRef.current
        ) return;
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
      try {
        sock.send(JSON.stringify({
          type: "chat.cancel",
          sessionId: currentSessionId,
          runId: runIdRef.current,
        }));
      } catch {}
    }
    commitLive();
    setStreaming(false);
    runIdRef.current = null;
  }, [commitLive, currentSessionId]);

  const selectSafetyMode = useCallback((mode: SafetyMode) => {
    setSafetyMode(mode);
    setModeMenuOpen(false);
    void fetch(`${apiBase}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safetyMode: mode }),
    }).catch(() => {});
  }, [apiBase]);

  /** 空状态建议 chip：先建会话，再把提示词预填进输入框 */
  const startWithPrompt = useCallback(
    (text: string) => {
      createSession();
      setPrefill({ text, nonce: Date.now() });
    },
    [createSession],
  );

  const beginEditMessage = useCallback((index: number, message: ChatMessage) => {
    if (message.role !== "user") return;
    setEditTargetIndex(index);
    setPrefill({ text: messageTextWithPaths(message), nonce: Date.now() });
    setRunNotice("正在编辑这条消息；发送后会从这里创建新的会话分支。");
  }, []);

  const sendMessage = useCallback(
    async (text: string, files: ComposeAttachment[], inheritedLocalPaths: string[] = []) => {
      const sessionIdAtStart = currentSessionIdRef.current;
      if (!sessionIdAtStart || streaming || runIdRef.current) return false;
      const initialSocket = wsRef.current;
      if (!initialSocket || initialSocket.readyState !== WebSocket.OPEN) {
        console.warn("WebSocket 未连接，无法发送");
        return false;
      }
      const sendRevision = ++sessionViewRevisionRef.current;
      const branchIndex = editTargetIndex;
      const isSendStillCurrent = () =>
        currentSessionIdRef.current === sessionIdAtStart &&
        sessionViewRevisionRef.current === sendRevision;

      // 构造多模态消息：文本 + 已上传的附件
      const providerParts: ContentPart[] = [];
      const displayParts: ContentPart[] = [];
      const attachmentFailures: string[] = [];
      let localPathSucceeded = false;
      const trimmed = text.trim();
      const localPathCandidates = extractLocalFilePathCandidates(trimmed);
      const localPaths = new Set<string>([
        ...inheritedLocalPaths,
        ...(branchIndex !== null ? currentMessages[branchIndex]?.localPaths ?? [] : []),
        ...localPathCandidates,
      ].map((value) => value.trim()).filter(Boolean));
      if (trimmed) {
        const textPart = { type: "text" as const, text: trimmed };
        providerParts.push(textPart);
        displayParts.push(textPart);
      }

      const filesToProcess: Array<{
        file: File;
        localPath?: string;
        kind?: "document" | "image" | "audio" | "video";
        extension: string;
        pathOnly?: boolean;
      }> = [];
      for (const attachment of files) {
        const file = attachment.file;
        const descriptor = classifyFileInput(file.name, file.size, file.type);
        if ((!descriptor.accepted || !descriptor.kind) && attachment.path) {
          filesToProcess.push({
            file,
            localPath: attachment.path,
            extension: descriptor.extension,
            pathOnly: true,
          });
          continue;
        }
        if (!descriptor.accepted || !descriptor.kind) {
          const failure = `[附件 ${file.name} ${descriptor.rejectionCode ?? "UNSUPPORTED_FILE_TYPE"}]`;
          displayParts.push({ type: "text", text: failure });
          providerParts.push({ type: "text", text: failure });
          attachmentFailures.push(failure);
          continue;
        }
        filesToProcess.push({
          file,
          localPath: attachment.path,
          kind: descriptor.kind,
          extension: descriptor.extension,
          pathOnly: attachment.pathOnly,
        });
      }

      for (const { file, localPath, kind, extension, pathOnly } of filesToProcess) {
        if (localPath) localPaths.add(localPath.trim());
        if (pathOnly) {
          displayParts.push({ type: "text", text: `[已附加本地文件：${file.name}]` });
          continue;
        }
        const isPdf = kind === "document" && extension === "pdf";
        try {
          if (isPdf) {
            const pdfResp = await fetch(
              apiBase + "/api/files/read-pdf?fileName=" + encodeURIComponent(file.name),
              {
              method: "POST",
                headers: { "Content-Type": "application/pdf" },
                body: file,
                signal: AbortSignal.timeout(120_000),
              },
            );
            if (pdfResp.ok) {
              const parsed = (await pdfResp.json()) as PdfReadResponse;
              const extracted = parsed.text.trim();
              const content = extracted || "[PDF 中未提取到可复制文字，可能是扫描件]";
              const limitNotice = parsed.truncated
                ? "\n[PDF 内容已截断，仅发送前 50 页或 6 万字符]"
                : "";
              const pdfContext = "[本地 PDF 内容：" + file.name + "]\n" + content + limitNotice;
              displayParts.push({
                type: "text",
                text: `[已解析 PDF：${file.name}，共 ${parsed.pages} 页${parsed.truncated ? "，内容已截断" : ""}]`,
              });
              providerParts.push({ type: "text", text: pdfContext });
            } else {
              const errorBody = (await pdfResp.json().catch(() => null)) as
                | { message?: unknown; error?: unknown }
                | null;
              const detail = typeof errorBody?.message === "string"
                ? `：${errorBody.message}`
                : "";
              const failure = `[附件 ${file.name} 本地 PDF 解析失败：HTTP ${pdfResp.status}${detail}]`;
              displayParts.push({ type: "text", text: failure });
              providerParts.push({ type: "text", text: failure });
              attachmentFailures.push(failure);
            }
            continue;
          }
          const dataUrl = await readFileAsDataUrl(file);
          const resp = await fetch(`${apiBase}/api/upload/file`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: dataUrl,
              source: "desktop",
              fileName: file.name,
              mimeType: file.type,
              kind,
              sizeBytes: file.size,
            }),
            signal: AbortSignal.timeout(90_000),
          });
          if (resp.ok) {
            const up = (await resp.json()) as FileUploadResponse;
            if (kind === "image") {
              providerParts.push({ type: "image_url", image_url: { url: up.url } });
              displayParts.push({ type: "image_url", image_url: { url: up.url } });
            } else {
              providerParts.push({ type: "file_url", file_url: { url: up.url, fileId: up.fileId } });
              displayParts.push({ type: "file_url", file_url: { url: up.url, fileId: up.fileId } });
            }
            displayParts.push({ type: "text", text: `[已附加文件：${file.name}]` });
          } else {
            const errorBody = await resp.json().catch(() => null) as
              | { code?: unknown }
              | null;
            const code = typeof errorBody?.code === "string" ? ` ${errorBody.code}` : "";
            const failure = `[附件 ${file.name} 上传失败：HTTP ${resp.status}${code}]`;
            displayParts.push({ type: "text", text: failure });
            providerParts.push({ type: "text", text: failure });
            attachmentFailures.push(failure);
          }
        } catch (err) {
          const reason = err instanceof DOMException && err.name === "TimeoutError"
            ? (isPdf ? "本地 PDF 解析超时" : "上传超时")
            : (isPdf ? "本地 PDF 解析请求失败" : "上传请求失败");
          const failure = `[附件 ${file.name} ${reason}]`;
          displayParts.push({ type: "text", text: failure });
          providerParts.push({ type: "text", text: failure });
          attachmentFailures.push(failure);
        }
      }

      // Promote explicit local image/document paths in the user's text into
      // the same attachment pipeline used by the paperclip picker. The
      // Gateway performs the filesystem read and applies the active safety
      // boundary; the renderer never reads arbitrary paths directly.
      for (const filePath of localPathCandidates) {
        const pathRule = getFileInputRule(filePath);
        try {
          const localFile = await resolveLocalFilePath(apiBase, filePath);
          const isPdf = localFile.kind === "document" && localFile.extension === "pdf";
          if (isPdf) {
            const pdfResp = await fetch(`${apiBase}/api/files/read-pdf`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: localFile.dataUrl, fileName: localFile.fileName }),
              signal: AbortSignal.timeout(120_000),
            });
            if (pdfResp.ok) {
              appendPdfParts(
                localFile.fileName,
                (await pdfResp.json()) as PdfReadResponse,
                displayParts,
                providerParts,
              );
              localPathSucceeded = true;
            } else {
              const errorBody = await pdfResp.json().catch(() => null) as
                | { code?: unknown; message?: unknown }
                | null;
              const detail = typeof errorBody?.code === "string"
                ? `HTTP ${pdfResp.status} ${errorBody.code}`
                : `HTTP ${pdfResp.status}`;
              appendAttachmentFailure(
                localFile.fileName,
                `本地 PDF 解析失败：${detail}`,
                displayParts,
                providerParts,
                attachmentFailures,
              );
            }
            continue;
          }

          const currentAttachments = countAttachmentParts(providerParts);
          const currentImages = countImageAttachmentParts(providerParts);
          if (currentAttachments >= MAX_FILES_PER_MESSAGE) {
            appendAttachmentFailure(
              localFile.fileName,
              `超过单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`,
              displayParts,
              providerParts,
              attachmentFailures,
            );
            continue;
          }
          if (localFile.kind === "image" && currentImages >= MAX_IMAGES_PER_MESSAGE) {
            appendAttachmentFailure(
              localFile.fileName,
              `超过单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`,
              displayParts,
              providerParts,
              attachmentFailures,
            );
            continue;
          }

          const uploadResp = await fetch(`${apiBase}/api/upload/file`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: localFile.dataUrl,
              source: "desktop-local-path",
              fileName: localFile.fileName,
              mimeType: localFile.mimeType,
              kind: localFile.kind,
              sizeBytes: localFile.sizeBytes,
            }),
            signal: AbortSignal.timeout(90_000),
          });
          if (!uploadResp.ok) {
            const errorBody = await uploadResp.json().catch(() => null) as
              | { code?: unknown }
              | null;
            const code = typeof errorBody?.code === "string" ? ` ${errorBody.code}` : "";
            appendAttachmentFailure(
              localFile.fileName,
              `本地路径上传失败：HTTP ${uploadResp.status}${code}`,
              displayParts,
              providerParts,
              attachmentFailures,
            );
            continue;
          }

          const uploaded = (await uploadResp.json()) as FileUploadResponse;
          if (localFile.kind === "image") {
            providerParts.push({ type: "image_url", image_url: { url: uploaded.url } });
            displayParts.push({ type: "image_url", image_url: { url: uploaded.url } });
          } else {
            providerParts.push({ type: "file_url", file_url: { url: uploaded.url, fileId: uploaded.fileId } });
            displayParts.push({ type: "file_url", file_url: { url: uploaded.url, fileId: uploaded.fileId } });
          }
          displayParts.push({ type: "text", text: `[已附加本地文件：${localFile.fileName}]` });
          localPathSucceeded = true;
        } catch (error) {
          const reason = error instanceof DOMException && error.name === "TimeoutError"
            ? "本地路径读取超时"
            : describeLocalPathFailure(error);
          const fallbackName = filePath.split(/[\\/]/).pop() || filePath;
          // A path that does not match the shared policy should still be
          // visible to the user, but it is not sent as a binary attachment.
          appendAttachmentFailure(
            pathRule ? fallbackName : filePath,
            reason,
            displayParts,
            providerParts,
            attachmentFailures,
          );
        }
      }

      if (!isSendStillCurrent()) return false;
      const normalizedLocalPaths = [...new Set([...localPaths]
        .map((value) => value.trim())
        .filter(Boolean))];
      const userMsg: ChatMessage = {
        role: "user",
        content: contentFromParts(displayParts),
        ...(normalizedLocalPaths.length > 0 ? { localPaths: normalizedLocalPaths } : {}),
      };
      const messageForAgent: ChatMessage = {
        ...userMsg,
        agentContext: contentFromParts(providerParts),
      };

      const hasLocalPathContext = normalizedLocalPaths.length > 0;
      const allAttachmentsFailed = files.length > 0 &&
        attachmentFailures.length >= files.length &&
        !localPathSucceeded &&
        !hasLocalPathContext;
      if (allAttachmentsFailed) {
        if (!isSendStillCurrent()) return false;
        liveRef.current = null;
        setLive(null);
        setConfirmDialog(null);
        setStreaming(false);
        setCurrentMessages((prev) => [
          ...prev,
          userMsg,
          {
            role: "assistant",
            content: `附件处理失败，未启动 AI 任务。\n\n${attachmentFailures.join("\n")}\n\n请检查文件后重新上传。`,
          },
        ]);
        return true;
      }
      if (branchIndex !== null) {
        if (!isSendStillCurrent()) return false;
        try {
          const branchResponse = await fetch(`${apiBase}/api/sessions/${sessionIdAtStart}/branch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageIndex: branchIndex }),
          });
          if (!isSendStillCurrent()) return false;
          if (!branchResponse.ok) {
            setRunNotice("无法创建编辑分支，请重试。");
            return false;
          }
          const branched = (await branchResponse.json()) as SessionSummary;
          setSessions((previous) => sortSessionSummaries(previous.map((session) => (
            session.id === branched.id ? branched : session
          ))));
          setCurrentMessages((previous) => previous.slice(0, branchIndex));
          setHistoricalTools([]);
          setRunEvents([]);
          setPlan(null);
          setEditTargetIndex(null);
        } catch (err) {
          console.error("Failed to create message branch:", err);
          setRunNotice("无法创建编辑分支，请重试。");
          return false;
        }
      }
      if (!isSendStillCurrent()) return false;
      const activeSocket = wsRef.current;
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        setRunNotice("WebSocket disconnected; please retry.");
        return false;
      }
      const fresh: LiveAssistant = { text: "", tools: [], progress: null };
      const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      runIdRef.current = runId;
      try {
        activeSocket.send(
          JSON.stringify({
            type: "chat.start",
            sessionId: sessionIdAtStart,
            runId,
            message: messageForAgent,
            safetyMode: safetyModeRef.current,
          }),
        );
      } catch (err) {
        console.error("Failed to send chat message:", err);
        runIdRef.current = null;
        setStreaming(false);
        liveRef.current = null;
        setLive(null);
        setCurrentMessages((previous) =>
          previous[previous.length - 1] === userMsg
            ? previous.slice(0, -1)
            : previous,
        );
        setRunNotice("Message could not be sent; please retry.");
        return false;
      }
      const title = firstInputTitle(userMsg.content);
      if (title) {
        setSessions((previous) => sortSessionSummaries(previous.map((session) => (
          session.id === sessionIdAtStart
            && session.messageCount === 0
            && (session.title === "新对话" || /^Session \d+$/.test(session.title))
            ? { ...session, title }
            : session
        ))));
      }
      setRunNotice(null);
      setCurrentMessages((prev) => [...prev, userMsg]);
      setRunEvents([]);
      setPlan(null);
      liveRef.current = fresh;
      setLive(fresh);
      setStreaming(true);
      return true;
    },
    [streaming, apiBase, editTargetIndex, currentMessages],
  );

  const retryAssistantMessage = useCallback((assistantIndex: number) => {
    const userMessage = currentMessages
      .slice(0, assistantIndex)
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) return;
    const text = messageTextWithPaths(userMessage).trim();
    if (!text) return;
    void sendMessage(text, [], userMessage.localPaths ?? []);
  }, [currentMessages, sendMessage]);

  const retryLastTask = useCallback(() => {
    if (streaming) return;
    const userMessage = currentMessages
      .slice()
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) return;
    const text = messageTextWithPaths(userMessage).trim();
    if (!text) return;
    void sendMessage(text, [], userMessage.localPaths ?? []);
  }, [currentMessages, sendMessage, streaming]);

  const confirmDecision = useCallback(
    (approved: boolean) => {
      const socket = wsRef.current;
      if (!confirmDialog || !currentSessionId || !runIdRef.current) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setRunNotice("WebSocket disconnected; confirmation was not sent.");
        return;
      }
      try {
        socket.send(
          JSON.stringify({
            type: "tool.decision",
            sessionId: currentSessionId,
            decision: { callId: confirmDialog.callId, approved },
          }),
        );
      } catch {
        setRunNotice("Confirmation could not be sent; please retry.");
        return;
      }
      setConfirmDialog(null);
    },
    [confirmDialog, currentSessionId],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: live ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentMessages, live]);

  // 托盘菜单的"设置"入口
  useEffect(() => {
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (!claw?.on) return;
    const removeSettingsListener = claw.on("menu:open-settings", () => setSettingsOpen(true));
    const removeNewChatListener = claw.on("menu:new-chat", () => void createSession());
    return () => {
      removeSettingsListener();
      removeNewChatListener();
    };
  }, [createSession]);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  currentSessionTitleRef.current = currentSession?.title ?? "YoomClaw";
  const lastRunEvent = runEvents
    .slice()
    .reverse()
    .find((event): event is Extract<AgentEvent, { type: "run" }> => event.type === "run");

  return (
    <WindowFrame>
      <div
        ref={appShellRef}
        className={`app-shell ${sidebarResizing ? "is-resizing-sidebar" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <SessionSidebar
          sessions={sessions}
          currentId={currentSessionId}
          open={sidebarOpen}
          onSelect={selectSession}
          onCreate={createSession}
          onRename={renameSession}
          onPin={(id, pinned) => updateSessionFlags(id, { pinned })}
          onSearch={searchSessions}
          onDelete={deleteSession}
          onClose={() => setSidebarOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {sidebarOpen && (
          <div
            className={`sidebar-resizer ${sidebarResizing ? "active" : ""}`}
            data-testid="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={Math.round(sidebarWidth)}
            tabIndex={0}
            onPointerDown={startSidebarResize}
            onPointerMove={moveSidebarResize}
            onPointerUp={finishSidebarResize}
            onPointerCancel={finishSidebarResize}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setSidebarWidth((width) => clampSidebarWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
              }
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setSidebarWidth(event.key === "Home" ? MIN_SIDEBAR_WIDTH : MAX_SIDEBAR_WIDTH);
              }
            }}
          />
        )}
        <main className="chat-main">
          <header className="chat-header">
            <div className="header-left">
              <button
                className="header-btn"
                data-testid="sidebar-toggle"
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
              <button
                type="button"
                className={`workbench-toggle ${workbenchOpen ? "active" : ""}`}
                data-testid="workbench-open"
                onClick={() => setWorkbenchOpen((open) => !open)}
                title="打开任务工作台"
              >
                <TaskIcon size={15} />
                <span>任务</span>
              </button>
              <button
                type="button"
                className="export-toggle"
                data-testid="export-session"
                onClick={exportCurrentSession}
                title="导出当前对话（Ctrl+Shift+E）"
                disabled={!currentSessionId}
              >
                <ExportIcon size={15} />
                <span>导出</span>
              </button>
              <span
                className={`conn-chip ${connected ? "on" : "off"}`}
                title={connected ? "已连接" : "连接中…"}
              >
                <span className="conn-dot" />
                {connected ? "已连接" : "连接中"}
              </span>
              <div className="mode-picker" ref={modePickerRef}>
                <button
                  type="button"
                  className={`mode-chip ${safetyMode}`}
                  data-testid="safety-mode"
                  onClick={() => setModeMenuOpen((open) => !open)}
                  title={selectedSafetyMode.detail}
                  aria-haspopup="menu"
                  aria-expanded={modeMenuOpen}
                  aria-label={`访问权限：${selectedSafetyMode.label}`}
                >
                  <ShieldIcon size={16} />
                  {selectedSafetyMode.label}
                </button>
                {modeMenuOpen && (
                  <div className="mode-menu" role="menu" aria-label="访问权限">
                    <div className="mode-menu-title">访问权限</div>
                    {SAFETY_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        data-testid={`safety-mode-${option.value}`}
                        aria-checked={safetyMode === option.value}
                        className={`mode-option ${safetyMode === option.value ? "selected" : ""} ${option.value}`}
                        onClick={() => selectSafetyMode(option.value)}
                      >
                        <span className="mode-option-copy">
                          <span className="mode-option-label">{option.label}</span>
                          <span className="mode-option-detail">{option.detail}</span>
                        </span>
                        {safetyMode === option.value && <CheckIcon size={15} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </header>

          {runNotice && (
            <div className="run-notice" role="status" aria-live="polite">
              <InfoIcon size={14} />
              <span>{runNotice}</span>
            </div>
          )}

          {!currentSessionId ? (
            <div className="empty-state">
              <SpiralLogo size={56} />
              <h2>YoomClaw</h2>
              <p>你的本地 AI 助手 · 数据不上传</p>
              <button className="empty-cta" data-testid="session-empty-cta" onClick={createSession}>
                <PlusIcon size={16} />
                <span>开始新对话</span>
              </button>
              <div className="empty-chips">
                {["解释这段代码", "重构前端布局", "写一个单元测试"].map((t) => (
                  <button
                    key={t}
                    className="empty-chip"
                    data-testid={`session-empty-prompt-${t}`}
                    onClick={() => startWithPrompt(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageStream
              messages={currentMessages}
              historicalTools={historicalTools}
              plan={plan}
              live={live ?? undefined}
              endRef={messagesEndRef}
              onEditUser={beginEditMessage}
              onRetryAssistant={retryAssistantMessage}
            />
          )}

          <ComposeBar
            onSend={sendMessage}
            onStop={stopStreaming}
            ready={Boolean(currentSessionId) && connected && !creatingSession}
            creating={creatingSession}
            streaming={streaming}
            prefill={prefill}
            draftKey={currentSessionId}
          />
        </main>
        {workbenchOpen && (
          <WorkbenchPanel
            workspace={workspace}
            sessionTitle={currentSession?.title ?? "YoomClaw"}
            messages={currentMessages}
            runEvents={runEvents}
            runStatus={lastRunEvent?.status ?? "idle"}
            streaming={streaming}
            onClose={() => setWorkbenchOpen(false)}
            onOpenSettings={() => setSettingsOpen(true)}
            onRetryTask={retryLastTask}
          />
        )}
      </div>

      {confirmDialog && (
        <div className="modal-mask" data-testid="confirm-mask" onClick={() => confirmDecision(false)}>
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
              <button className="btn deny" data-testid="confirm-deny" onClick={() => confirmDecision(false)}>
                拒绝
              </button>
              <button className="btn allow" data-testid="confirm-allow" onClick={() => confirmDecision(true)}>
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
        .app-shell.is-resizing-sidebar {
          user-select: none;
          cursor: col-resize;
        }
        .app-shell.is-resizing-sidebar :global(.sidebar) {
          transition: none;
        }
        .sidebar-resizer {
          position: relative;
          flex: 0 0 8px;
          width: 8px;
          margin: 0 -4px;
          z-index: 5;
          cursor: col-resize;
          touch-action: none;
        }
        .sidebar-resizer::after {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 3px;
          width: 2px;
          border-radius: 999px;
          background: transparent;
          transition: background var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
        }
        .sidebar-resizer:hover::after,
        .sidebar-resizer.active::after {
          background: var(--primary);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
        }
        .chat-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
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
          display: flex;
          align-items: center;
          gap: 7px;
          flex-shrink: 0;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
          background: color-mix(in srgb, var(--warning) 10%, var(--bg));
          color: var(--warning);
          font-size: 12px;
          animation: yc-fade-up 220ms var(--ease-standard) both;
        }
        .run-notice :global(svg) { flex-shrink: 0; }
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
        .workbench-toggle {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 28px;
          padding: 0 10px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--text-secondary);
          background: transparent;
          font-size: 12px;
          cursor: pointer;
          transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
        }
        .workbench-toggle:hover,
        .workbench-toggle.active {
          border-color: var(--primary);
          color: var(--primary);
          background: color-mix(in srgb, var(--primary) 10%, transparent);
        }
        .workbench-toggle.active { box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 10%, transparent); }
        .workbench-toggle :global(svg) { transition: transform 260ms var(--ease-emphasized); }
        .workbench-toggle.active :global(svg) { transform: rotate(-8deg) scale(1.06); }
        .export-toggle {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 28px;
          padding: 0 9px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--text-secondary);
          background: transparent;
          font-size: 12px;
          cursor: pointer;
          transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
        }
        .export-toggle:hover:not(:disabled) {
          border-color: var(--primary);
          color: var(--primary);
          background: color-mix(in srgb, var(--primary) 10%, transparent);
        }
        .export-toggle:disabled { opacity: .45; cursor: not-allowed; }
        .export-toggle:hover:not(:disabled) { box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 8%, transparent); }
        .export-toggle :global(svg) { transition: transform 220ms var(--ease-emphasized); }
        .export-toggle:hover:not(:disabled) :global(svg) { transform: translateY(1px); }
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
          animation: yc-pulse 2.4s ease-in-out infinite;
        }
        .mode-picker {
          position: relative;
          z-index: 30;
        }
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
        .mode-chip.workspace-auto {
          background: color-mix(in srgb, var(--warning) 14%, transparent);
          border-color: var(--warning);
          color: var(--warning);
        }
        .mode-chip.full-access {
          background: color-mix(in srgb, var(--error) 14%, transparent);
          border-color: color-mix(in srgb, var(--error) 72%, var(--border));
          color: var(--error);
        }
        .mode-menu {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: min(360px, calc(100vw - 24px));
          padding: 8px;
          border: 1px solid var(--border-active);
          border-radius: 14px;
          background: var(--bg-elevated);
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.4);
          animation: yc-pop 160ms var(--ease-emphasized) both;
        }
        .mode-menu-title {
          padding: 5px 10px 8px;
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: .04em;
          text-transform: uppercase;
        }
        .mode-option {
          width: 100%;
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px;
          border-radius: 10px;
          color: var(--text-secondary);
          text-align: left;
          transition: background .15s, color .15s;
        }
        .mode-option:hover,
        .mode-option.selected {
          background: var(--bg-element);
          color: var(--text);
        }
        .mode-option.full-access.selected,
        .mode-option.full-access:hover {
          background: color-mix(in srgb, var(--error) 10%, var(--bg-element));
          color: var(--error);
        }
        .mode-option-copy {
          min-width: 0;
          display: flex;
          flex: 1;
          flex-direction: column;
          gap: 3px;
        }
        .mode-option-label {
          font-size: 13px;
          font-weight: 600;
          line-height: 1.3;
        }
        .mode-option-detail {
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .mode-option :global(svg) {
          flex: 0 0 auto;
          margin-top: 2px;
          color: var(--primary);
        }
        .empty-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: var(--text-secondary);
          animation: yc-fade-up 280ms var(--ease-standard) both;
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
          animation: yc-fade-up 160ms var(--ease-standard) both;
        }
        .modal {
          width: 440px;
          max-width: 100%;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 20px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
          animation: yc-pop 220ms var(--ease-emphasized) both;
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
        @media (max-width: 768px) {
          .sidebar-resizer { display: none; }
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
