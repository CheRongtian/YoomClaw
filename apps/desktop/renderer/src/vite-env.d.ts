/// <reference types="vite/client" />

import type { AppSettings, AppInfo } from "./types";

// styled-jsx：给 <style jsx> / <style jsx global> 补上属性声明，
// 否则每个用了 styled-jsx 的组件都会报 TS2322。
declare module "react" {
  interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
    jsx?: boolean;
    global?: boolean;
  }
}

// Electron preload 暴露的 window.yoomclaw API
export interface YoomClawApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  hideToTray(): void;
  quit(): void;
  isMaximized(): Promise<boolean>;

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  getAppInfo(): Promise<AppInfo>;
  openDataDir(): Promise<void>;

  notify(title: string, body: string): void;
  platform: string;
  isElectron: boolean;
  /** 订阅主进程事件，返回取消订阅函数 */
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    yoomclaw?: YoomClawApi;
  }
}

export {};
