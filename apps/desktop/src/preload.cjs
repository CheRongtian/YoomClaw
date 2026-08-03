/**
 * Preload script - 暴露安全的 API 给渲染进程
 * 通过 contextBridge 暴露窗口控制 / 应用设置 / 通知 API
 * 渲染进程通过 window.yoomclaw 访问
 */
const { contextBridge, ipcRenderer } = require("electron");

// 只允许主进程通过这些频道推事件，避免渲染层被任意频道注入
const ALLOWED_EVENTS = ["menu:new-chat", "menu:open-settings", "window:state"];

contextBridge.exposeInMainWorld("yoomclaw", {
  // 窗口控制
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  hideToTray: () => ipcRenderer.invoke("hide-to-tray"),
  quit: () => ipcRenderer.invoke("quit"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),

  // 应用设置（持久化在主进程 userData/settings.json）
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),

  // 应用信息 / 数据目录
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  openDataDir: () => ipcRenderer.invoke("app:open-data-dir"),

  // 系统通知 (AI 回复完成时)
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),

  // 平台信息
  platform: process.platform,
  isElectron: true,

  // 监听主进程事件，返回取消订阅函数
  on: (channel, cb) => {
    if (!ALLOWED_EVENTS.includes(channel)) return () => {};
    const handler = (_evt, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
