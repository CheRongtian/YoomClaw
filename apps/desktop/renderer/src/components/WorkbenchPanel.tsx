import { useEffect, useRef, useState } from "react";
import type { AgentEvent, ChatMessage, SessionRunStatus } from "@yoomclaw/protocol";
import { messageText, toolCardsFromEvents } from "./MessageStream";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  CloseIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  LoaderIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  TaskIcon,
  TerminalIcon,
  WrenchIcon,
} from "./icons";

interface Props {
  workspace: string;
  sessionTitle: string;
  messages: ChatMessage[];
  runEvents: AgentEvent[];
  runStatus: SessionRunStatus | "idle";
  streaming: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onRetryTask: () => void;
}

function shortPath(value: string): string {
  if (value.length <= 42) return value;
  return `…${value.slice(-39)}`;
}

interface WorkspaceEntry {
  name: string;
  type: "directory" | "file";
  size?: number;
}

function joinBrowserPath(base: string, name: string): string {
  if (base === ".") return name;
  return `${base.replace(/[\\/]$/, "")}/${name}`;
}

function parentBrowserPath(value: string, root: string): string {
  if (value === root || value === ".") return ".";
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (index < 0) return root;
  const parent = value.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || root;
}

function toolPathParent(value: string): string {
  const normalized = value.trim().replace(/[\\/]$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index < 0) return ".";
  const parent = normalized.slice(0, index);
  return parent || ".";
}

function taskDirectoryTarget(messages: ChatMessage[], events: AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool_start" || typeof event.args?.path !== "string") continue;
    const candidate = event.args.path.trim();
    if (!candidate) continue;
    if (event.name === "list_dir") return candidate;
    if (event.name === "write_file" || event.name === "edit_file") return toolPathParent(candidate);
  }
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const folderAttachment = lastUser?.localPaths?.find((candidate) =>
    candidate.trim() && !/[\\/][^\\/]+\.[^\\/]+$/.test(candidate.trim()),
  );
  return folderAttachment?.trim() || undefined;
}

