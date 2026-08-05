import { ReactNode } from "react";

/** 一行设置项：左侧标题+说明，右侧控件 */
export function SettingRow({
  label,
  hint,
  control,
  disabled,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={`row ${disabled ? "disabled" : ""}`}>
      <div className="row-text">
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{control}</div>

      <style jsx>{`
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 11px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .row:last-child {
          border-bottom: none;
        }
        .row.disabled {
          opacity: 0.45;
          pointer-events: none;
        }
        .row-text {
          min-width: 0;
        }
        .row-label {
          font-size: 13px;
          color: var(--text);
        }
        .row-hint {
          font-size: 11.5px;
          color: var(--text-muted);
          margin-top: 3px;
          line-height: 1.5;
        }
        .row-control {
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

/** 块级设置项：标题在上，控件占满一行（用于选项较宽的分段控件） */
export function SettingBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="block">
      <div className="blk-label">{label}</div>
      {hint && <div className="blk-hint">{hint}</div>}
      <div className="blk-body">{children}</div>

      <style jsx>{`
        .block {
          padding: 12px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .block:last-child {
          border-bottom: none;
        }
        .blk-label {
          font-size: 13px;
          color: var(--text);
        }
        .blk-hint {
          font-size: 11.5px;
          color: var(--text-muted);
          margin-top: 3px;
          line-height: 1.5;
        }
        .blk-body {
          margin-top: 9px;
        }
      `}</style>
    </div>
  );
}

/** 开关 */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${checked ? "on" : ""}`}
      data-testid={`setting-toggle-${label}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />

      <style jsx>{`
        .toggle {
          width: 38px;
          height: 22px;
          border-radius: 999px;
          background: var(--bg-element);
          border: 1px solid var(--border);
          padding: 0;
          position: relative;
          transition: background 0.16s, border-color 0.16s;
        }
        .toggle:hover {
          border-color: var(--border-active);
        }
        .toggle.on {
          background: var(--primary);
          border-color: var(--primary);
        }
        .knob {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--text-muted);
          transition: transform 0.16s, background 0.16s;
        }
        .toggle.on .knob {
          transform: translateX(16px);
          background: var(--on-primary);
        }
      `}</style>
    </button>
  );
}

/** 分段选择器 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  compact,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={`seg ${compact ? "compact" : ""}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`seg-opt ${o.value === value ? "active" : ""}`}
          data-testid={`setting-option-${String(o.value)}`}
          onClick={() => onChange(o.value)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}

      <style jsx>{`
        .seg {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .seg-opt {
          flex: 1;
          min-width: 84px;
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-secondary);
          font-size: 12.5px;
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .seg.compact .seg-opt {
          flex: 0 0 auto;
          min-width: 0;
          padding: 6px 12px;
        }
        .seg-opt:hover {
          border-color: var(--border-active);
          color: var(--text);
        }
        .seg-opt.active {
          border-color: var(--primary);
          color: var(--text);
          background: color-mix(in srgb, var(--primary) 14%, transparent);
        }
      `}</style>
    </div>
  );
}
