/**
 * 内置工具集。
 *
 * 每个工具都遵循同一约定：
 *  - 参数校验失败 → 返回 isError，而不是抛异常（让模型能看到错误并自我纠正）
 *  - 路径一律经过 sandbox 校验
 *  - 结果由调用方统一截断
 */

import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { TextDecoder, promisify } from "node:util";
import type {
  BrowserActionOptions,
  BrowserLocator,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserStatus,
  BrowserTab,
  ComputerStatus,
  SafetyMode,
  ToolDefinition,
  ToolRisk,
  ToolsetId,
} from "@yoomclaw/protocol";
import {
  resolveInWorkspace,
  judgeCommand,
  MAX_FILE_BYTES,
  BASH_TIMEOUT_MS,
} from "./sandbox.js";
import type { MemoryStore, SkillStore, MemoryStoreName } from "./config.js";
import { MEMORY_TOOLS } from "./memory-tools.js";
import { SKILL_TOOLS } from "./skill-tools.js";
import { BROWSER_TOOLS } from "./browser-tools.js";
import { ADVANCED_TOOLS } from "./advanced-tools.js";
import type { ToolServices } from "./services.js";
import { moveToTrash } from "./trash.js";

const execAsync = promisify(exec);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf16leDecoder = new TextDecoder("utf-16le");
const utf16beDecoder = new TextDecoder("utf-16be");
const gb18030Decoder = new TextDecoder("gb18030");

/**
 * Decode bytes emitted by a shell command without losing non-ASCII text.
 *
 * Windows cmd.exe uses the active OEM code page for redirected output (CP936
 * on Chinese Windows), while child_process.exec assumes UTF-8 when its
 * default string encoding is used. Keep the bytes until here so we can honor
 * UTF-8/UTF-16 output from modern tools and fall back to the Windows Chinese
 * code page for legacy cmd.exe output.
 */
export function decodeCommandOutput(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value.length === 0) return "";

  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    return utf16leDecoder.decode(value.subarray(2));
  }
  if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
    return utf16beDecoder.decode(value.subarray(2));
  }
  if (
    value.length >= 3 &&
    value[0] === 0xef &&
    value[1] === 0xbb &&
    value[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(value.subarray(3));
  }

  const endian = detectUtf16WithoutBom(value);
  if (endian === "le") return utf16leDecoder.decode(value);
  if (endian === "be") return utf16beDecoder.decode(value);

  try {
    return utf8Decoder.decode(value);
  } catch {
    // Legacy cmd.exe output on Simplified Chinese Windows is GBK, which is a
    // subset of GB18030 and is available through the platform TextDecoder.
    return gb18030Decoder.decode(value);
  }
}

function detectUtf16WithoutBom(value: Buffer): "le" | "be" | null {
  const pairCount = Math.floor(value.length / 2);
  if (pairCount < 4) return null;

  let evenZeroes = 0;
  let oddZeroes = 0;
  for (let i = 0; i < pairCount * 2; i += 2) {
    if (value[i] === 0) evenZeroes += 1;
    if (value[i + 1] === 0) oddZeroes += 1;
  }

  const threshold = Math.max(2, Math.floor(pairCount * 0.25));
  if (oddZeroes >= threshold && evenZeroes <= Math.floor(pairCount * 0.1)) return "le";
  if (evenZeroes >= threshold && oddZeroes <= Math.floor(pairCount * 0.1)) return "be";
  return null;
}

export interface ToolContext {
  sessionId: string;
  workspace: string;
  dataDir?: string;
  signal?: AbortSignal;
  memory?: MemoryStore;
  skills?: SkillStore;
  browser?: BrowserToolController;
  computer?: ComputerUseController;
  /** Permission policy for this run; omitted by legacy/direct tool callers. */
  safetyMode?: SafetyMode;
  /** Optional adapters for provider-backed and orchestrated tools. */
  services?: ToolServices;
  /** Registry visible to orchestration tools; never exposed to the model. */
  toolRegistry?: BuiltinTool[];
}

