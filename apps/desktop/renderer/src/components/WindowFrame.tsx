import { ReactNode, useEffect, useState } from "react";
import SpiralLogo from "./SpiralLogo";
import {
  WinMinimizeIcon,
  WinMaximizeIcon,
  WinRestoreIcon,
  WinCloseIcon,
} from "./icons";

interface Props {
  children: ReactNode;
}

/**
 * 桌面应用窗口框架 —— Windows 平台惯例布局
 * - 左侧：应用图标 + 名称（可拖拽，双击最大化/还原）
 * - 右侧：最小化 / 最大化·还原 / 关闭（46px 方形按钮，关闭悬停变红）
 * - 设置入口已移至侧栏底部用户区，标题栏只保留窗口系统控件
 * - 最大化状态由主进程 window:state 事件同步，图标随之切换
 */
export default function WindowFrame({ children }: Props) {
  const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!claw) return;
    let alive = true;

    claw
      .isMaximized()
      .then((v) => {
        if (alive) setMaximized(!!v);
      })
      .catch(() => {});

    const off = claw.on("window:state", (payload) => {
      const state = payload as { maximized?: boolean } | undefined;
      setMaximized(!!state?.maximized);
    });

    return () => {
      alive = false;
      off?.();
    };
  }, [claw]);

  return (
    <div className="window-frame">
      <div className={`title-bar ${maximized ? "is-max" : ""}`}>
        <div
          className="tb-drag"
          onDoubleClick={() => claw?.toggleMaximize()}
          title=""
        >
          <span className="tb-logo">
            <SpiralLogo size={15} />
          </span>
          <span className="tb-title">YoomClaw</span>
        </div>

        <div className="tb-actions">
          <button
            className="win-btn"
            data-testid="window-minimize"
            onClick={() => claw?.minimize()}
            title="最小化"
            aria-label="最小化"
          >
            <WinMinimizeIcon />
          </button>
          <button
            className="win-btn"
            data-testid="window-maximize"
            onClick={() => claw?.toggleMaximize()}
            title={maximized ? "向下还原" : "最大化"}
            aria-label={maximized ? "向下还原" : "最大化"}
          >
            {maximized ? <WinRestoreIcon /> : <WinMaximizeIcon />}
          </button>
          <button
            className="win-btn close"
            data-testid="window-close"
            onClick={() => claw?.close()}
            title="关闭"
            aria-label="关闭"
          >
            <WinCloseIcon />
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
          align-items: stretch;
          height: 36px;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
          user-select: none;
          flex-shrink: 0;
        }
        /* 左侧品牌区同时是窗口拖拽区 */
        .tb-drag {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          padding-left: 12px;
          -webkit-app-region: drag;
        }
        .tb-logo {
          color: var(--primary);
          display: flex;
          flex-shrink: 0;
        }
        .tb-title {
          font-size: 12.5px;
          font-weight: 500;
          color: var(--text-secondary);
          letter-spacing: 0.2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tb-actions {
          display: flex;
          align-items: stretch;
          -webkit-app-region: no-drag;
          flex-shrink: 0;
        }
        /* 系统窗口控件：Windows 惯用 46px 宽、无圆角、贴边 */
        .win-btn {
          width: 46px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          border-radius: 0;
          transition: background 0.12s, color 0.12s;
        }
        .win-btn:hover {
          background: var(--bg-element);
          color: var(--text);
        }
        .win-btn:active {
          background: var(--bg-elevated);
        }
        .win-btn.close:hover {
          background: var(--error);
          color: var(--on-error);
        }
        .win-btn.close:active {
          background: color-mix(in srgb, var(--error) 82%, black);
          color: var(--on-error);
        }
        .window-body {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}