function FileBrowser({ initialPath = "." }: { initialPath?: string }) {
  const rootPath = initialPath || ".";
  const [relativePath, setRelativePath] = useState(rootPath);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const treeRequestRef = useRef(0);
  const previewRequestRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const treeRequestId = ++treeRequestRef.current;
    previewRequestRef.current += 1;
    setError(null);
    void fetch(`http://localhost:18789/api/workspace/tree?path=${encodeURIComponent(relativePath)}`)
      .then(async (response) => {
        const payload = await response.json() as { entries?: WorkspaceEntry[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "无法读取工作区");
        if (alive && treeRequestId === treeRequestRef.current) setEntries(payload.entries ?? []);
      })
      .catch((reason) => {
        if (alive && treeRequestId === treeRequestRef.current) setError(reason instanceof Error ? reason.message : "无法读取工作区");
      });
    return () => {
      alive = false;
      treeRequestRef.current += 1;
    };
  }, [relativePath]);

  const openEntry = (entry: WorkspaceEntry) => {
    const nextPath = joinBrowserPath(relativePath, entry.name);
    setSelectedPath(nextPath);
    if (entry.type === "directory") {
      previewRequestRef.current += 1;
      setPreview(null);
      setRelativePath(nextPath);
      return;
    }
    const requestId = ++previewRequestRef.current;
    setError(null);
    void fetch(`http://localhost:18789/api/workspace/file?path=${encodeURIComponent(nextPath)}`)
      .then(async (response) => {
        const payload = await response.json() as { path?: string; content?: string; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "无法预览文件");
        if (requestId === previewRequestRef.current) {
          setPreview({ path: payload.path ?? nextPath, content: payload.content ?? "" });
        }
      })
      .catch((reason) => {
        if (requestId === previewRequestRef.current) {
          setError(reason instanceof Error ? reason.message : "无法预览文件");
        }
      });
  };

  const parentPath = parentBrowserPath(relativePath, rootPath);

  return (
    <section className="file-browser">
      <div className="section-head"><span className="section-title"><FolderIcon size={14} /><span>工作区文件</span></span><span className="section-count">{entries.length}</span></div>
      <div className="file-path-row">
        <button type="button" className="file-back" data-testid="workbench-back" disabled={relativePath === rootPath} onClick={() => setRelativePath(parentPath)} aria-label="返回上一级" title="返回上一级"><ChevronLeftIcon size={14} /></button>
        <span title={relativePath}>{shortPath(relativePath)}</span>
      </div>
      {error && <div className="file-error">{error}</div>}
      <div className="file-list">
        {entries.length === 0 && !error ? <div className="empty-section"><CircleIcon size={12} />目录为空。</div> : entries.map((entry) => (
          <button
            type="button"
            className={`file-entry ${selectedPath === joinBrowserPath(relativePath, entry.name) ? "selected" : ""}`}
            data-testid={`workbench-entry-${entry.name}`}
            key={entry.name}
            onClick={() => openEntry(entry)}
            aria-label={`${entry.type === "directory" ? "打开目录" : "预览文件"} ${entry.name}`}
          >
            <span className={`file-kind ${entry.type}`}>{entry.type === "directory" ? <FolderIcon size={13} /> : <FileIcon size={13} />}</span>
            <span className="file-name">{entry.name}</span>
            {entry.type === "file" && entry.size !== undefined && <span className="file-size">{Math.ceil(entry.size / 1024)}K</span>}
            {entry.type === "directory" && <ChevronRightIcon className="file-chevron" size={13} />}
          </button>
        ))}
      </div>
      {preview && (
        <div className="file-preview">
          <div className="preview-title" title={preview.path}><FileIcon size={12} /><span>{preview.path}</span></div>
          <pre>{preview.content}</pre>
        </div>
      )}
      <style jsx>{`
        .file-browser { border-top: 1px solid var(--border-subtle); padding-top: 12px; animation: yc-fade-up 220ms var(--ease-standard) both; }
        .section-title { display: inline-flex; align-items: center; gap: 6px; }
        .section-title :global(svg) { color: var(--primary); }
        .file-path-row { display: flex; align-items: center; gap: 6px; min-width: 0; margin-bottom: 6px; color: var(--text-muted); font: 11px var(--font-mono); }
        .file-path-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-back { width: 24px; height: 22px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--border); color: var(--text-secondary); }
        .file-back:disabled { opacity: .35; cursor: default; }
        .file-list { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
        .file-entry { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 6px 5px; border-radius: 6px; color: var(--text-secondary); text-align: left; font-size: 11px; transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard); }
        .file-entry:hover { background: var(--bg-element); transform: translateX(2px); }
        .file-entry.selected { color: var(--text); background: color-mix(in srgb, var(--primary) 10%, var(--bg-element)); }
        .file-kind { width: 15px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--primary); text-align: center; }
        .file-kind.file { color: var(--text-muted); }
        .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-size { margin-left: auto; flex-shrink: 0; color: var(--text-muted); font-size: 10px; }
        .file-chevron { margin-left: auto; color: var(--text-muted); transition: transform var(--motion-fast) var(--ease-emphasized); }
        .file-entry:hover .file-chevron { transform: translateX(2px); color: var(--primary); }
        .file-error { padding: 7px; border-radius: 6px; background: color-mix(in srgb, var(--error) 12%, transparent); color: var(--error); font-size: 11px; }
        .file-preview { margin-top: 8px; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; animation: yc-fade-up 220ms var(--ease-standard) both; }
        .preview-title { display: flex; align-items: center; gap: 5px; overflow: hidden; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--text-secondary); font: 10px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
        .preview-title :global(svg) { flex-shrink: 0; color: var(--primary); }
        .preview-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-preview pre { max-height: 180px; margin: 0; padding: 8px; overflow: auto; color: var(--text-muted); font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
      `}</style>
    </section>
  );
}