export interface BrowserToolController {
  snapshot(options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  listTabs(): Promise<BrowserTab[]>;
  selectTab(tabId: string): Promise<BrowserTab>;
  navigate(url: string, options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  click(target: BrowserLocator, options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  type(target: BrowserLocator, text: string, options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  scroll(direction: "up" | "down", options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  back(options?: BrowserActionOptions): Promise<BrowserSnapshot>;
  screenshot(options?: BrowserActionOptions): Promise<BrowserScreenshot>;
  status(): BrowserStatus;
}

export interface ComputerWindow {
  hwnd: number;
  title: string;
  processId?: number;
  processName?: string;
  focused?: boolean;
  visible?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ComputerElement {
  name?: string;
  automationId?: string;
  controlType?: string;
  hwnd?: number;
  enabled?: boolean;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: ComputerElement[];
}

export interface ComputerElementTarget {
  name?: string;
  automationId?: string;
  controlType?: string;
  index?: number;
}

export interface ComputerUseController {
  status(): ComputerStatus;
  setEnabled(enabled: boolean): void;
  listWindows(): Promise<ComputerWindow[]>;
  inspect(hwnd: number): Promise<ComputerElement>;
  screenshot(hwnd: number): Promise<{ hwnd: number; path: string }>;
  focus(hwnd: number): Promise<ComputerWindow>;
  click(hwnd: number, target: ComputerElementTarget): Promise<ComputerElement>;
  type(hwnd: number, target: ComputerElementTarget, text: string): Promise<ComputerElement>;
  pressKey(hwnd: number, key: string): Promise<{ hwnd: number; key: string }>;
  scroll(hwnd: number, direction: "up" | "down", target?: ComputerElementTarget): Promise<ComputerElement | ComputerWindow>;
  read(hwnd: number, target: ComputerElementTarget): Promise<{ value: string; element: ComputerElement }>;
  close(): Promise<void>;
}

export interface ToolOutcome {
  result: string;
  isError: boolean;
  code?: string;
  metadata?: Record<string, unknown>;
  /** Optional per-tool result cap; the Agent still enforces a hard upper bound. */
  resultLimit?: number;
}

export interface BuiltinTool {
  definition: ToolDefinition;
  /** 静态风险等级；bash 会在运行时再判定一次。 */
  risk: ToolRisk;
  /** 运行时风险判定，返回 null 表示无需确认。 */
  assess?(args: Record<string, unknown>): string | null;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

function ok(result: string): ToolOutcome {
  return { result, isError: false };
}

function fail(result: string): ToolOutcome {
  return { result, isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function resolveToolPath(ctx: ToolContext, target: string) {
  return resolveInWorkspace(ctx.workspace, target, {
    allowOutsideWorkspace: ctx.safetyMode === "full-access",
  });
}

// ===== read_file =====

const readFile: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "read_file",
    description:
      "读取文本文件内容。返回带行号的内容，便于后续精确修改。可选 offset/limit 读取指定行范围。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "默认相对于工作目录；完全访问权限下也可使用绝对路径" },
        offset: { type: "string", description: "起始行号，从 1 开始，可选" },
        limit: { type: "string", description: "读取行数，默认 500，可选" },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const p = argStr(args, "path");
    if (!p) return fail("缺少参数 path");

    const sb = resolveToolPath(ctx, p);
    if (!sb.ok) return fail(sb.reason);

    try {
      const stat = await fs.stat(sb.resolved);
      if (stat.isDirectory()) {
        return fail(`${p} 是目录，请用 list_dir`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        return fail(
          `文件过大（${(stat.size / 1024).toFixed(0)}KB，上限 ${MAX_FILE_BYTES / 1024}KB），请用 grep 检索或指定行范围`,
        );
      }

      const raw = await fs.readFile(sb.resolved, "utf8");
      const lines = raw.split("\n");

      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Number(args.limit) || 500);
      const slice = lines.slice(offset - 1, offset - 1 + limit);

      if (slice.length === 0) {
        return ok(`（文件共 ${lines.length} 行，第 ${offset} 行起为空）`);
      }

      const width = String(offset + slice.length - 1).length;
      const body = slice
        .map((l, i) => `${String(offset + i).padStart(width)} | ${l}`)
        .join("\n");

      const more =
        offset - 1 + slice.length < lines.length
          ? `\n\n（共 ${lines.length} 行，当前显示 ${offset}-${offset + slice.length - 1}）`
          : "";

      return ok(body + more);
    } catch (err) {
      return fail(`读取失败：${(err as Error).message}`);
    }
  },
};

// ===== write_file =====

const writeFile: BuiltinTool = {
  risk: "confirm",
  definition: {
    name: "write_file",
    description: "写入文件（覆盖已有内容）。会自动创建父目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "默认相对于工作目录；完全访问权限下也可使用绝对路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["path", "content"],
    },
  },
  assess(args) {
    return `将写入文件 ${String(args.path)}（${String(args.content ?? "").length} 字符），已有内容会被覆盖`;
  },
  async run(args, ctx) {
    const p = argStr(args, "path");
    if (!p) return fail("缺少参数 path");
    const content = typeof args.content === "string" ? args.content : null;
    if (content === null) return fail("缺少参数 content");

    const sb = resolveToolPath(ctx, p);
    if (!sb.ok) return fail(sb.reason);

    try {
      await fs.mkdir(path.dirname(sb.resolved), { recursive: true });
      await fs.writeFile(sb.resolved, content, "utf8");
      return ok(`已写入 ${p}（${content.length} 字符）`);
    } catch (err) {
      return fail(`写入失败：${(err as Error).message}`);
    }
  },
};

// ===== edit_file =====

const editFile: BuiltinTool = {
  risk: "confirm",
  definition: {
    name: "edit_file",
    description:
      "精确替换文件中的一段文本。比 write_file 更省 token，优先使用。old_text 必须在文件中唯一出现。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "默认相对于工作目录；完全访问权限下也可使用绝对路径" },
        old_text: { type: "string", description: "要被替换的原文，需唯一" },
        new_text: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  assess(args) {
    return `将修改文件 ${String(args.path)}`;
  },
  async run(args, ctx) {
    const p = argStr(args, "path");
    if (!p) return fail("缺少参数 path");
    const oldText = typeof args.old_text === "string" ? args.old_text : null;
    const newText = typeof args.new_text === "string" ? args.new_text : null;
    if (oldText === null || newText === null) {
      return fail("缺少参数 old_text 或 new_text");
    }
    if (oldText === newText) {
      return fail("old_text 与 new_text 相同，无需修改");
    }

    const sb = resolveToolPath(ctx, p);
    if (!sb.ok) return fail(sb.reason);

    try {
      const raw = await fs.readFile(sb.resolved, "utf8");
      const count = raw.split(oldText).length - 1;
      if (count === 0) return fail("未找到 old_text，请先用 read_file 确认原文");
      if (count > 1) {
        return fail(`old_text 出现 ${count} 次，不唯一。请提供更多上下文以定位`);
      }
      await fs.writeFile(sb.resolved, raw.replace(oldText, newText), "utf8");
      return ok(`已修改 ${p}`);
    } catch (err) {
      return fail(`修改失败：${(err as Error).message}`);
    }
  },
};

// ===== delete_file =====

const deleteFile: BuiltinTool = {
  risk: "confirm",
  definition: {
    name: "delete_file",
    description: "将指定文件移到系统回收站；完全访问权限下也可以处理工作区外的文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，可使用绝对路径" },
      },
      required: ["path"],
    },
  },
  assess(args) {
    return `将文件 ${String(args.path)} 移到系统回收站（可恢复），需要确认`;
  },
  async run(args, ctx) {
    const p = argStr(args, "path");
    if (!p) return fail("缺少参数 path");

    const sb = resolveToolPath(ctx, p);
    if (!sb.ok) return fail(sb.reason);

    try {
      const stat = await fs.stat(sb.resolved);
      if (stat.isDirectory()) return fail(`${p} 是目录，delete_file 只删除文件`);
      if (ctx.services?.trash) {
        await ctx.services.trash.move(sb.resolved);
      } else {
        await moveToTrash(sb.resolved);
      }
      return ok(`已将 ${p} 移到系统回收站，可从回收站恢复`);
    } catch (err) {
      return fail(`移到回收站失败：${(err as Error).message}`);
    }
  },
};

// ===== list_dir =====

const listDir: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "list_dir",
    description: "列出目录内容，标注文件/目录及大小。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "默认相对路径；完全访问权限下也可使用绝对路径，省略时为工作目录根" },
      },
    },
  },
  async run(args, ctx) {
    const p = argStr(args, "path") ?? ".";
    const sb = resolveToolPath(ctx, p);
    if (!sb.ok) return fail(sb.reason);

    try {
      const entries = await fs.readdir(sb.resolved, { withFileTypes: true });
      if (entries.length === 0) return ok("（空目录）");

      const skip = new Set(["node_modules", ".git", ".next", "dist", ".turbo"]);
      const lines: string[] = [];

      for (const e of entries.slice(0, 200)) {
        if (e.isDirectory()) {
          lines.push(`${e.name}/${skip.has(e.name) ? "  (已折叠)" : ""}`);
        } else {
          try {
            const st = await fs.stat(path.join(sb.resolved, e.name));
            lines.push(`${e.name}  ${(st.size / 1024).toFixed(1)}KB`);
          } catch {
            lines.push(e.name);
          }
        }
      }

      const more =
        entries.length > 200 ? `\n…还有 ${entries.length - 200} 项` : "";
      return ok(lines.join("\n") + more);
    } catch (err) {
      return fail(`列目录失败：${(err as Error).message}`);
    }
  },
};

