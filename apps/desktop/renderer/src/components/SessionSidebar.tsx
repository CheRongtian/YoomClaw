import type { SessionSummary } from "@yoomclaw/protocol";
import SpiralLogo from "./SpiralLogo";
import { PlusIcon, CloseIcon, TrashIcon } from "./icons";

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export default function SessionSidebar({
  sessions,
  currentId,
  open,
  onSelect,
  onCreate,
  onDelete,
  onClose,
}: Props) {
  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <aside className={`sidebar ${open ? "open" : "closed"}`}>
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-logo">
              <SpiralLogo size={22} />
            </span>
            <span className="brand-name">YoomClaw</span>
          </div>
          <button className="close-btn" onClick={onClose} title="收起侧栏">
            <CloseIcon size={16} />
          </button>
        </div>

        <button className="new-session-btn" onClick={onCreate}>
          <span className="plus">
            <PlusIcon size={18} />
          </span>
          <span>新建对话</span>
        </button>

        <div className="session-list">
          {sessions.length === 0 ? (
            <p className="empty-hint">暂无对话</p>
          ) : (
            sessions.map((s) => (
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
        </div>
      </aside>

      <style jsx>{`
        .sidebar-overlay { display: none; }
        .sidebar {
          width: 260px;
          flex-shrink: 0;
          background: var(--bg-sidebar);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease;
          overflow: hidden;
        }
        .sidebar.closed {
          width: 0;
          border-right: none;
        }
        .sidebar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 14px 10px;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .brand-logo {
          display: flex;
          color: var(--accent);
        }
        .brand-name {
          font-size: 17px;
          font-weight: 600;
          letter-spacing: -0.3px;
        }
        .close-btn {
          padding: 4px 8px;
          font-size: 13px;
          color: var(--text-muted);
          display: flex;
        }
        .new-session-btn {
          margin: 0 12px 10px;
          padding: 10px 12px;
          background: var(--bg-tertiary);
          border-radius: 8px;
          color: var(--text-primary);
          font-weight: 500;
          font-size: 13.5px;
          display: flex;
          align-items: center;
          gap: 8px;
          justify-content: center;
        }
        .new-session-btn:hover {
          background: var(--border);
        }
        .new-session-btn .plus {
          display: flex;
        }
        .session-list {
          flex: 1;
          overflow-y: auto;
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
          padding: 10px 10px;
          border-radius: 8px;
          cursor: pointer;
          margin-bottom: 2px;
        }
        .session-item:hover { background: var(--bg-tertiary); }
        .session-item.active { background: var(--bg-tertiary); }
        .session-info { flex: 1; min-width: 0; }
        .session-title {
          font-size: 13.5px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text-primary);
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
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          font-size: 11.5px;
          color: var(--text-muted);
        }
        .footer-line {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #22c55e;
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
            width: 260px;
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
