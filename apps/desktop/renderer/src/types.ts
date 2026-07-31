/** 主进程持久化的应用设置（userData/settings.json），与 apps/desktop/src/settings.cjs 保持同构 */
export interface AppSettings {
  /** 点关闭按钮：收进托盘 | 直接退出 */
  closeAction: "tray" | "quit";
  /** 点最小化按钮：进任务栏 | 收进托盘 */
  minimizeAction: "taskbar" | "tray";
  launchAtLogin: boolean;
  startMinimized: boolean;
  alwaysOnTop: boolean;
  notifyOnComplete: boolean;
  zoomFactor: number;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  dataDir: string;
  isDev: boolean;
}
