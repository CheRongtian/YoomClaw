#!/usr/bin/env node

/**
 * Launch an isolated Chrome profile and run the UI-only Jimo history RPA.
 * Authentication is intentionally manual: this script never accepts or reads
 * passwords, cookies, tokens, localStorage, or the user's production profile.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const AUTOMATION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(AUTOMATION_DIR, "..");
const configuredRpa = process.env.YOOMCLAW_RPA_SCRIPT?.trim();
const DEFAULT_RPA = configuredRpa ? path.resolve(configuredRpa) : path.join(AUTOMATION_DIR, "collect-jimo-history-rpa.mjs");

function parseArgs(argv) {
  const args = {
    startChrome: false,
    cdp: "http://127.0.0.1:9222",
    url: "https://jimoai.xiaohuodui.cn/robot",
    rpaScript: DEFAULT_RPA,
    output: path.join(ROOT, ".tmp", "yoomclaw-e2e", "jimo-history-rpa.json"),
    maxRecords: 50,
    robotKeyword: "",
    profile: "",
    liveReport: "",
    waitForLogin: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      console.log("Usage: pnpm test:e2e:chrome-history -- [--start-chrome] [--wait-for-login] [--cdp <url>] [--rpa-script <file>] [--output <file>] [--live-report <summary.json>]");
      process.exit(0);
    }
    if (current === "--start-chrome") args.startChrome = true;
    else if (current === "--wait-for-login") args.waitForLogin = true;
    else {
      const [name, inline] = current.split("=", 2);
      const value = inline ?? argv[++i];
      if (!value) throw new Error(`Missing value for ${name}`);
      if (name === "--cdp") args.cdp = value;
      else if (name === "--url") args.url = value;
      else if (name === "--rpa-script") args.rpaScript = path.resolve(value);
      else if (name === "--output") args.output = path.resolve(value);
      else if (name === "--profile") args.profile = path.resolve(value);
      else if (name === "--live-report") args.liveReport = path.resolve(value);
      else if (name === "--max-records") args.maxRecords = Number.parseInt(value, 10);
      else if (name === "--robot-keyword" || name === "--keyword") args.robotKeyword = value;
      else throw new Error(`Unknown option: ${current}`);
    }
  }
  if (!Number.isInteger(args.maxRecords) || args.maxRecords < 1) throw new Error("--max-records must be a positive integer");
  return args;
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.platform === "darwin" ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ] : []),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return Boolean(candidate && fsSync.existsSync(candidate));
    } catch {
      return false;
    }
  });
}

async function waitForCdp(cdp, timeoutMs = 60_000) {
  const endpoint = `${cdp.replace(/\/$/, "")}/json/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome CDP 未就绪：${cdp}`);
}

function runNode(script, args, outputLines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_PATH: path.join(ROOT, "packages", "agent-core", "node_modules") },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk) => {
      outputLines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      while (outputLines.length > 100) outputLines.shift();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportDir = path.dirname(args.output);
  await fs.mkdir(reportDir, { recursive: true });
  const profile = args.profile || await fs.mkdtemp(path.join(os.tmpdir(), "yoomclaw-chrome-e2e-"));
  const logs = [];
  let chrome = null;
  const report = {
    startedAt: new Date().toISOString(),
    cdp: args.cdp,
    url: args.url,
    profile,
    rpaScript: args.rpaScript,
    output: args.output,
    waitForLogin: args.waitForLogin,
    status: "blocked",
    authentication: "manual",
    logs,
  };
  try {
    await fs.access(args.rpaScript);
    if (args.startChrome) {
      const executable = chromeExecutable();
      if (!executable) throw new Error("找不到 Chrome。请设置 CHROME_PATH 或安装 Google Chrome。");
      chrome = spawn(executable, [
        `--remote-debugging-port=${new URL(args.cdp).port || 9222}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        args.url,
      ], { stdio: "ignore", windowsHide: false });
      report.chromePid = chrome.pid;
    }
    await waitForCdp(args.cdp);
    if (args.waitForLogin) {
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await prompt.question("Chrome 已启动。请在隔离配置文件中完成 Jimo 后台登录，确认页面可见后按 Enter 继续 RPA：");
      } finally {
        prompt.close();
      }
    }
    const rpaArgs = ["--cdp", args.cdp, "--url", args.url, "--output", args.output, "--max-records", String(args.maxRecords)];
    if (args.robotKeyword) rpaArgs.push("--robot-keyword", args.robotKeyword);
    await runNode(args.rpaScript, rpaArgs, logs);
    const history = JSON.parse(await fs.readFile(args.output, "utf8"));
    let crossCheck = null;
    if (args.liveReport) {
      const live = JSON.parse(await fs.readFile(args.liveReport, "utf8"));
      const marker = typeof live.testMarker === "string" ? live.testMarker : "";
      const expectedFiles = [
        ...(Array.isArray(live.expectations?.fileNames) ? live.expectations.fileNames : []),
        ...(Array.isArray(live.cases) ? live.cases.flatMap((item) => Array.isArray(item.files) ? item.files : []) : []),
      ].map((value) => String(value).split(/[\\/]/).pop()).filter(Boolean);
      const textOf = (record) => [record?.row?.rowText, record?.row?.processName, record?.row?.source, record?.detail?.text]
        .filter((value) => typeof value === "string").join("\n");
      const records = Array.isArray(history.records) ? history.records : [];
      const markerFound = marker.length > 0 && records.some((record) => textOf(record).includes(marker));
      const fileFound = expectedFiles.length === 0 || expectedFiles.some((fileName) => records.some((record) => textOf(record).includes(fileName)));
      crossCheck = { markerFound, fileFound, expectedFiles };
    }
    report.history = {
      mode: history.mode,
      detailsCollected: history.detailsCollected === true,
      totalRecords: Array.isArray(history.records) ? history.records.length : 0,
      errors: Array.isArray(history.errors) ? history.errors.length : 0,
    };
    report.crossCheck = crossCheck;
    report.status = report.history.mode === "ui-rpa" && report.history.detailsCollected && report.history.errors === 0
      && (!crossCheck || (crossCheck.markerFound && crossCheck.fileFound))
      ? "passed"
      : "failed";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.status = /登录|认证|CDP|找不到 Chrome|timeout|超时/i.test(report.error) ? "blocked" : "failed";
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(reportDir, "chrome-history-run.json"), JSON.stringify(report, null, 2), "utf8");
    // Do not kill Chrome. The isolated profile can remain open for manual login
    // and the RPA process intentionally leaves the attached browser untouched.
    void chrome;
  }
  console.log(JSON.stringify({ status: report.status, output: args.output, report: path.join(reportDir, "chrome-history-run.json") }));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
