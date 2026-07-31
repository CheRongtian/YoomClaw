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
import { promisify } from "node:util";
import type { ToolDefinition, ToolRisk } from "@yoomclaw/protocol";
import {
  resolveInWorkspace,
  judgeCommand,
  MAX_FILE_BYTES,
  BASH_TIMEOUT_MS,
} from "./sandbox.js";

const execAsync = promisify(exec);

export interface ToolContext {
  sessionId: string;
  workspace: string;
}

export interface ToolOutcome {
  result: string;
  isError: boolean;
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
        path: { type: "string", description: "相对于工作目录的文件路径" },
        offset: { type: "string", description: "起始行号，从 1 开始，可选" },
        limit: { type: "string", description: "读取行数，默认 500，可选" },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const p = argStr(args, "path");
    if (!p) return fail("缺少参数 path");

    const sb = resolveInWorkspace(ctx.workspace, p);
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
        path: { type: "string", description: "相对于工作目录的文件路径" },
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

    const sb = resolveInWorkspace(ctx.workspace, p);
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
        path: { type: "string", description: "相对于工作目录的文件路径" },
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

    const sb = resolveInWorkspace(ctx.workspace, p);
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

// ===== list_dir =====

const listDir: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "list_dir",
    description: "列出目录内容，标注文件/目录及大小。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径，默认为工作目录根" },
      },
    },
  },
  async run(args, ctx) {
    const p = argStr(args, "path") ?? ".";
    const sb = resolveInWorkspace(ctx.workspace, p);
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
    description: "在工作目录内按正则搜索文件内容，返回匹配的文件与行号。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索起点，默认工作目录根" },
        glob: { type: "string", description: '文件名过滤，如 "*.ts"，可选' },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = argStr(args, "pattern");
    if (!pattern) return fail("缺少参数 pattern");

    const startRel = argStr(args, "path") ?? ".";
    const sb = resolveInWorkspace(ctx.workspace, startRel);
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
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
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
        path: { type: "string", description: "起点目录，默认工作目录根" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = argStr(args, "pattern");
    if (!pattern) return fail("缺少参数 pattern");

    const sb = resolveInWorkspace(ctx.workspace, argStr(args, "path") ?? ".");
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
          if (skip.has(e.name) || e.name.startsWith(".")) continue;
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
      "在工作目录内执行 shell 命令。只读命令（ls/cat/git status 等）自动执行，其余需用户确认，高危命令会被直接拒绝。",
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

    const verdict = judgeCommand(cmd);
    if (verdict.action === "block") {
      return fail(`已拒绝执行：${verdict.reason}`);
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: ctx.workspace,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      return ok(out || "（命令执行成功，无输出）");
    } catch (err) {
      const e = err as { message: string; stdout?: string; stderr?: string; killed?: boolean };
      if (e.killed) {
        return fail(`命令超时（超过 ${BASH_TIMEOUT_MS / 1000}s）`);
      }
      const detail = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
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

export const BUILTIN_TOOLS: BuiltinTool[] = [
  readFile,
  writeFile,
  editFile,
  listDir,
  grep,
  glob,
  bash,
  getTime,
];
