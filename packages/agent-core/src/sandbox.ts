/**
 * 沙箱与安全策略。
 *
 * 工具能读写文件、执行命令，是整个系统里唯一能造成不可逆损失的部分。
 * 这里的每条规则都按"默认拒绝"设计：不在允许范围内的一律挡掉。
 */

import path from "node:path";
import os from "node:os";

/** 单次工具结果回填给模型的最大字符数，超出会截断。 */
export const MAX_TOOL_RESULT_CHARS = 2000;

/** 单个文件读取上限，防止一个大文件打满内存。 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** bash 命令超时。 */
export const BASH_TIMEOUT_MS = 30_000;

/**
 * 默认策略下绝对禁止触碰的目录（即使用户把 workspace 设成了它们）。
 * 用户主目录本身也在内 —— 只允许其下的具体子目录，不允许直接对家目录递归操作。
 */
function forbiddenRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.parse(process.cwd()).root, // C:\ 或 /
    home,
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    path.join(home, "AppData"),
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".config"),
    "/System",
    "/Windows",
    "C:\\Windows",
  ];
  return roots.map((r) => path.resolve(r).toLowerCase());
}

export interface SandboxResult {
  ok: boolean;
  /** 解析后的绝对路径（ok 为 true 时有效）。 */
  resolved: string;
  /** 拒绝原因（ok 为 false 时有效）。 */
  reason: string;
}

export interface SandboxOptions {
  /** Full-access mode deliberately removes the app-level workspace boundary. */
  allowOutsideWorkspace?: boolean;
}

/**
 * 校验目标路径是否落在 workspace 内。
 *
 * 关键点：必须先 resolve 再比较，否则 "../../.." 这类穿越能绕过前缀判断。
 * 还要额外加分隔符比较，避免 /work 匹配到 /workspace-evil 这种同前缀目录。
 */
export function resolveInWorkspace(
  workspace: string,
  target: string,
  options: SandboxOptions = {},
): SandboxResult {
  if (typeof target !== "string" || !target.trim()) {
    return { ok: false, resolved: "", reason: "路径不能为空" };
  }

  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);

  if (options.allowOutsideWorkspace) {
    return { ok: true, resolved, reason: "" };
  }

  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const resCmp =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;

  if (resCmp !== rootCmp && !resCmp.startsWith(rootCmp + path.sep)) {
    return {
      ok: false,
      resolved: "",
      reason: `路径越出工作目录：${resolved}（工作目录 ${root}）`,
    };
  }

  if (isSensitivePath(resolved)) {
    return {
      ok: false,
      resolved: "",
      reason: "出于安全原因，禁止读取或修改凭证、环境变量和私钥文件",
    };
  }

  for (const bad of forbiddenRoots()) {
    if (resCmp === bad) {
      return {
        ok: false,
        resolved: "",
        reason: `禁止直接操作受保护目录：${resolved}`,
      };
    }
  }

  return { ok: true, resolved, reason: "" };
}

/**
 * 命令白名单：这些只读命令可以自动执行，无需用户确认。
 * 只匹配命令名本身，参数另做危险模式检查。
 */
const SAFE_COMMANDS = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "echo",
  "grep", "rg", "find", "which", "file", "stat",
  "git", "node", "npm", "pnpm", "yarn", "tsc",
  "python", "python3", "pip", "date", "whoami", "env",
]);

/** git 里也有危险子命令，单独挡掉。 */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "push", "reset", "clean", "rebase", "filter-branch", "commit", "merge",
]);

/**
 * 明确的破坏性模式，命中即拒绝执行（连确认都不给）。
 */
