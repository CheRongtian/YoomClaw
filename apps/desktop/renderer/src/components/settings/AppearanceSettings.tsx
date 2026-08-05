import { useTheme } from "../../theme/ThemeProvider";
import type { ThemeMode } from "../../theme/themes";
import { SunIcon, MoonIcon, MonitorIcon, CheckIcon } from "../icons";

const MODES: { value: ThemeMode; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "浅色", Icon: SunIcon },
  { value: "dark", label: "深色", Icon: MoonIcon },
  { value: "system", label: "跟随系统", Icon: MonitorIcon },
];

/** 外观设置：深浅模式 + 全部预设配色 */
export default function AppearanceSettings() {
  const { themeId, mode, themes, setThemeId, setMode } = useTheme();

  return (
    <>
      <div className="grp-title">模式</div>
      <div className="mode-seg">
        {MODES.map(({ value, label, Icon }) => (
          <button
            key={value}
            className={`mode-opt ${mode === value ? "active" : ""}`}
            data-testid={`appearance-mode-${value}`}
            onClick={() => setMode(value)}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="grp-title">
        颜色主题 <span className="count">{themes.length}</span>
      </div>
      <div className="theme-grid">
        {themes.map((t) => {
          const active = t.id === themeId;
          return (
            <button
              key={t.id}
              className={`theme-card ${active ? "active" : ""}`}
              data-testid={`appearance-theme-${t.id}`}
              onClick={() => setThemeId(t.id)}
            >
              <span className="tc-name">{t.name}</span>
              {active && (
                <span className="tc-check">
                  <CheckIcon size={13} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <style jsx>{`
        .grp-title {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: var(--text-muted);
          margin: 18px 0 9px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .grp-title:first-child {
          margin-top: 0;
        }
        .count {
          font-size: 10px;
          letter-spacing: 0;
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
          transition: border-color 0.15s, color 0.15s, background 0.15s;
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
          transition: border-color 0.15s, color 0.15s, background 0.15s;
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
      `}</style>
    </>
  );
}