// ===== grep =====

const grep: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "grep",
    description: "按正则搜索文件内容，默认在工作目录内；完全访问权限下也可搜索工作区外路径。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索起点，默认工作目录根；完全访问权限下可使用绝对路径" },
        glob: { type: "string", description: '文件名过滤，如 "*.ts"，可选' },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = argStr(args, "pattern");
    if (!pattern) return fail("缺少参数 pattern");

    const startRel = argStr(args, "path") ?? ".";
    const sb = resolveToolPath(ctx, startRel);
    if (!sb.ok) return fail(sb.reason);

    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return fail(`正则无效：${(err as Error).message}`);
    }

    const globPat = argStr(args, "glob");
    const globRe = globPat
      ? new RegExp(
          "^" +
            globPat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$",
          "i",
        )
      : null;

    const skip = new Set(["node_modules", ".git", ".next", "dist", ".turbo", "coverage"]);
    const hits: string[] = [];
    let scanned = 0;

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || hits.length >= 100) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= 100) return;
        if (ctx.safetyMode !== "full-access" && e.name.startsWith(".") && e.name !== ".env.example") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (skip.has(e.name)) continue;
          await walk(full, depth + 1);
        } else {
          if (globRe && !globRe.test(e.name)) continue;
          if (scanned++ > 2000) return;
          try {
            const st = await fs.stat(full);
            if (st.size > 512 * 1024) continue;
            const content = await fs.readFile(full, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const rel = path.relative(ctx.workspace, full);
                hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
                if (hits.length >= 100) return;
              }
            }
          } catch {
            // 二进制或无权限，跳过
          }
        }
      }
    }

    await walk(sb.resolved, 0);

    if (hits.length === 0) return ok(`未找到匹配 "${pattern}" 的内容`);
    return ok(
      hits.join("\n") + (hits.length >= 100 ? "\n…结果已截断至 100 条" : ""),
    );
  },
};

