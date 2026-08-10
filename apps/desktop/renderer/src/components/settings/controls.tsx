import type { ReactNode } from "react";

/** 中文主标签 + 技术名辅助标签，统一设置页的中英排版。 */
export function SettingLabel({
  label,
  term,
}: {
  label: string;
  term?: string;
}) {
  return (
    <span className="setting-label">
      <span>{label}</span>
      {term && <span className="setting-term">{term}</span>}

      <style jsx>{`
        .setting-label {
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          min-width: 0;
        }
        .setting-term {
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 450;
          letter-spacing: 0.1px;
        }
      `}</style>
    </span>
  );
}

/** 一行设置项：左侧标题+说明，右侧控件 */
export function SettingRow({
  label,
  hint,
  control,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
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
          padding: 13px 0;
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
          font-size: 13.5px;
          font-weight: 500;
          color: var(--text);
        }
        .row-hint {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 4px;
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
          font-size: 13.5px;
          font-weight: 500;
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
  testId,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "on" : ""}`}
      data-testid={testId ?? `setting-toggle-${label}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />

      <style jsx>{`
        .toggle {
          width: 48px;
          height: 28px;
          border-radius: 999px;
          background: var(--bg-element);
          border: 1px solid var(--border);
          padding: 0;
          position: relative;
          flex-shrink: 0;
          box-shadow: inset 0 1px 2px color-mix(in srgb, var(--text) 5%, transparent);
          transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
        }
        .toggle:hover:not(:disabled) {
          border-color: var(--border-active);
          background: color-mix(in srgb, var(--bg-element) 88%, var(--primary));
        }
        .toggle.on {
          background: var(--primary);
          border-color: var(--primary);
          box-shadow: 0 2px 8px color-mix(in srgb, var(--primary) 22%, transparent);
        }
        .toggle.on:hover:not(:disabled) {
          background: color-mix(in srgb, var(--primary) 90%, var(--bg-element));
        }
        .toggle:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .knob {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--text-muted);
          box-shadow: 0 1px 3px color-mix(in srgb, var(--bg) 28%, transparent);
          transition: transform var(--motion-fast) var(--ease-emphasized), background var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
        }
        .toggle.on .knob {
          transform: translateX(20px);
          background: var(--on-primary);
          box-shadow: 0 1px 3px color-mix(in srgb, var(--primary) 35%, transparent);
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
          type="button"
          className={`seg-opt ${o.value === value ? "active" : ""}`}
          data-testid={`setting-option-${String(o.value)}`}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
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
          transition: border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard);
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
