import { useEffect, useState } from "react";
import type { AppInfo } from "../../types";
import { FolderIcon } from "../icons";

/** 关于：版本信息 + 数据目录 */
export default function AboutSettings() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (!claw?.getAppInfo) return;
    let alive = true;
    claw
      .getAppInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const rows: { k: string; v: string }[] = info
    ? [
        { k: "版本", v: `${info.version}${info.isDev ? " (开发模式)" : ""}` },
        { k: "平台", v: `${info.platform} · ${info.arch}` },
        { k: "Electron", v: info.electron },
        { k: "Chromium", v: info.chrome },
        { k: "Node", v: info.node },
      ]
    : [];

  return (
    <>
      <div className="about-head">
        <div className="app-name">YoomClaw</div>
        <div className="app-desc">本地优先的 AI 助手客户端</div>
      </div>

      {info ? (
        <>
          <div className="kv-list">
            {rows.map((r) => (
              <div className="kv" key={r.k}>
                <span className="kv-k">{r.k}</span>
                <span className="kv-v">{r.v}</span>
              </div>
            ))}
          </div>

          <div className="grp-title">数据目录</div>
          <div className="path-box">{info.dataDir}</div>
          <button
            type="button"
            className="open-btn"
            data-testid="about-open-data-dir"
            onClick={() => window.yoomclaw?.openDataDir()}
          >
            <FolderIcon size={14} />
            <span>在文件管理器中打开</span>
          </button>
        </>
      ) : (
        <div className="kv-empty">当前是浏览器访问，无法读取客户端信息。</div>
      )}

      <style jsx>{`
        .about-head {
          padding-bottom: 14px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .app-name {
          font-size: 17px;
          font-weight: 600;
          color: var(--text);
        }
        .app-desc {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 4px;
        }
        .kv-list {
          padding: 6px 0;
        }
        .kv {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          padding: 8px 0;
          font-size: 12.5px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .kv:last-child {
          border-bottom: none;
        }
        .kv-k {
          color: var(--text-muted);
        }
        .kv-v {
          color: var(--text-secondary);
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .kv-empty {
          font-size: 13px;
          color: var(--text-muted);
          padding-top: 14px;
        }
        .grp-title {
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.3px;
          color: var(--text-muted);
          margin: 22px 0 9px;
        }
        .path-box {
          font-size: 11.5px;
          font-family: var(--font-mono);
          color: var(--text-secondary);
          background: var(--code-bg);
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
          padding: 9px 11px;
          word-break: break-all;
          line-height: 1.55;
        }
        .open-btn {
          margin-top: 9px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 34px;
          padding: 8px 13px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-secondary);
          font-size: 12.5px;
          font-weight: 500;
          transition: border-color 0.15s, color 0.15s;
        }
        .open-btn:hover {
          border-color: var(--border-active);
          color: var(--text);
          background: color-mix(in srgb, var(--bg-panel) 84%, var(--primary));
        }
      `}</style>
    </>
  );
}
