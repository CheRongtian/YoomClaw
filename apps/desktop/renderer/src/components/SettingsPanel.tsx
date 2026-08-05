import { useEffect, useState } from "react";
import { CloseIcon, SlidersIcon, PaletteIcon, InfoIcon } from "./icons";
import GeneralSettings from "./settings/GeneralSettings";
import AppearanceSettings from "./settings/AppearanceSettings";
import AboutSettings from "./settings/AboutSettings";
import AgentSettings from "./settings/AgentSettings";

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabId = "agent" | "general" | "appearance" | "about";

const TABS: { id: TabId; label: string; Icon: typeof SlidersIcon }[] = [
  { id: "agent", label: "Agent", Icon: SlidersIcon },
  { id: "general", label: "通用", Icon: SlidersIcon },
  { id: "appearance", label: "外观", Icon: PaletteIcon },
  { id: "about", label: "关于", Icon: InfoIcon },
];

/** 设置对话框：左侧分类导航 + 右侧内容，Esc 关闭 */
export default function SettingsPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("agent");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-mask" onClick={onClose}>
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <nav className="sp-nav">
          <div className="sp-nav-title">设置</div>
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item ${tab === id ? "active" : ""}`}
              data-testid={`settings-tab-${id}`}
              onClick={() => setTab(id)}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="sp-main">
          <header className="sp-head">
            <span className="sp-title">
              {TABS.find((t) => t.id === tab)?.label}
            </span>
            <button className="sp-close" data-testid="settings-close" onClick={onClose} aria-label="关闭">
              <CloseIcon size={15} />
            </button>
          </header>

          <div className="sp-body">
            {tab === "agent" && <AgentSettings />}
            {tab === "general" && <GeneralSettings />}
            {tab === "appearance" && <AppearanceSettings />}
            {tab === "about" && <AboutSettings />}
          </div>
        </section>
      </div>

      <style jsx>{`
        .settings-mask {
          position: fixed;
          inset: 0;
          background: var(--modal-mask);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 200;
        }
        .settings-panel {
          display: flex;
          width: 660px;
          max-width: 94vw;
          height: 540px;
          max-height: 86vh;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 24px 64px var(--modal-mask);
          overflow: hidden;
        }
        .sp-nav {
          width: 172px;
          flex-shrink: 0;
          background: var(--bg-panel);
          border-right: 1px solid var(--border);
          padding: 14px 10px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .sp-nav-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted);
          padding: 2px 10px 12px;
        }
        .nav-item {
          display: flex;
          align-items: center;
          gap: 9px;
          width: 100%;
          padding: 8px 10px;
          border-radius: 7px;
          font-size: 13px;
          color: var(--text-secondary);
          text-align: left;
          transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);
        }
        .nav-item:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .nav-item.active {
          background: color-mix(in srgb, var(--primary) 14%, transparent);
          color: var(--text);
        }
        .nav-item.active :global(svg) {
          color: var(--primary);
        }
        .sp-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }
        .sp-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 13px 14px 13px 18px;
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
        }
        .sp-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--text);
        }
        .sp-close {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          color: var(--text-muted);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .sp-close:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .sp-body {
          flex: 1;
          overflow-y: auto;
          padding: 16px 18px 22px;
        }
      `}</style>
    </div>
  );
}
