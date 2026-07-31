/**
 * 运行日志：把每轮对话的工具调用 / 决策 / 结果 / 错误按时间顺序追加到
 * `.claw-data/run.log`（与会话持久化同目录）。文件可被 read_file/grep 工具回看，
 * 也方便用户排查。INFO 仅落盘，WARN/ERROR 同时打到 stderr。
 */

import fs from "node:fs";
import path from "node:path";

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

/** 把工具参数安全序列化进日志：字符串过长截断，避免把整个文件内容写进日志。 */
function formatArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args, (_k, v) =>
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v,
    );
    return truncate(json ?? "", 240);
  } catch {
    return "[unserializable]";
  }
}

export class RunLogger {
  readonly filePath: string;
  private stream: fs.WriteStream | null = null;

  constructor(dir: string) {
    this.filePath = path.join(dir, "run.log");
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
      this.stream.on("error", () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  private write(level: string, scope: string, detail: string): void {
    const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${detail}\n`;
    if (level === "WARN" || level === "ERROR") process.stderr.write(line);
    this.stream?.write(line);
  }

  info(scope: string, detail: string): void {
    this.write("INFO", scope, detail);
  }
  warn(scope: string, detail: string): void {
    this.write("WARN", scope, detail);
  }
  error(scope: string, detail: string): void {
    this.write("ERROR", scope, detail);
  }
}

export { truncate, formatArgs };
