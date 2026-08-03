import { useState } from "react";
import type { SessionSummary } from "@yoomclaw/protocol";
import {
  PlusIcon,
  TrashIcon,
  SearchIcon,
  SettingsIcon,
} from "./icons";

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}

export default function SessionSidebar({
  sessions,
  currentId,
  open,
  onSelect,
  onCreate,
  onDelete,
  onClose,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? sessions.filter((s) => (s.title || "").toLowerCase().includes(keyword))
    : sessions;

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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话"
            aria-label="搜索对话"
          />
        </div>

        <div className="section-label">最近对话</div>

        <div className="session-list">
          {filtered.length === 0 ? (
            <p className="empty-hint">
              {keyword ? "没有匹配的对话" : "暂无对话"}
            </p>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === currentId ? "active" : ""}`}
                onClick={() => onSelect(s.id)}
              >
                <div className="session-info">
                  <div className="session-title">{s.title || "未命名"}</div>
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
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("删除这个对话?")) onDelete(s.id);
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

      <style jsx>{`
        .sidebar-overlay { display: none; }
        .sidebar {
          width: 264px;
          flex-shrink: 0;
          background: var(--bg-panel);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px;
          transition: width 0.2s ease;
          overflow: hidden;
        }
        .sidebar.closed {
          width: 0;
          padding: 12px 0;
          border-right: none;
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
        .section-label {
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.5px;
          color: var(--text-muted);
          padding: 0 2px;
          flex-shrink: 0;
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
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px;
          border-radius: 8px;
          cursor: pointer;
        }
        .session-item:hover { background: var(--bg-element); }
        .session-item.active { background: var(--bg-element); }
        .session-info { flex: 1; min-width: 0; }
        .session-title {
          font-size: 13.5px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text);
        }
        .session-meta {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .delete-btn {
          padding: 4px;
          font-size: 12px;
          opacity: 0;
          transition: opacity 0.15s;
          color: var(--text-muted);
          display: flex;
        }
        .session-item:hover .delete-btn { opacity: 1; }
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
            z-index: 99;
          }
        }
      `}</style>
    </>
  );
}