function GitPanel() {
  const [git, setGit] = useState<{ available: boolean; branch: string; status: string; diff: string; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("http://localhost:18789/api/workspace/git")
      .then((response) => response.json() as Promise<{ available: boolean; branch: string; status: string; diff: string; error?: string }>)
      .then((payload) => { if (alive) setGit(payload); })
      .catch((reason) => {
        if (alive) setGit({ available: false, branch: "", status: "", diff: "", error: reason instanceof Error ? reason.message : "Git 状态不可用" });
      });
    return () => { alive = false; };
  }, []);

  return (
    <section className="git-panel">
      <div className="section-head"><span className="section-title"><GitBranchIcon size={14} /><span>Git 变更</span></span><span className="section-count git-branch">{git?.branch ? <><GitBranchIcon size={12} /><span>{git.branch}</span></> : "读取中"}</span></div>
      {!git ? <div className="empty-section loading-state"><LoaderIcon className="spin" size={13} /><span>正在读取当前分支和 diff…</span></div> : !git.available ? (
        <div className="empty-section error-state"><CircleXIcon size={13} /><span>{git.error || "当前 workspace 不是 Git 仓库。"}</span></div>
      ) : (
        <>
          <pre className="git-status">{git.status.trim() || "工作区干净"}</pre>
          {git.diff.trim() && <pre className="git-diff">{git.diff}</pre>}
        </>
      )}
      <style jsx>{`
        .git-panel { border-top: 1px solid var(--border-subtle); padding-top: 12px; animation: yc-fade-up 220ms 60ms var(--ease-standard) both; }
        .git-branch { display: inline-flex; align-items: center; gap: 4px; max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .git-branch :global(svg) { flex-shrink: 0; color: var(--primary); }
        .git-status, .git-diff { max-height: 125px; margin: 0; padding: 7px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--code-bg); color: var(--text-muted); font: 10px/1.45 var(--font-mono); white-space: pre-wrap; word-break: break-word; animation: yc-fade-up 200ms var(--ease-standard) both; }
        .git-diff { margin-top: 6px; color: var(--text-secondary); }
        .loading-state, .error-state { display: inline-flex; align-items: flex-start; gap: 6px; }
        .loading-state :global(svg) { color: var(--primary); }
        .error-state :global(svg) { flex-shrink: 0; color: var(--error); }
        .spin { animation: yc-spin .85s linear infinite; }
      `}</style>
    </section>
  );
}

function eventLabel(event: AgentEvent): string {
  switch (event.type) {
    case "run": return event.status === "running" ? "任务开始" : `任务${event.status}`;
    case "tool_confirm": return `等待审批：${event.name}`;
    case "tool_start": return `执行工具：${event.name}`;
    case "tool_end": return `${event.isError ? "工具失败" : "工具完成"}：${event.name}`;
    case "final": return "生成最终答复";
    case "error": return "运行错误";
    case "progress": return event.name;
    case "memory": return `记忆${event.action}`;
    case "skill_draft": return `Skill ${event.status}`;
    case "browser": return `浏览器${event.status}`;
    case "vision": return `视觉${event.status}`;
    case "delta": return "生成中";
    default: return "运行事件";
  }
}

function runStatusLabel(status: SessionRunStatus | "idle"): string {
  switch (status) {
    case "running": return "运行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "interrupted": return "已中断";
    default: return "待命";
  }
}

function eventTone(event: AgentEvent): string {
  if (event.type === "error" || (event.type === "tool_end" && event.isError)) return "error";
  if (event.type === "tool_confirm") return "attention";
  if (event.type === "final" || (event.type === "run" && event.status === "completed")) return "success";
  return "neutral";
}

