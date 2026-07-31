/// <reference types="vite/client" />

// rehype-katex 不自带类型声明
declare module "rehype-katex";

// Electron preload 暴露的 window.yoomclaw API
export interface YoomClawApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  hideToTray(): void;
  quit(): void;
  isMaximized(): Promise<boolean>;
  notify(title: string, body: string): void;
  platform: string;
  isElectron: boolean;
  on(channel: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    yoomclaw: YoomClawApi;
  }
}

export {};
