import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SessionSummary } from "@yoomclaw/protocol";
import {
  PlusIcon,
  TrashIcon,
  SearchIcon,
  SettingsIcon,
  EditIcon,
  PinIcon,
} from "./icons";

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void | Promise<unknown>;
  onSearch?: (query: string) => Promise<SessionSummary[] | null>;
  onDelete: (id: string) => void | Promise<unknown>;
  onClose: () => void;
  onOpenSettings: () => void;
}

export default function SessionSidebar({
  sessions,
  currentId,
  open,
  onSelect,
  onCreate,
  onRename,
  onPin,
  onSearch,
  onDelete,
  onClose,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSummary[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Keep deletion confirmation inside the renderer. Native window.confirm() can
  // leave Electron's webContents without keyboard focus after its modal loop.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const searchRequestRef = useRef(0);
  const renameCommitRef = useRef<string | null>(null);
  const actionFeedbackTimerRef = useRef<number | null>(null);
  const sessionRowRefs = useRef(new Map<string, HTMLDivElement>());
  const pinAnimationRef = useRef<{ id: string; firstTop: number; token: number } | null>(null);
  const activePinRowAnimationRef = useRef<Animation | null>(null);
  const pinAnimationTokenRef = useRef(0);
  const aliveRef = useRef(true);
  const [actionFeedbackKey, setActionFeedbackKey] = useState<string | null>(null);
  const keyword = query.trim().toLowerCase();
  const localFiltered = keyword
    ? sessions.filter((s) => (s.title || "").toLowerCase().includes(keyword))
    : sessions;
  const filtered = searchResults ?? localFiltered;

  const handleSearch = (value: string) => {
    setQuery(value);
    const requestId = ++searchRequestRef.current;
    if (!onSearch || !value.trim()) {
      setSearchResults(null);
      return;
    }
    void onSearch(value).then(
      (results) => {
        if (aliveRef.current && requestId === searchRequestRef.current) setSearchResults(results);
      },
      () => {},
    );
  };

  const beginRename = (id: string, title: string) => {
    renameCommitRef.current = null;
    setEditingId(id);
    setEditingTitle(title);
  };

  const finishRename = (id: string) => {
    if (renameCommitRef.current === id) return;
    renameCommitRef.current = id;
    onRename(id, editingTitle);
    setEditingId(null);
  };

  const triggerActionFeedback = (id: string) => {
    if (!aliveRef.current) return;
    const action = "pin";
    setActionFeedbackKey(`${action}:${id}`);
    if (actionFeedbackTimerRef.current !== null) {
      window.clearTimeout(actionFeedbackTimerRef.current);
    }
    actionFeedbackTimerRef.current = window.setTimeout(() => {
      setActionFeedbackKey(null);
      actionFeedbackTimerRef.current = null;
    }, 620);
  };

  useLayoutEffect(() => {
    const pending = pinAnimationRef.current;
    if (!pending || !aliveRef.current) return;
    const row = sessionRowRefs.current.get(pending.id);
    if (!row) return;

    pinAnimationRef.current = null;
    const nextTop = row.getBoundingClientRect().top;
    const offset = Math.round(pending.firstTop - nextTop);

    // Drive the FLIP animation through WAAPI rather than CSS. The global
    // reduced-motion rule intentionally uses !important and can otherwise
    // collapse this user-triggered feedback to a single frame in Electron.
    activePinRowAnimationRef.current?.cancel();
    const keyframes: Keyframe[] = Math.abs(offset) >= 1
      ? [
          { transform: `translateY(${offset}px)` },
          { transform: "translateY(0)" },
        ]
      : [
          { transform: "scale(0.985)" },
          { transform: "scale(1.012)", offset: 0.58 },
          { transform: "scale(1)" },
        ];
    const animation = row.animate(keyframes, {
      duration: 420,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "none",
    });
    activePinRowAnimationRef.current = animation;
    const clearAnimation = () => {
      if (activePinRowAnimationRef.current === animation) {
        activePinRowAnimationRef.current = null;
      }
    };
    animation.addEventListener("finish", clearAnimation, { once: true });
    animation.addEventListener("cancel", clearAnimation, { once: true });

    triggerActionFeedback(pending.id);
  }, [sessions]);

  useEffect(() => {
    // Fast Refresh and React's development remount cycle preserve refs while
    // rerunning effect cleanup/setup. Always restore the mounted flag here.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      searchRequestRef.current += 1;
      pinAnimationRef.current = null;
      activePinRowAnimationRef.current?.cancel();
      activePinRowAnimationRef.current = null;
      if (actionFeedbackTimerRef.current !== null) {
        window.clearTimeout(actionFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!pendingDeleteId) return;
    deleteCancelRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPendingDeleteId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingDeleteId]);

  const pendingDeleteSession = pendingDeleteId
    ? sessions.find((session) => session.id === pendingDeleteId) ?? null
    : null;

  const confirmDelete = () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    void onDelete(id);
  };

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <aside className={`sidebar ${open ? "open" : "closed"}`}>
        <button className="new-session-btn" onClick={onCreate}>
          <span className="plus">
            <PlusIcon size={16} />
          </span>
          <span>新建对话</span>
        </button>

        <div className="search-box">
          <SearchIcon size={16} />
          <input
            className="search-input"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="搜索对话"
            aria-label="搜索对话"
          />
        </div>

        <div className="section-head">
          <div className="section-label">最近对话</div>
        </div>

        <div className="session-list">
          {filtered.length === 0 ? (
            <p className="empty-hint">
              {keyword ? "没有匹配的对话" : "暂无对话"}
            </p>
          ) : (
            filtered.map((s, index) => (
              <div
                key={s.id}
                ref={(node) => {
                  if (node) sessionRowRefs.current.set(s.id, node);
                  else sessionRowRefs.current.delete(s.id);
                }}
                className={`session-item ${s.id === currentId ? "active" : ""} ${actionFeedbackKey === `pin:${s.id}` ? "pin-row-feedback" : ""}`}
                style={{
                  animationDelay: actionFeedbackKey === `pin:${s.id}` ? "0ms" : `${Math.min(index, 8) * 18}ms`,
                } as CSSProperties}
                onClick={() => onSelect(s.id)}
              >
                <div className="session-info">
                  {editingId === s.id ? (
                    <input
                      className="session-title-input"
                      value={editingTitle}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          finishRename(s.id);
                        }
                        if (e.key === "Escape") {
                          renameCommitRef.current = s.id;
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => finishRename(s.id)}
                      aria-label="重命名会话"
                    />
                  ) : (
                    <div
                      className="session-title"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        beginRename(s.id, s.title || "");
                      }}
                    >
                      {s.title || "未命名"}
                    </div>
                  )}
                  <div className="session-meta">
                    {new Date(s.updatedAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {s.messageCount} 条
                  </div>
                </div>
                <button
                  type="button"
                  className="rename-btn session-action-icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    beginRename(s.id, s.title || "");
                  }}
                  title="重命名"
                  aria-label="重命名会话"
                >
                  <EditIcon size={14} />
                </button>
                <button
                  type="button"
                  className={`session-action-btn session-action-icon ${s.pinned ? "pinned" : ""} ${actionFeedbackKey === `pin:${s.id}` ? "action-feedback pin-feedback" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const animationToken = ++pinAnimationTokenRef.current;
                    const previousRowTop = sessionRowRefs.current.get(s.id)?.getBoundingClientRect().top;
                    if (previousRowTop !== undefined) {
                      pinAnimationRef.current = {
                        id: s.id,
                        firstTop: previousRowTop,
                        token: animationToken,
                      };
                    }
                    const pinRequest = onPin(s.id, !s.pinned);
                    void Promise.resolve(pinRequest).then(
                      (result) => {
                        const pending = pinAnimationRef.current;
                        if (!pending || pending.token !== animationToken) return;
                        if (result === null || result === false) pinAnimationRef.current = null;
                      },
                      () => {
                        if (pinAnimationRef.current?.token === animationToken) {
                          pinAnimationRef.current = null;
                        }
                      },
                    );
                  }}
                  title={s.pinned ? "取消置顶" : "置顶"}
                  aria-label={s.pinned ? "取消置顶" : "置顶会话"}
                >
                  <PinIcon size={14} filled={Boolean(s.pinned)} />
                </button>
                <button
                  type="button"
                  className="delete-btn session-action-icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeleteId(s.id);
                  }}
                  title="删除"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <div className="footer-line">
            <span className="dot" />
            <span>本地运行 · 数据不上传</span>
          </div>
          <button className="settings-btn" onClick={onOpenSettings}>
            <SettingsIcon size={20} />
            <span>设置</span>
          </button>
        </div>
      </aside>

      {pendingDeleteSession && (
        <div
          className="delete-dialog-mask"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingDeleteId(null);
          }}
        >
          <section
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-description"
          >
            <h2 id="delete-dialog-title">删除这个对话？</h2>
            <p id="delete-dialog-description">
              “{pendingDeleteSession.title || "未命名"}”将被永久删除，此操作无法撤销。
            </p>
            <div className="delete-dialog-actions">
              <button
                ref={deleteCancelRef}
                type="button"
                className="delete-dialog-cancel"
                onClick={() => setPendingDeleteId(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="delete-dialog-confirm"
                onClick={confirmDelete}
              >
                删除
              </button>
            </div>
          </section>
        </div>
      )}

      <style jsx>{`
        .delete-dialog-mask {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: var(--modal-mask, rgba(0, 0, 0, 0.45));
          backdrop-filter: blur(2px);
        }
        .delete-dialog {
          width: min(400px, 100%);
          padding: 20px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--bg-panel);
          color: var(--text);
          box-shadow: 0 18px 55px rgba(0, 0, 0, 0.28);
        }
        .delete-dialog h2 {
          margin: 0 0 10px;
          font-size: 17px;
        }
        .delete-dialog p {
          margin: 0;
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.6;
          overflow-wrap: anywhere;
        }
        .delete-dialog-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 20px;
        }
        .delete-dialog-cancel,
        .delete-dialog-confirm {
          min-width: 72px;
          padding: 8px 14px;
          border: 1px solid var(--border);
          border-radius: 7px;
        }
        .delete-dialog-cancel {
          background: var(--bg-element);
          color: var(--text);
        }
        .delete-dialog-confirm {
          border-color: var(--error);
          background: var(--error);
          color: var(--on-error);
        }
        .delete-dialog-cancel:focus-visible,
        .delete-dialog-confirm:focus-visible {
          outline: 2px solid var(--primary);
          outline-offset: 2px;
        }
        .sidebar-overlay { display: none; }
        .sidebar {
          width: var(--sidebar-width, 264px);
          flex-shrink: 0;
          background: var(--bg-panel);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px;
          transition: width var(--motion-normal) var(--ease-emphasized), opacity 160ms var(--ease-standard), transform var(--motion-normal) var(--ease-emphasized);
          overflow: hidden;
        }
        .sidebar.closed {
          width: 0;
          padding: 12px 0;
          border-right: none;
          opacity: 0;
          transform: translateX(-10px);
        }
        /* 唯一主操作：实心主色按钮 */
        .new-session-btn {
          width: 100%;
          height: 38px;
          background: var(--primary);
          border-radius: 8px;
          color: var(--on-primary);
          font-weight: 500;
          font-size: 13.5px;
          display: flex;
          align-items: center;
          gap: 6px;
          justify-content: center;
          flex-shrink: 0;
          transition: filter 0.15s;
        }
        .new-session-btn:hover {
          background: var(--primary);
          filter: brightness(1.08);
        }
        .new-session-btn .plus {
          display: flex;
        }
        .search-box {
          height: 34px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 10px;
          background: var(--bg-element);
          border-radius: 8px;
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .search-input {
          flex: 1;
          min-width: 0;
          border: none;
          background: transparent;
          color: var(--text);
          font-family: inherit;
          font-size: 12.5px;
          outline: none;
        }
        .search-input::placeholder {
          color: var(--text-muted);
        }
        .section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 18px;
          padding: 0 2px;
          flex-shrink: 0;
        }
        .section-label {
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.5px;
          color: var(--text-muted);
          padding: 0;
        }
        .session-list {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin: 0 -6px;
          padding: 0 6px;
        }
        .empty-hint {
          padding: 20px;
          color: var(--text-muted);
          font-size: 13px;
          text-align: center;
        }
        .session-item {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px;
          border-radius: 8px;
          cursor: pointer;
          animation: yc-fade-up 220ms var(--ease-standard) both;
          transition: background var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
        }
        .session-item::before {
          content: "";
          position: absolute;
          left: 3px;
          top: 9px;
          bottom: 9px;
          width: 2px;
          border-radius: 999px;
          background: var(--primary);
          opacity: 0;
          transform: scaleY(0.3);
          transition: opacity var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-emphasized);
        }
        .session-item:hover { background: color-mix(in srgb, var(--bg-element) 86%, var(--primary) 14%); }
        .session-item:hover::before,
        .session-item.active::before { opacity: 1; transform: scaleY(1); }
        .session-item.active { background: var(--bg-element); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent); }
        .session-info { flex: 1; min-width: 0; }
        .session-title {
          font-size: 12.5px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text);
        }
        .session-title-input {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          border: 1px solid var(--primary);
          border-radius: 5px;
          padding: 3px 5px;
          background: var(--bg-panel);
          color: var(--text);
          font: inherit;
          outline: none;
        }
        .session-meta {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .rename-btn,
        .delete-btn,
        .session-action-btn {
          padding: 4px;
          opacity: 0;
          transform: translateX(4px) scale(0.92);
          transition: opacity var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-emphasized);
          color: var(--text-muted);
          display: flex;
        }
        .session-action-icon :global(svg) { display: block; }
        .session-item:hover .rename-btn,
        .session-item:hover .delete-btn,
        .session-item:hover .session-action-btn {
          opacity: 1;
          transform: translateX(0) scale(1);
        }
        .session-action-btn.pinned { color: var(--warning); }
        .session-action-btn:hover :global(svg) { transform: scale(1.12); }
        .session-item.pin-row-feedback {
          /* WAAPI owns transform while this class is active. */
          animation: none !important;
          will-change: transform;
          z-index: 1;
        }
        .sidebar-footer {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
          flex-shrink: 0;
        }
        .footer-line {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 10px;
          font-size: 11px;
          color: var(--text-muted);
        }
        .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--success);
        }
        /* 设置入口：从窗口标题栏移至侧栏底部用户区 */
        .settings-btn {
          width: 100%;
          height: 36px;
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 0 10px;
          border-radius: 8px;
          font-size: 13px;
          color: var(--text-secondary);
          transition: background 0.14s, color 0.14s;
        }
        .settings-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .settings-btn :global(svg) {
          transition: transform 320ms var(--ease-emphasized);
        }
        .settings-btn:hover :global(svg) { transform: rotate(22deg); }
        @media (max-width: 768px) {
          .sidebar {
            position: fixed;
            left: 0;
            top: 0;
            bottom: 0;
            z-index: 100;
          }
          .sidebar.closed {
            transform: translateX(-100%);
            width: 264px;
            padding: 12px;
          }
          .sidebar-overlay {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            animation: yc-fade-up 180ms var(--ease-standard) both;
            z-index: 99;
          }
        }
      `}</style>
    </>
  );
}