export default function WorkbenchPanel({
  workspace,
  sessionTitle,
  messages,
  runEvents,
  runStatus,
  streaming,
  onClose,
  onOpenSettings,
  onRetryTask,
}: Props) {
  const [copiedWorkspace, setCopiedWorkspace] = useState(false);
  const copiedWorkspaceTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedWorkspaceTimerRef.current !== null) {
      window.clearTimeout(copiedWorkspaceTimerRef.current);
    }
  }, []);
  const tools = toolCardsFromEvents(runEvents);
  const approvals = runEvents.filter((event) => event.type === "tool_confirm").length;
  const hasTask = messages.some((message) => message.role === "user");
  const hasToolRun = tools.length > 0;
  const hasAnswer = runEvents.some((event) => event.type === "final") ||
    messages.some((message) => message.role === "assistant");
  const status = streaming ? "running" : runStatus;
  const statusIcon = status === "running"
    ? <LoaderIcon size={13} className="spin" />
    : status === "completed"
      ? <CircleCheckIcon size={13} />
      : status === "failed" || status === "interrupted"
        ? <CircleXIcon size={13} />
        : <CircleIcon size={13} />;
  const timeline = runEvents
    .filter((event) => event.type !== "delta" && event.type !== "progress")
    .slice(-12)
    .reverse();
  const lastUserTask = messages
    .slice()
    .reverse()
    .find((message) => message.role === "user");
  const targetPath = taskDirectoryTarget(messages, runEvents);

  const copyWorkspace = async () => {
    if (!workspace || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(workspace);
      setCopiedWorkspace(true);
      if (copiedWorkspaceTimerRef.current !== null) {
        window.clearTimeout(copiedWorkspaceTimerRef.current);
      }
      copiedWorkspaceTimerRef.current = window.setTimeout(() => {
        copiedWorkspaceTimerRef.current = null;
        setCopiedWorkspace(false);
      }, 1200);
    } catch {
      // Clipboard permissions are optional in browser mode.
    }
  };

  return (
    <aside className="workbench-panel">
      <div className="workbench-head">
        <div>
          <div className="workbench-kicker">LOCAL TASK</div>
          <div className="workbench-title"><TaskIcon size={17} /><span>任务工作台</span></div>
        </div>
        <button type="button" className="close-btn" data-testid="workbench-close" onClick={onClose} aria-label="关闭任务工作台" title="关闭任务工作台"><CloseIcon size={15} /></button>
      </div>

      <section className="task-card">
        <div className="task-card-head">
          <span className={`status-symbol ${status}`}>{statusIcon}</span>
          <span className="task-status">{runStatusLabel(status)}</span>
          <span className="task-id">当前会话</span>
        </div>
        <div className="task-name" title={sessionTitle}>{sessionTitle || "未命名任务"}</div>
        <div className="workspace-path" title={targetPath || workspace}>{shortPath(targetPath || workspace || "未选择工作区")}</div>
      </section>

        <FileBrowser key={`file:${workspace}:${targetPath || ""}`} initialPath={targetPath || "."} />
        <GitPanel key={`git:${workspace}`} />

      <section className="section action-section">
        <div className="section-head"><span>本地操作</span><span className="section-count">安全入口</span></div>
        <div className="action-grid">
          <button
            type="button"
            className="workbench-action primary"
            data-testid="workbench-retry"
            disabled={!lastUserTask || streaming}
            onClick={onRetryTask}
            title="重新运行上一任务"
            aria-label={lastUserTask ? `重新运行上一任务：${messageText(lastUserTask.content)}` : "当前会话还没有任务"}
          >
            <RefreshIcon size={14} />
            <span>重新运行上一任务</span>
          </button>
          <button
            type="button"
            className="workbench-action"
            data-testid="workbench-copy"
            disabled={!workspace}
            onClick={() => void copyWorkspace()}
            aria-label="复制工作区路径"
          >
            {copiedWorkspace ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{copiedWorkspace ? "路径已复制" : "复制工作区路径"}</span>
          </button>
        </div>
        {!hasTask && <div className="action-hint">发送第一条任务后，可从这里重新运行。</div>}
      </section>

      <section className="section">
        <div className="section-head"><span>计划检查</span><span className="section-count">{[hasTask, hasToolRun, hasAnswer].filter(Boolean).length}/3</span></div>
        <div className={`check-row ${hasTask ? "done" : ""}`}><span className="check">{hasTask ? <CircleCheckIcon size={15} /> : <CircleIcon size={15} />}</span><span>接收任务</span></div>
        <div className={`check-row ${hasToolRun ? "done" : ""}`}><span className="check">{hasToolRun ? <CircleCheckIcon size={15} /> : <CircleIcon size={15} />}</span><span>执行工作区工具</span></div>
        <div className={`check-row ${hasAnswer ? "done" : ""}`}><span className="check">{hasAnswer ? <CircleCheckIcon size={15} /> : <CircleIcon size={15} />}</span><span>生成结果</span></div>
      </section>

      <section className="section timeline-section">
        <div className="section-head"><span className="section-title"><TaskIcon size={14} /><span>运行时间线</span></span><span className="section-count">{runEvents.length}</span></div>
        {timeline.length === 0 ? (
          <div className="empty-section">发送任务后，这里会显示模型、工具和审批事件。</div>
        ) : (
          <div className="timeline">
            {timeline.map((event, index) => (
              <div className="timeline-row" key={`${event.type}-${index}`} style={{ animationDelay: `${Math.min(index, 10) * 24}ms` }}>
                <span className={`timeline-marker ${eventTone(event)}`} />
                <span className="timeline-label">{eventLabel(event)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="metrics">
        <div className="metric"><WrenchIcon size={13} /><span>工具调用</span><strong>{tools.length}</strong></div>
        <div className="metric"><ShieldIcon size={13} /><span>审批请求</span><strong>{approvals}</strong></div>
        <div className="metric"><FileIcon size={13} /><span>产物摘要</span><strong>{tools.filter((tool) => tool.result !== undefined).length}</strong></div>
      </section>

      {tools.some((tool) => tool.result !== undefined) && (
        <section className="section artifacts">
          <div className="section-head"><span className="section-title"><CheckIcon size={14} /><span>最近产物</span></span></div>
          {tools.filter((tool) => tool.result !== undefined).slice(-3).reverse().map((tool) => (
            <div className="artifact" key={tool.callId}>
              <span className={`artifact-icon ${tool.isError ? "error" : ""}`}>{tool.isError ? <CircleXIcon size={14} /> : <CircleCheckIcon size={14} />}</span>
              <div className="artifact-copy">
                <div className="artifact-name">{tool.name}</div>
                <div className="artifact-result">{tool.result?.slice(0, 96)}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      {tools.some((tool) => tool.name === "bash" || tool.name === "run_command") && (
        <section className="section terminal-output">
          <div className="section-head"><span className="section-title"><TerminalIcon size={14} /><span>终端输出</span></span></div>
          {tools.filter((tool) => tool.name === "bash" || tool.name === "run_command").slice(-2).map((tool) => (
            <pre key={tool.callId}>{tool.result ?? "正在运行…"}</pre>
          ))}
        </section>
      )}

      <button type="button" className="settings-link" data-testid="workbench-settings" onClick={onOpenSettings}><SettingsIcon size={14} /><span>打开工作区与 Agent 设置</span></button>

      <style jsx>{`
        .workbench-panel {
          width: 306px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 16px;
          overflow-y: auto;
          border-left: 1px solid var(--border);
          background: var(--bg-panel);
          box-shadow: -14px 0 32px rgba(0, 0, 0, .16);
          animation: yc-panel-in 260ms var(--ease-emphasized) both;
        }
        .workbench-head, .task-card-head, .section-head, .metrics, .artifact, .settings-link {
          display: flex;
          align-items: center;
        }
        .workbench-head { justify-content: space-between; }
        .workbench-kicker { color: var(--primary); font-size: 10px; letter-spacing: 1.2px; font-weight: 700; }
        .workbench-title { display: flex; align-items: center; gap: 7px; margin-top: 3px; color: var(--text); font-size: 16px; font-weight: 600; }
        .workbench-title :global(svg) { color: var(--primary); }
        .close-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--text-muted); }
        .close-btn:hover { background: var(--bg-element); color: var(--text); }
        .close-btn :global(svg) { transition: transform 220ms var(--ease-emphasized); }
        .close-btn:hover :global(svg) { transform: rotate(90deg); }
        .task-card { padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-element); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent); animation: yc-fade-up 220ms 30ms var(--ease-standard) both; }
        .task-card-head { gap: 7px; font-size: 11px; color: var(--text-muted); }
        .status-symbol { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); }
        .status-symbol.running { color: var(--status-running); animation: yc-pulse 1.8s ease-in-out infinite; border-radius: 50%; }
        .status-symbol.completed { color: var(--success); animation: yc-pop 220ms var(--ease-emphasized) both; }
        .status-symbol.failed, .status-symbol.interrupted { color: var(--error); animation: yc-pop 220ms var(--ease-emphasized) both; }
        .task-status { color: var(--text-secondary); letter-spacing: .4px; }
        .task-id { margin-left: auto; }
        .task-name { margin-top: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 13px; font-weight: 600; }
        .workspace-path { margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font: 11px var(--font-mono); }
        .section { padding-top: 4px; }
        .action-section { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
        .section-head { justify-content: space-between; margin-bottom: 8px; color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .5px; }
        .section-title { display: inline-flex; align-items: center; gap: 6px; }
        .section-title :global(svg) { color: var(--primary); }
        .section-count { color: var(--text-muted); font-weight: 400; }
        .action-grid { display: grid; grid-template-columns: 1fr; gap: 6px; }
        .workbench-action { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-secondary); background: var(--bg-element); font-size: 11px; text-align: left; cursor: pointer; transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard); }
        .workbench-action :global(svg) { flex-shrink: 0; color: var(--primary); }
        .workbench-action:hover:not(:disabled) { border-color: var(--primary); color: var(--text); background: color-mix(in srgb, var(--primary) 8%, var(--bg-element)); box-shadow: 0 4px 14px color-mix(in srgb, var(--primary) 8%, transparent); transform: translateY(-1px); }
        .workbench-action.primary { color: var(--text); }
        .workbench-action:disabled { opacity: .45; cursor: default; }
        .action-hint { margin-top: 6px; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
        .check-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--text-muted); font-size: 12px; animation: yc-fade-up 200ms var(--ease-standard) both; }
        .check-row.done { color: var(--text-secondary); }
        .check { width: 15px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); text-align: center; }
        .check-row.done .check { color: var(--success); }
        .timeline-section { min-height: 92px; }
        .timeline { display: flex; flex-direction: column; gap: 8px; }
        .timeline-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-secondary); font-size: 12px; animation: yc-fade-up 200ms var(--ease-standard) both; }
        .timeline-marker { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--text-muted); }
        .timeline-marker.success { background: var(--success); }
        .timeline-marker.attention { background: var(--warning); }
        .timeline-marker.error { background: var(--error); }
        .timeline-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .empty-section { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
        .metrics { gap: 6px; }
        .metric { flex: 1; padding: 8px 7px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg); transition: border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard); }
        .metric:hover { border-color: var(--border-active); transform: translateY(-1px); }
        .metric > :global(svg) { color: var(--primary); }
        .metric span { display: block; margin-top: 4px; color: var(--text-muted); font-size: 10px; }
        .metric strong { display: block; margin-top: 4px; color: var(--text); font-size: 15px; font-weight: 600; }
        .artifacts { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
        .terminal-output { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
        .terminal-output pre { max-height: 130px; margin: 0 0 6px; padding: 8px; overflow: auto; border-radius: 6px; background: var(--code-bg); color: var(--text-secondary); font: 10px/1.45 var(--font-mono); white-space: pre-wrap; word-break: break-word; }
        .artifact { align-items: flex-start; gap: 8px; padding: 6px 0; animation: yc-fade-up 200ms var(--ease-standard) both; }
        .artifact-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 50%; background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
        .artifact-icon.error { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }
        .artifact-copy { min-width: 0; }
        .artifact-name { color: var(--text-secondary); font: 11px var(--font-mono); }
        .artifact-result { margin-top: 2px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
        .settings-link { justify-content: center; gap: 6px; width: 100%; min-height: 34px; margin-top: auto; border: 1px solid var(--border); border-radius: 7px; color: var(--text-secondary); background: transparent; font-size: 11px; cursor: pointer; transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard); }
        .settings-link :global(svg) { color: var(--primary); transition: transform 220ms var(--ease-emphasized); }
        .settings-link:hover { color: var(--text); background: var(--bg-element); }
        .settings-link:hover :global(svg) { transform: rotate(12deg); }
        @media (max-width: 900px) { .workbench-panel { position: absolute; right: 0; top: 0; bottom: 0; z-index: 20; box-shadow: -8px 0 24px rgba(0, 0, 0, .18); } }
      `}</style>
    </aside>
  );
}
