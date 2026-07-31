/**
 * Preload script - 暴露安全的 API 给渲染进程
 * 通过 contextBridge 暴露极简的窗口控制 + 通知 API
 * 渲染进程通过 window.yoomclaw 访问
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yoomclaw", {
  // 窗口控制
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  hideToTray: () => ipcRenderer.invoke("hide-to-tray"),
  quit: () => ipcRenderer.invoke("quit"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),

  // 系统通知 (AI 回复完成时)
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),

  // 平台信息
  platform: process.platform,
  isElectron: true,

  // 监听主进程事件
  on: (channel, cb) => {
    const allowed = ["menu:new-chat"];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_evt, ...args) => cb(...args));
    }
  },
});
