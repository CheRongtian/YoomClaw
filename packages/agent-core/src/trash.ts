import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TRASH_OPERATION_TIMEOUT_MS = 15_000;

const WINDOWS_TRASH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "$target = $env:YOOMCLAW_TRASH_TARGET",
  "if (-not $target) { throw 'Missing trash target' }",
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
].join("; ");

const MAC_TRASH_SCRIPT = [
  "on run argv",
  "  if (count of argv) is not 1 then error \"Missing trash target\"",
  "  tell application \"Finder\" to delete POSIX file (item 1 of argv)",
  "end run",
].join("\n");

/** Move a file to the operating system's trash without a permanent-delete fallback. */
export async function moveToTrash(filePath: string): Promise<void> {
  switch (process.platform) {
    case "win32":
      await moveToWindowsRecycleBin(filePath);
      return;
    case "darwin":
      await moveToMacTrash(filePath);
      return;
    case "linux":
      await moveToLinuxTrash(filePath);
      return;
    default:
      throw new Error(`当前操作系统不支持回收站操作：${process.platform}`);
  }
}

async function moveToWindowsRecycleBin(filePath: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const powershell = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  try {
    await execFileAsync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_TRASH_SCRIPT,
      ],
      {
        env: { ...process.env, YOOMCLAW_TRASH_TARGET: filePath },
        windowsHide: true,
        timeout: TRASH_OPERATION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    throw new Error(`移到 Windows 回收站失败：${errorMessage(error)}`);
  }
}

async function moveToMacTrash(filePath: string): Promise<void> {
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", MAC_TRASH_SCRIPT, filePath],
      { timeout: TRASH_OPERATION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    throw new Error(`移到 macOS 废纸篓失败：${errorMessage(error)}`);
  }
}

async function moveToLinuxTrash(filePath: string): Promise<void> {
  try {
    await execFileAsync(
      "gio",
      ["trash", filePath],
      { timeout: TRASH_OPERATION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    return;
  } catch (error) {
    if (!isCommandNotFound(error)) {
      throw new Error(`移到 Linux 回收站失败：${errorMessage(error)}`);
    }
  }

  await moveToFreedesktopTrash(filePath);
}

async function moveToFreedesktopTrash(filePath: string): Promise<void> {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
    || path.join(os.homedir(), ".local", "share");
  const trashRoot = path.join(dataHome, "Trash");
  const filesDir = path.join(trashRoot, "files");
  const infoDir = path.join(trashRoot, "info");
  await fs.mkdir(filesDir, { recursive: true });
  await fs.mkdir(infoDir, { recursive: true });

  const name = await uniqueTrashName(filesDir, path.basename(filePath));
  const trashedPath = path.join(filesDir, name);
  const infoPath = path.join(infoDir, `${name}.trashinfo`);

  try {
    await fs.rename(filePath, trashedPath);
  } catch (error) {
    throw new Error(`移到 Linux 回收站失败：${errorMessage(error)}`);
  }

  const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const info = [
    "[Trash Info]",
    `Path=${encodeURIComponent(path.resolve(filePath))}`,
    `DeletionDate=${deletionDate}`,
    "",
  ].join("\n");
  try {
    await fs.writeFile(infoPath, info, "utf8");
  } catch (error) {
    // Keep the operation recoverable even if the metadata write fails.
    await fs.rename(trashedPath, filePath).catch(() => {});
    throw new Error(`写入 Linux 回收站信息失败：${errorMessage(error)}`);
  }
}

async function uniqueTrashName(filesDir: string, originalName: string): Promise<string> {
  const extension = path.extname(originalName);
  const stem = extension ? originalName.slice(0, -extension.length) : originalName;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0
      ? originalName
      : `${stem} (${index})${extension}`;
    try {
      await fs.access(path.join(filesDir, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  return `${stem} (${randomUUID()})${extension}`;
}

function isCommandNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { stderr?: unknown; message?: unknown };
    if (typeof value.stderr === "string" && value.stderr.trim()) return value.stderr.trim();
    if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  }
  return String(error);
}