// ===== glob =====

const glob: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "glob",
    description: '按文件名模式查找文件，如 "*.ts"、"index.*"。',
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "文件名模式，支持 * 和 ?" },
        path: { type: "string", description: "起点目录，默认工作目录根；完全访问权限下可使用绝对路径" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = argStr(args, "pattern");
    if (!pattern) return fail("缺少参数 pattern");

    const sb = resolveToolPath(ctx, argStr(args, "path") ?? ".");
    if (!sb.ok) return fail(sb.reason);

    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
      "i",
    );

    const skip = new Set(["node_modules", ".git", ".next", "dist", ".turbo"]);
    const found: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || found.length >= 200) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= 200) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (skip.has(e.name) || (ctx.safetyMode !== "full-access" && e.name.startsWith("."))) continue;
          await walk(full, depth + 1);
        } else if (re.test(e.name)) {
          found.push(path.relative(ctx.workspace, full));
        }
      }
    }

    await walk(sb.resolved, 0);

    if (found.length === 0) return ok(`未找到匹配 "${pattern}" 的文件`);
    return ok(found.join("\n"));
  },
};

// ===== bash =====

const bash: BuiltinTool = {
  risk: "confirm",
  definition: {
    name: "bash",
    description:
      "执行 shell 命令。默认在工作目录内运行并按当前权限模式确认；完全访问权限下可操作工作区外路径。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
      },
      required: ["command"],
    },
  },
  assess(args) {
    const cmd = typeof args.command === "string" ? args.command : "";
    const verdict = judgeCommand(cmd);
    if (verdict.action === "allow") return null;
    return verdict.reason;
  },
  async run(args, ctx) {
    const cmd = argStr(args, "command");
    if (!cmd) return fail("缺少参数 command");

    const verdict = judgeCommand(cmd, { allowUnsafe: ctx.safetyMode === "full-access" });
    if (verdict.action === "block") {
      return fail(`已拒绝执行：${verdict.reason}`);
    }

    try {
      const outputEncoding = process.platform === "win32" ? "buffer" : "utf8";
      const { stdout, stderr } = (await execAsync(cmd, {
        cwd: ctx.workspace,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal: ctx.signal,
        encoding: outputEncoding,
      })) as { stdout: Buffer | string; stderr: Buffer | string };
      const out = [decodeCommandOutput(stdout), decodeCommandOutput(stderr)]
        .filter(Boolean)
        .join("\n")
        .trim();
      return ok(out || "（命令执行成功，无输出）");
    } catch (err) {
      const e = err as {
        message: string;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        killed?: boolean;
      };
      if (e.killed) {
        return fail(`命令超时（超过 ${BASH_TIMEOUT_MS / 1000}s）`);
      }
      const detail = [decodeCommandOutput(e.stdout), decodeCommandOutput(e.stderr)]
        .filter(Boolean)
        .join("\n")
        .trim();
      return fail(`命令失败：${detail || e.message}`);
    }
  },
};