const HARD_BLOCKED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /(?:^|[;&|])\s*(?:cd|pushd|set-location)\s+(?:\.\.|[A-Za-z]:[\\/]|[\\/])/i, why: "命令试图离开工作区" },
  { re: /(?:^|[\s"'=])\.\.[\\/]/, why: "命令包含工作区路径穿越" },
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/(?:\s|$)/i, why: "递归删除根目录" },
  { re: /\brm\s+-[a-z]*[rf]/i, why: "递归/强制删除" },
  { re: /\bdel\s+\/[sq]/i, why: "Windows 递归删除" },
  { re: /\bformat\s+[a-z]:/i, why: "格式化磁盘" },
  { re: /\bmkfs\b/i, why: "格式化文件系统" },
  { re: /\bdd\s+.*of=\/dev\//i, why: "直接写块设备" },
  { re: />\s*\/dev\/[sh]d[a-z]/i, why: "覆写磁盘设备" },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: "fork 炸弹" },
  { re: /\bshutdown\b|\breboot\b/i, why: "关机/重启" },
  { re: /\bchmod\s+-R\s+777\s+\//i, why: "递归改根目录权限" },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh|\bcurl\b[^|]*\|\s*(?:powershell|pwsh)/i, why: "下载并直接执行脚本" },
  { re: /\bwget\b[^|]*\|\s*(ba)?sh|\bwget\b[^|]*\|\s*(?:powershell|pwsh)/i, why: "下载并直接执行脚本" },
  { re: /\bsudo\b/i, why: "提权执行" },
  { re: /\b(?:reg|reg\.exe)\s+(?:add|delete|import|load|save)\b/i, why: "修改 Windows 注册表" },
  { re: /\b(?:runas)\b|\b(?:powershell|pwsh)\b[^\n]*\b(?:-verb\s+runas|start-process)\b/i, why: "管理员权限执行" },
  { re: /\bReg(istry)?\s+(delete|add)\b/i, why: "修改注册表" },
];

const SENSITIVE_COMMAND_PATTERN = /(?:^|[\s\\/"'=])(?:\.env(?:\.(?!example\b)[^\s\\/"'=]*)?|\.ssh|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|[^\s\\/"'=]+\.(?:pem|key|p12|pfx))(?=$|[\s\\/"'=])/i;

export type CommandVerdict =
  | { action: "allow"; reason: "" }
  | { action: "confirm"; reason: string }
  | { action: "block"; reason: string };

/**
 * 判定一条 shell 命令的处置方式。
 *
 * 默认策略：白名单只读命令直接放行；明确破坏性的一律阻断；其余交给用户确认。
 * 完全访问策略会由调用方显式传入 allowUnsafe，跳过这些应用层护栏。
 */
export interface CommandOptions {
  /** Full-access mode deliberately removes the app-level command guardrails. */
  allowUnsafe?: boolean;
}

export function judgeCommand(cmd: string, options: CommandOptions = {}): CommandVerdict {
  const trimmed = cmd.trim();
  if (!trimmed) return { action: "block", reason: "空命令" };

  if (options.allowUnsafe) return { action: "allow", reason: "" };

  for (const { re, why } of HARD_BLOCKED_PATTERNS) {
    if (re.test(trimmed)) {
      return { action: "block", reason: `命中高危模式（${why}）` };
    }
  }

  if (SENSITIVE_COMMAND_PATTERN.test(trimmed)) {
    return { action: "block", reason: "命令涉及凭证、环境变量或私钥文件" };
  }

  // 含管道、重定向、命令串联时，无法简单判定，一律走确认
  if (/[;&|>]|\$\(|`/.test(trimmed)) {
    return { action: "confirm", reason: "包含管道、重定向或命令串联" };
  }

  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  const base = path.basename(first).replace(/\.(exe|cmd|bat)$/i, "");

  if (base === "git") {
    const sub = trimmed.split(/\s+/)[1]?.toLowerCase() ?? "";
    if (DANGEROUS_GIT_SUBCOMMANDS.has(sub)) {
      return { action: "confirm", reason: `git ${sub} 会改变仓库状态` };
    }
    return { action: "allow", reason: "" };
  }

  if (/^(?:npm|pnpm|yarn|pip)(?:\.exe)?\s+(?:install|add|remove|uninstall|update|upgrade|publish)\b/i.test(trimmed)) {
    return { action: "confirm", reason: "安装、移除或发布依赖会改变工作区或外部环境" };
  }

  if (SAFE_COMMANDS.has(base)) {
    return { action: "allow", reason: "" };
  }

  return { action: "confirm", reason: `命令 "${base}" 不在只读白名单内` };
}

function isSensitivePath(value: string): boolean {
  const segments = value.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment) =>
    segment === ".env" ||
    (segment.startsWith(".env.") && segment !== ".env.example") ||
    segment === ".ssh" ||
    /^(id_(rsa|dsa|ecdsa|ed25519)|authorized_keys)$/.test(segment) ||
    /\.(pem|key|p12|pfx)$/.test(segment),
  );
}

/** 截断工具结果，避免污染上下文且不可回收。 */
export function truncateResult(
  text: string,
  max = MAX_TOOL_RESULT_CHARS,
): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return (
    text.slice(0, max) +
    `\n\n…[已截断 ${omitted} 字符。如需查看剩余内容，请指定更精确的范围或过滤条件]`
  );
}
