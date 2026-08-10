import { useAppSettings } from "../../hooks/useAppSettings";
import type { AppSettings } from "../../types";
import { SettingBlock, SettingRow, Segmented, Toggle } from "./controls";

const ZOOM_MIN_PERCENT = 75;
const ZOOM_MAX_PERCENT = 150;

/** 通用设置：窗口行为 / 启动 / 通知 / 缩放 —— 全部持久化在主进程 */
export default function GeneralSettings() {
  const { settings, available, loading, update } = useAppSettings();

  if (loading) {
    return <div className="sp-empty">读取设置中…</div>;
  }

  if (!available || !settings) {
    return (
      <div className="sp-empty">
        <p>窗口与启动相关设置仅在桌面客户端可用。</p>
        <p className="sub">当前是浏览器访问，主题设置仍可正常使用。</p>

        <style jsx>{`
          .sp-empty {
            font-size: 13px;
            color: var(--text-muted);
            line-height: 1.7;
          }
          .sub {
            font-size: 11.5px;
            margin-top: 4px;
          }
        `}</style>
      </div>
    );
  }

  return (
    <>
      <div className="grp-title">窗口</div>

      <SettingBlock
        label="点击关闭按钮时"
        hint="选择“退出应用”后，标题栏的关闭按钮会直接结束程序，托盘图标一并移除。"
      >
        <Segmented<AppSettings["closeAction"]>
          value={settings.closeAction}
          onChange={(v) => update({ closeAction: v })}
          options={[
            { value: "tray", label: "最小化到托盘" },
            { value: "quit", label: "退出应用" },
          ]}
        />
      </SettingBlock>

      <SettingBlock label="点击最小化按钮时">
        <Segmented<AppSettings["minimizeAction"]>
          value={settings.minimizeAction}
          onChange={(v) => update({ minimizeAction: v })}
          options={[
            { value: "taskbar", label: "最小化到任务栏" },
            { value: "tray", label: "最小化到托盘" },
          ]}
        />
      </SettingBlock>

      <SettingRow
        label="窗口始终置顶"
        hint="让 YoomClaw 悬浮在其他程序之上"
        control={
          <Toggle
            label="窗口始终置顶"
            checked={settings.alwaysOnTop}
            onChange={(v) => update({ alwaysOnTop: v })}
          />
        }
      />

      <div className="grp-title">启动</div>

      <SettingRow
        label="开机时自动启动"
        hint="登录 macOS 后自动运行 YoomClaw"
        control={
          <Toggle
            label="开机时自动启动"
            checked={settings.launchAtLogin}
            onChange={(v) => update({ launchAtLogin: v })}
          />
        }
      />

      <SettingRow
        label="启动后最小化到托盘"
        hint="启动时不弹出主窗口，静默在后台待命"
        control={
          <Toggle
            label="启动后最小化到托盘"
            checked={settings.startMinimized}
            onChange={(v) => update({ startMinimized: v })}
          />
        }
      />

      <div className="grp-title">通知与显示</div>

      <SettingRow
        label="回复完成时通知"
        hint="窗口在后台时，AI 回复结束发送系统通知"
        control={
          <Toggle
            label="回复完成时通知"
            checked={settings.notifyOnComplete}
            onChange={(v) => update({ notifyOnComplete: v })}
          />
        }
      />

      <SettingBlock label="界面缩放" hint="调整整个界面的显示比例">
        <div className="zoom-control">
          <div className="zoom-control-top">
            <output className="zoom-value" htmlFor="setting-zoom-slider">
              {Math.round(settings.zoomFactor * 100)}%
            </output>
          </div>
          <div className="zoom-slider-wrap">
            <input
              id="setting-zoom-slider"
              className="zoom-slider"
              data-testid="setting-zoom-slider"
              type="range"
              min={ZOOM_MIN_PERCENT}
              max={ZOOM_MAX_PERCENT}
              step={1}
              value={Math.round(settings.zoomFactor * 100)}
              onChange={(event) => update({ zoomFactor: Number(event.currentTarget.value) / 100 })}
              aria-label="界面缩放"
              aria-valuetext={`${Math.round(settings.zoomFactor * 100)}%`}
            />
          </div>
          <div className="zoom-scale" aria-hidden="true">
            <span>{ZOOM_MIN_PERCENT}%</span>
            <span>{ZOOM_MAX_PERCENT}%</span>
          </div>
        </div>
      </SettingBlock>

      <style jsx>{`
        .grp-title {
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.3px;
          color: var(--text-muted);
          margin: 22px 0 4px;
        }
        .grp-title:first-child {
          margin-top: 0;
        }
        .zoom-control {
          width: 100%;
        }
        .zoom-control-top {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 8px;
        }
        .zoom-value {
          min-width: 48px;
          padding: 4px 9px;
          border: 1px solid var(--border-active);
          border-radius: 8px;
          color: var(--text);
          background: var(--bg-panel);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          text-align: center;
        }
        .zoom-slider-wrap {
          width: 100%;
          height: 17px;
          display: flex;
          align-items: center;
        }
        .zoom-slider {
          display: block;
          width: 100%;
          height: 17px;
          margin: 0;
          appearance: none;
          outline: none;
          background: transparent;
          cursor: pointer;
        }
        .zoom-slider::-webkit-slider-runnable-track {
          box-sizing: border-box;
          height: 4px;
          border: 1px solid var(--border-active);
          border-radius: 999px;
          background: var(--border-active);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--bg-panel) 70%, transparent);
        }
        .zoom-slider::-moz-range-track {
          box-sizing: border-box;
          height: 4px;
          border: 1px solid var(--border-active);
          border-radius: 999px;
          background: var(--border-active);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--bg-panel) 70%, transparent);
        }
        .zoom-slider::-webkit-slider-thumb {
          box-sizing: border-box;
          width: 17px;
          height: 17px;
          margin-top: -7px;
          appearance: none;
          border: 2px solid var(--bg-panel);
          border-radius: 50%;
          background: var(--primary);
          box-shadow: 0 0 0 1px var(--primary);
        }
        .zoom-slider::-moz-range-thumb {
          box-sizing: border-box;
          width: 17px;
          height: 17px;
          border: 2px solid var(--bg-panel);
          border-radius: 50%;
          background: var(--primary);
          box-shadow: 0 0 0 1px var(--primary);
        }
        .zoom-slider:focus-visible {
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 24%, transparent);
        }
        .zoom-scale {
          display: flex;
          justify-content: space-between;
          margin-top: 7px;
          color: var(--text-muted);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </>
  );
}