// ===== get_time =====

const getTime: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "get_time",
    description: "获取当前系统时间。",
    parameters: { type: "object", properties: {} },
  },
  async run() {
    return ok(
      new Date().toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "long",
      }),
    );
  },
};

const CORE_TOOLS: BuiltinTool[] = [
  readFile,
  writeFile,
  editFile,
  deleteFile,
  listDir,
  grep,
  {
    ...grep,
    definition: {
      ...grep.definition,
      name: "search_files",
       description: "搜索文件内容；这是 grep 的 Hermes 兼容名称，完全访问权限下可搜索工作区外路径。",
    },
  },
  glob,
  bash,
  {
    ...bash,
    definition: {
      ...bash.definition,
      name: "run_command",
      description: "运行 shell 命令；这是 bash 的 Hermes 兼容名称，完全访问权限下可操作工作区外路径。",
    },
  },
  getTime,
];

function inferToolset(name: string): ToolsetId {
  if (name.startsWith("memory_")) return "memory";
  if (name.startsWith("skill_")) return "skills";
  if (name.startsWith("browser_")) return "browser";
  if (name === "update_plan" || name === "todo") return "planning";
  if (name === "web_fetch" || name === "web_extract" || name === "web_search") return "web";
  if (name === "execute_code") return "execution";
  if (name === "parallel" || name === "delegate_task") return "orchestration";
  if (name === "tool_search" || name === "mcp_invoke" || name.startsWith("mcp.")) return "mcp";
  if (name === "computer_use") return "computer";
  return "coding";
}

function withToolset(tool: BuiltinTool): BuiltinTool {
  return {
    ...tool,
    definition: {
      ...tool.definition,
      toolset: tool.definition.toolset ?? inferToolset(tool.definition.name),
    },
  };
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  ...CORE_TOOLS,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...BROWSER_TOOLS,
  ...ADVANCED_TOOLS,
].map(withToolset);
