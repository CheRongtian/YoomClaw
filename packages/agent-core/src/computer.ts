import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ComputerStatus } from "@yoomclaw/protocol";
import type {
  ComputerElement,
  ComputerElementTarget,
  ComputerUseController,
  ComputerWindow,
} from "./tools.js";

const HELPER_NAME = "YoomClaw.ComputerControl.exe";
const REQUEST_TIMEOUT_MS = 30_000;

export class ComputerControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ComputerControlError";
  }
}

export interface ComputerControllerOptions {
  enabled?: boolean;
  helperPath?: string;
}

interface HelperResponse {
  id?: string | null;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function resolveComputerHelperPath(explicit?: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    explicit,
    process.env.YOOMCLAW_COMPUTER_HELPER,
    process.env.YOOMCLAW_HELPER_DIR ? path.join(process.env.YOOMCLAW_HELPER_DIR, HELPER_NAME) : undefined,
    resourcesPath ? path.join(resourcesPath, "runtime-helpers", "computer-control-win", HELPER_NAME) : undefined,
    resourcesPath ? path.join(resourcesPath, "app", "runtime", "computer-control-win", HELPER_NAME) : undefined,
    path.join(process.cwd(), "apps", "desktop", "runtime", "computer-control-win", HELPER_NAME),
    path.join(process.cwd(), "packages", "computer-control-win", "bin", "Release", "net8.0-windows10.0.17763.0", "win-x64", "publish", HELPER_NAME),
    path.join(process.cwd(), "packages", "computer-control-win", "bin", "Release", "net8.0-windows", "win-x64", "publish", HELPER_NAME),
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    const normalized = /\.(?:exe|mjs|cjs|js|cmd)$/i.test(candidate)
      ? candidate
      : path.join(candidate, HELPER_NAME);
    if (fs.existsSync(normalized)) return normalized;
  }
  return undefined;
}

export class WindowsComputerUseController implements ComputerUseController {
  private enabled: boolean;
  private readonly helperPath?: string;
  private readonly auditPath: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private output: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private helperVersion: string | undefined;
  private lastError = "";

  constructor(
    private readonly dataDir: string,
    options: ComputerControllerOptions = {},
  ) {
    this.enabled = options.enabled ?? process.env.YOOMCLAW_COMPUTER_ENABLED === "true";
    this.helperPath = resolveComputerHelperPath(options.helperPath);
    this.auditPath = path.join(dataDir, "computer", "audit.jsonl");
  }

  status(): ComputerStatus {
    if (process.platform !== "win32") {
      return { enabled: this.enabled, available: false, platform: process.platform, message: "Windows computer control is only supported on Windows." };
    }
    if (!this.enabled) {
      return { enabled: false, available: false, platform: process.platform, message: "Windows computer control is disabled." };
    }
    if (!this.helperPath) {
      return { enabled: true, available: false, platform: process.platform, message: "Windows computer control helper is not built." };
    }
    return {
      enabled: true,
      available: Boolean(this.helperPath) && !this.lastError,
      ...(this.helperVersion ? { helperVersion: this.helperVersion } : {}),
      ...(this.lastError ? { message: this.lastError } : {}),
      platform: process.platform,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.lastError = "";
    if (!enabled) void this.close();
  }

  async listWindows(): Promise<ComputerWindow[]> {
    return this.request<ComputerWindow[]>({ action: "list_windows" });
  }

  async inspect(hwnd: number): Promise<ComputerElement> {
    return this.request<ComputerElement>({ action: "inspect", hwnd: this.requireHwnd(hwnd) });
  }

  async screenshot(hwnd: number): Promise<{ hwnd: number; path: string }> {
    const safeHwnd = this.requireHwnd(hwnd);
    const screenshotDir = path.join(this.dataDir, "computer", "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const outputPath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
    return this.request<{ hwnd: number; path: string }>({
      action: "screenshot",
      hwnd: safeHwnd,
      outputPath,
    });
  }

  async focus(hwnd: number): Promise<ComputerWindow> {
    return this.request<ComputerWindow>({ action: "focus", hwnd: this.requireHwnd(hwnd) });
  }

  async click(hwnd: number, target: ComputerElementTarget): Promise<ComputerElement> {
    return this.request<ComputerElement>({
      action: "click",
      hwnd: this.requireHwnd(hwnd),
      element: this.requireTarget(target),
      allowInputInjection: true,
    });
  }

  async type(hwnd: number, target: ComputerElementTarget, text: string): Promise<ComputerElement> {
    if (typeof text !== "string") throw new ComputerControlError("Text is required", "TEXT_REQUIRED");
    return this.request<ComputerElement>({
      action: "type",
      hwnd: this.requireHwnd(hwnd),
      element: this.requireTarget(target),
      text,
      allowInputInjection: true,
    });
  }

  async pressKey(hwnd: number, key: string): Promise<{ hwnd: number; key: string }> {
    if (!key.trim()) throw new ComputerControlError("Key is required", "KEY_REQUIRED");
    return this.request<{ hwnd: number; key: string }>({
      action: "press_key",
      hwnd: this.requireHwnd(hwnd),
      key,
      allowInputInjection: true,
    });
  }

  async scroll(hwnd: number, direction: "up" | "down", target?: ComputerElementTarget): Promise<ComputerElement | ComputerWindow> {
    if (direction !== "up" && direction !== "down") throw new ComputerControlError("Scroll direction must be up or down", "DIRECTION_REQUIRED");
    return this.request<ComputerElement | ComputerWindow>({
      action: "scroll",
      hwnd: this.requireHwnd(hwnd),
      direction,
      ...(target ? { element: this.requireTarget(target) } : {}),
      allowInputInjection: true,
    });
  }

  async read(hwnd: number, target: ComputerElementTarget): Promise<{ value: string; element: ComputerElement }> {
    return this.request<{ value: string; element: ComputerElement }>({
      action: "read",
      hwnd: this.requireHwnd(hwnd),
      element: this.requireTarget(target),
    });
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerControlError("Computer helper closed", "COMPUTER_HELPER_CLOSED"));
      this.pending.delete(id);
    }
    this.output?.close();
    this.output = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.startPromise = null;
  }

