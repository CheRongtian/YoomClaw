import { useTheme } from "../theme/ThemeProvider";
import type { ThemeMode } from "../theme/themes";
import { SunIcon, MoonIcon, MonitorIcon, CheckIcon, CloseIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

const MODES: { value: ThemeMode; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "浅色", Icon: SunIcon },
  { value: "dark", label: "深色", Icon: MoonIcon },
  { value: "system", label: "跟随系统", Icon: MonitorIcon },
];

export default function SettingsPanel({ open, onClose }: Props) {
  const { themeId, mode, themes, setThemeId, setMode } = useTheme();

  if (!open) return null;

  return (
    <div className="settings-mask" onClick={onClose}>
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="外观设置"
      >
        <div className="sp-head">
          <span className="sp-title">外观</span>
          <button className="sp-close" onClick={onClose} aria-label="关闭">
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="sp-section">
          <div className="sp-label">模式</div>
          <div className="mode-seg">
            {MODES.map(({ value, label, Icon }) => (
              <button
                key={value}
                className={`mode-opt ${mode === value ? "active" : ""}`}
                onClick={() => setMode(value)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-label">
            颜色主题 <span className="sp-count">{themes.length}</span>
          </div>
          <div className="theme-grid">
            {themes.map((t) => {
              const active = t.id === themeId;
              return (
                <button
                  key={t.id}
                  className={`theme-card ${active ? "active" : ""}`}
                  onClick={() => setThemeId(t.id)}
                >
                  <span className="tc-name">{t.name}</span>
                  {active && (
                    <span className="tc-check">
                      <CheckIcon size={13} />
                    </span>
                  )}
                  {t.source === "opencode" && <span className="tc-tag">oc</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sp-foot">主题实时预览 · 自动保存到本地</div>
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
          width: 460px;
          max-width: 92vw;
          max-height: 82vh;
          display: flex;
          flex-direction: column;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 14px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
          overflow: hidden;
        }
        .sp-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          border-bottom: 1px solid var(--border);
        }
        .sp-title {
          font-size: 15px;
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
          font-size: 13px;
        }
        .sp-close:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .sp-section {
          padding: 14px 16px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .sp-label {
          font-size: 12px;
          color: var(--text-muted);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .sp-count {
          font-size: 10px;
          background: var(--bg-element);
          color: var(--text-muted);
          padding: 1px 6px;
          border-radius: 999px;
        }
        .mode-seg {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }
        .mode-opt {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 9px 6px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-secondary);
          font-size: 12.5px;
          transition: all 0.15s;
        }
        .mode-opt:hover {
          border-color: var(--border-active);
          color: var(--text);
        }
        .mode-opt.active {
          border-color: var(--primary);
          color: var(--text);
          background: color-mix(in srgb, var(--primary) 14%, transparent);
        }
        .mode-opt.active :global(svg) {
          color: var(--primary);
        }
        .theme-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          overflow-y: auto;
          max-height: 46vh;
          padding-right: 4px;
        }
        .theme-card {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 9px 11px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-secondary);
          font-size: 12.5px;
          text-align: left;
          transition: all 0.15s;
        }
        .theme-card:hover {
          border-color: var(--border-active);
          color: var(--text);
        }
        .theme-card.active {
          border-color: var(--primary);
          color: var(--text);
          background: color-mix(in srgb, var(--primary) 14%, transparent);
        }
        .tc-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tc-check {
          color: var(--primary);
          display: flex;
        }
        .tc-tag {
          font-size: 9px;
          color: var(--text-muted);
          background: var(--bg-element);
          padding: 0 4px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .sp-foot {
          padding: 12px 16px;
          font-size: 11px;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}
