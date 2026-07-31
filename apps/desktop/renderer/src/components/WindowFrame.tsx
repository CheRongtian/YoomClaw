import { ReactNode } from "react";
import SpiralLogo from "./SpiralLogo";
import { SettingsIcon } from "./icons";

interface Props {
  onOpenSettings: () => void;
  children: ReactNode;
}

/**
 * 桌面应用风格的窗口框架
 * - 自定义标题栏（traffic light 窗口控件接 window.yoomclaw）
 * - 圆角阴影边框
 * - 标题栏右侧设置按钮 -> 打开外观设置面板
 */
export default function WindowFrame({ onOpenSettings, children }: Props) {
  const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;

  return (
    <div className="window-frame">
      <div className="title-bar">
        <div className="traffic-lights">
          <span
            className="light close"
            title="关闭"
            onClick={() => claw?.close()}
          />
          <span
            className="light minimize"
            title="最小化"
            onClick={() => claw?.minimize()}
          />
          <span
            className="light maximize"
            title="最大化"
            onClick={() => claw?.toggleMaximize()}
          />
        </div>
        <div className="title-text">
          <span className="title-logo">
            <SpiralLogo size={16} />
          </span>
          <span>YoomClaw</span>
        </div>
        <div className="title-actions">
          <button
            className="title-btn"
            onClick={onOpenSettings}
            title="外观设置"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>
      <div className="window-body">{children}</div>

      <style jsx>{`
        .window-frame {
          display: flex;
          flex-direction: column;
          height: 100vh;
          width: 100vw;
          overflow: hidden;
          background: var(--bg);
        }
        .title-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 38px;
          padding: 0 12px;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
          -webkit-app-region: drag;
          user-select: none;
          flex-shrink: 0;
        }
        .traffic-lights {
          display: flex;
          gap: 8px;
          align-items: center;
          -webkit-app-region: no-drag;
        }
        .light {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          display: inline-block;
          cursor: pointer;
          transition: filter 0.15s;
        }
        .light:hover {
          filter: brightness(1.2);
        }
        .light.close {
          background: var(--tl-close);
        }
        .light.minimize {
          background: var(--tl-min);
        }
        .light.maximize {
          background: var(--tl-max);
        }
        .title-text {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--text-secondary);
          pointer-events: none;
        }
        .title-logo {
          color: var(--primary);
          display: flex;
        }
        .title-actions {
          display: flex;
          gap: 4px;
          -webkit-app-region: no-drag;
        }
        .title-btn {
          padding: 5px 8px;
          font-size: 14px;
          border-radius: 6px;
          color: var(--text-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .title-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .window-body {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}