  private async request<T>(payload: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    const id = randomUUID();
    const child = this.child;
    if (!child?.stdin.writable) throw new ComputerControlError("Computer helper stdin is unavailable", "COMPUTER_HELPER_UNAVAILABLE");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ComputerControlError("Computer helper request timed out", "COMPUTER_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, auditPath: this.auditPath, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ComputerControlError(error instanceof Error ? error.message : String(error), "COMPUTER_HELPER_WRITE_FAILED"));
      }
    });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.enabled) throw new ComputerControlError("Windows computer control is disabled", "COMPUTER_DISABLED");
    if (process.platform !== "win32") throw new ComputerControlError("Windows computer control is only supported on Windows", "COMPUTER_UNSUPPORTED_PLATFORM");
    if (!this.helperPath) throw new ComputerControlError("Windows computer control helper is not built", "COMPUTER_UNAVAILABLE");
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const extension = path.extname(this.helperPath!).toLowerCase();
        const command = extension === ".mjs" || extension === ".cjs" || extension === ".js"
          ? process.execPath
          : extension === ".cmd"
            ? (process.env.ComSpec ?? "cmd.exe")
            : this.helperPath!;
        const commandArgs = extension === ".mjs" || extension === ".cjs" || extension === ".js"
          ? [this.helperPath!]
          : extension === ".cmd"
            ? ["/d", "/s", "/c", this.helperPath!]
            : [];
        child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        reject(new ComputerControlError(error instanceof Error ? error.message : String(error), "COMPUTER_HELPER_START_FAILED"));
        return;
      }
      this.child = child;
      this.output = createInterface({ input: child.stdout });
      this.output.on("line", (line) => this.handleLine(line));
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-1000);
      });
      child.once("error", (error) => {
        this.lastError = error.message;
        reject(new ComputerControlError(error.message, "COMPUTER_HELPER_START_FAILED"));
      });
      child.once("exit", (code) => {
        this.child = null;
        this.output?.close();
        this.output = null;
        if (code !== 0 && stderr.trim()) this.lastError = stderr.trim();
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new ComputerControlError(this.lastError || "Computer helper exited", "COMPUTER_HELPER_EXITED"));
          this.pending.delete(id);
        }
      });

      void this.requestInternal<{ version?: string }>({ action: "ping" })
        .then((result) => {
          this.helperVersion = typeof result.version === "string" ? result.version : undefined;
          resolve();
        })
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          reject(error);
        });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private requestInternal<T>(payload: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new ComputerControlError("Computer helper stdin is unavailable", "COMPUTER_HELPER_UNAVAILABLE"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ComputerControlError("Computer helper request timed out", "COMPUTER_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, auditPath: this.auditPath, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ComputerControlError(error.message, "COMPUTER_HELPER_WRITE_FAILED"));
      });
    });
  }

  private handleLine(line: string): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      this.lastError = "Computer helper returned invalid JSON.";
      return;
    }
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    const code = response.error?.code || "COMPUTER_HELPER_ERROR";
    const message = response.error?.message || "Computer helper request failed.";
    pending.reject(new ComputerControlError(message, code));
  }

  private requireHwnd(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ComputerControlError("A valid target window handle is required", "WINDOW_REQUIRED");
    return value;
  }

  private requireTarget(value: ComputerElementTarget): ComputerElementTarget {
    if (!value || typeof value !== "object") throw new ComputerControlError("A UI Automation element selector is required", "ELEMENT_REQUIRED");
    if (!value.name && !value.automationId && !value.controlType) {
      throw new ComputerControlError("Element selector needs name, automationId, or controlType", "ELEMENT_SELECTOR_REQUIRED");
    }
    if (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 0)) {
      throw new ComputerControlError("Element selector index is invalid", "ELEMENT_INDEX_INVALID");
    }
    return value;
  }
}
