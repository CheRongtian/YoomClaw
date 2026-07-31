import { useAppSettings } from "../../hooks/useAppSettings";
import type { AppSettings } from "../../types";
import { SettingBlock, SettingRow, Segmented, Toggle } from "./controls";

const ZOOM_OPTIONS: { value: number; label: string }[] = [
  { value: 0.75, label: "75%" },
  { value: 0.9, label: "90%" },
  { value: 1, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
];

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
        hint="登录 Windows 后自动运行 YoomClaw"
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
        <Segmented<number>
          compact
          value={settings.zoomFactor}
          onChange={(v) => update({ zoomFactor: v })}
          options={ZOOM_OPTIONS}
        />
      </SettingBlock>

      <style jsx>{`
        .grp-title {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: var(--text-muted);
          margin: 18px 0 2px;
        }
        .grp-title:first-child {
          margin-top: 0;
        }
      `}</style>
    </>
  );
}
