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
  workspace: string;
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

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "manual-install-required"
  | "not-available"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  targetVersion?: string;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  downloadedPath?: string;
  message: string;
  platform: string;
  arch: string;
  enabled: boolean;
}
