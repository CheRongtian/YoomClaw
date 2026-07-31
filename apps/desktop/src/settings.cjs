/**
 * YoomClaw Desktop - 主进程设置存储
 *
 * 这些设置必须由主进程持有：关闭行为 / 开机自启 / 置顶 / 缩放 等
 * 都需要在窗口创建之前或窗口事件里生效，且要跨重启保留。
 * 持久化位置：<userData>/settings.json
 *
 * 注意：主题（配色 + 深浅模式）属于纯渲染层状态，仍存在 localStorage，
 * 不走这里，避免启动时多一次 IPC 往返造成闪色。
 */
const { app } = require("electron");
const nodePath = require("node:path");
const fs = require("node:fs");

const DEFAULTS = Object.freeze({
  /** 点标题栏关闭按钮：最小化到托盘 | 直接退出 */
  closeAction: "tray",
  /** 点最小化按钮：最小化到任务栏 | 直接收进托盘 */
  minimizeAction: "taskbar",
  /** 开机自动启动 */
  launchAtLogin: false,
  /** 启动时不弹窗口，静默进托盘 */
  startMinimized: false,
  /** 窗口始终置顶 */
  alwaysOnTop: false,
  /** AI 回复完成时发系统通知 */
  notifyOnComplete: true,
  /** 界面缩放倍率 */
  zoomFactor: 1,
});

const ENUMS = {
  closeAction: ["tray", "quit"],
  minimizeAction: ["taskbar", "tray"],
};

const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.5;

let cache = null;

function filePath() {
  return nodePath.join(app.getPath("userData"), "settings.json");
}

/** 逐字段校验，任何非法值都退回默认值——坏掉的配置文件不能让 app 起不来 */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;

  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined) continue;
    const fallback = DEFAULTS[key];

    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value;
    } else if (typeof fallback === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    } else if (typeof fallback === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        out[key] = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
      }
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    // 首次启动 / 文件损坏：静默回落到默认值
    cache = { ...DEFAULTS };
  }
  return cache;
}

/** 合并写入并返回最新完整设置 */
function save(patch) {
  const next = sanitize({ ...load(), ...patch });
  cache = next;
  try {
    fs.mkdirSync(nodePath.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    console.error("[Settings] 写入失败:", err.message);
  }
  return next;
}

module.exports = { DEFAULTS, ZOOM_MIN, ZOOM_MAX, load, save, filePath };
