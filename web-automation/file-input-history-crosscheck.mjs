#!/usr/bin/env node

/**
 * Run the user-provided UI-only Jimo history RPA after a live file-input run
 * and write a small, non-secret cross-check report next to the live report.
 *
 * The RPA script is intentionally kept outside this repository and is never
 * edited here. It needs an already logged-in Chrome with CDP enabled.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const AUTOMATION_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(AUTOMATION_DIR, "..");
const configuredRpa = process.env.YOOMCLAW_RPA_SCRIPT?.trim();
const DEFAULT_RPA_SCRIPT = configuredRpa ? path.resolve(configuredRpa) : path.join(AUTOMATION_DIR, "collect-jimo-history-rpa.mjs");
const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_TEST_MARKER = "File-input regression test";

function parseArgs(argv) {
  const args = {
    liveReport: "",
    rpaScript: DEFAULT_RPA_SCRIPT,
    cdp: DEFAULT_CDP,
    output: "",
    maxRecords: DEFAULT_MAX_RECORDS,
    robotKeyword: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      console.log(`
Usage:
  pnpm test:file-inputs:history -- --live-report <summary.json> [options]

Options:
  --live-report <file>  Live file-input summary.json (required)
  --rpa-script <file>   UI-only RPA script path
  --cdp <url>           Logged-in Chrome CDP URL (default: ${DEFAULT_CDP})
  --output <file>       Cross-check report path
  --max-records <n>     RPA record limit (default: ${DEFAULT_MAX_RECORDS})
  --robot-keyword <s>   Optional robot selector keyword
`);
      process.exit(0);
    }
    const [name, inline] = current.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--live-report") args.liveReport = value;
    else if (name === "--rpa-script") args.rpaScript = value;
    else if (name === "--cdp") args.cdp = value;
    else if (name === "--output") args.output = value;
    else if (name === "--max-records") args.maxRecords = parseNonNegativeInt(value, name);
    else if (name === "--robot-keyword" || name === "--keyword") args.robotKeyword = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!args.liveReport) throw new Error("--live-report is required");
  args.liveReport = path.resolve(args.liveReport);
  args.rpaScript = path.resolve(args.rpaScript);
  args.output = path.resolve(args.output || path.join(path.dirname(args.liveReport), "jimo-history-crosscheck.json"));
  return args;
}

function parseNonNegativeInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function basename(value) {
  return String(value ?? "").split(/[\\/]/).pop() ?? "";
}

function recordText(record) {
  return [
    record?.row?.rowText,
    record?.row?.processName,
    record?.row?.source,
    record?.detail?.text,
  ].filter((value) => typeof value === "string").join("\n");
}

function rpaOutputPath(crossCheckOutput) {
  return crossCheckOutput.replace(/\.json$/i, "") + ".rpa.json";
}

function runRpa({ script, cdp, output, maxRecords, robotKeyword }) {
  const nodePath = path.join(REPO_ROOT, "packages", "agent-core", "node_modules");
  const args = [script, "--cdp", cdp, "--max-records", String(maxRecords), "--output", output];
  if (robotKeyword) args.push("--robot-keyword", robotKeyword);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_PATH: nodePath },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`RPA exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const live = await readJson(args.liveReport);
  const reportMarker = live.testMarker ?? live.result?.testMarker;
  const testMarker = typeof reportMarker === "string" && reportMarker.trim()
    ? reportMarker.trim()
    : DEFAULT_TEST_MARKER;
  const expectations = live.expectations && typeof live.expectations === "object" ? live.expectations : {};
  const rpaOutput = rpaOutputPath(args.output);
  let history;
  try {
    await fs.access(args.rpaScript);
    await runRpa({
      script: args.rpaScript,
      cdp: args.cdp,
      output: rpaOutput,
      maxRecords: args.maxRecords,
      robotKeyword: args.robotKeyword,
    });
    history = await readJson(rpaOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /CDP|登录|认证|Chrome|timeout|超时|not found|找不到/i.test(message) ? "blocked" : "failed";
    const report = {
      generatedAt: new Date().toISOString(),
      status,
      liveReport: args.liveReport,
      rpaOutput,
      testMarker,
      crossCheck: {
        rpaCompleted: false,
        detailsCollected: false,
        detailErrors: 0,
        unicodeClean: false,
      },
      error: message,
    };
    await fs.writeFile(args.output, JSON.stringify(report, null, 2), "utf8");
    console.log(`History cross-check report: ${args.output}`);
    console.log(JSON.stringify(report.crossCheck));
    process.exitCode = 1;
    return;
  }

  const records = Array.isArray(history.records) ? history.records : [];
  const markerRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => recordText(record).includes(testMarker));
  const selectedFileNames = [...new Set(
    [
      ...(Array.isArray(live.cases) ? live.cases.flatMap((item) => Array.isArray(item.files) ? item.files.map(basename) : []) : []),
      ...(live.inputFile?.fileName ? [live.inputFile.fileName] : []),
      ...(live.result?.inputFile?.fileName ? [live.result.inputFile.fileName] : []),
    ],
  )].filter(Boolean);
  const expectedFileNames = [...new Set([
    ...selectedFileNames,
    ...(Array.isArray(expectations.fileNames) ? expectations.fileNames.map(basename) : []),
  ])].filter(Boolean);
  const filenameRecords = records
    .map((record, index) => ({ record, index, text: recordText(record) }))
    .filter(({ text }) => expectedFileNames.some((fileName) => text.includes(fileName)));
  const markerTexts = markerRecords.map(({ record }) => recordText(record));
  const expectedTools = Array.isArray(expectations.toolNames) ? expectations.toolNames.filter((value) => typeof value === "string" && value.trim()) : [];
  const toolMatches = expectedTools.map((tool) => ({
    tool,
    found: records.some((record) => recordText(record).toLowerCase().includes(tool.toLowerCase())),
  }));
  const detailTextFound = markerRecords.some(({ record }) => typeof record?.detail?.text === "string" && record.detail.text.trim().length > 0);
  const markerDetailRecords = markerRecords.filter(({ record }) => typeof record?.detail?.text === "string" && record.detail.text.includes(testMarker));
  const markerDetailTexts = markerDetailRecords.map(({ record }) => record.detail.text);
  const markerDetailFileFound = expectedFileNames.length === 0
    || markerDetailTexts.some((text) => expectedFileNames.some((fileName) => text.includes(fileName)));
  const markerDetailToolMatches = expectedTools.map((tool) => ({
    tool,
    found: markerDetailTexts.some((text) => text.toLowerCase().includes(tool.toLowerCase())),
  }));
  const replacementCharCount = (text) => [...String(text ?? "")].filter((character) => character.codePointAt(0) === 0xFFFD).length;
  const allReplacementChars = records.reduce((count, record) => count + replacementCharCount(recordText(record)), 0);
  const markerDetailReplacementChars = markerDetailTexts.reduce((count, text) => count + replacementCharCount(text), 0);
  const markerDetailUnicodeClean = markerDetailReplacementChars === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    status: "failed",
    liveReport: args.liveReport,
    rpaOutput,
    testMarker,
    live: {
      counts: live.counts ?? null,
      sessionIds: (Array.isArray(live.cases) ? live.cases : [])
        .map((item) => item?.details?.sessionId ?? item?.detail?.sessionId)
        .filter((value) => typeof value === "string"),
      selectedFileNames: expectedFileNames,
      expectations,
    },
    history: {
      collectedAt: history.collectedAt ?? null,
      totalRecords: records.length,
      detailErrors: Array.isArray(history.errors) ? history.errors.length : 0,
      markerRecordIndexes: markerRecords.map(({ index }) => index),
      filenameRecordIndexes: filenameRecords.map(({ index }) => index),
      detailTextFound,
      markerTextLengths: markerTexts.map((text) => text.length),
      markerDetailIndexes: markerDetailRecords.map(({ index }) => index),
      markerDetailTextLengths: markerDetailTexts.map((text) => text.length),
      replacementCharCount: allReplacementChars,
      markerDetailReplacementCharCount: markerDetailReplacementChars,
      toolMatches,
      markerDetailToolMatches,
    },
    crossCheck: {
      rpaCompleted: true,
      testMarkerFound: markerRecords.length > 0,
      selectedFilenameFound: filenameRecords.length > 0,
      sessionTitleFound: typeof expectations.sessionTitleContains !== "string"
        || !expectations.sessionTitleContains
        || records.some((record) => recordText(record).includes(expectations.sessionTitleContains)),
      userMessageFound: typeof expectations.userMessageContains !== "string"
        || !expectations.userMessageContains
        || records.some((record) => recordText(record).includes(expectations.userMessageContains)),
      agentReplyFound: detailTextFound,
      expectedToolsFound: toolMatches.every((item) => item.found),
      markerDetailFound: markerDetailRecords.length > 0,
      markerDetailFileFound,
      markerDetailToolsFound: markerDetailToolMatches.every((item) => item.found),
      detailsCollected: history.detailsCollected === true,
      detailErrors: Array.isArray(history.errors) ? history.errors.length : 0,
      unicodeClean: markerDetailUnicodeClean,
      markerDetailUnicodeClean,
    },
  };
  const passed = report.crossCheck.rpaCompleted
    && report.crossCheck.detailsCollected
    && report.crossCheck.detailErrors === 0
    && report.crossCheck.unicodeClean
    && report.crossCheck.sessionTitleFound
    && report.crossCheck.userMessageFound
    && report.crossCheck.agentReplyFound
    && report.crossCheck.expectedToolsFound
    && report.crossCheck.markerDetailFound
    && report.crossCheck.markerDetailFileFound
    && report.crossCheck.markerDetailToolsFound
    && (report.crossCheck.testMarkerFound || report.crossCheck.selectedFilenameFound);
  report.status = passed ? "passed" : "failed";
  await fs.writeFile(args.output, JSON.stringify(report, null, 2), "utf8");
  console.log(`History cross-check report: ${args.output}`);
  console.log(JSON.stringify(report.crossCheck));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
