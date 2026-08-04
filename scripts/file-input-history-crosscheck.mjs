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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RPA_SCRIPT = "C:\\Users\\12992\\Desktop\\work\\code\\web-automation\\scripts\\collect-jimo-history-rpa.mjs";
const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_MAX_RECORDS = 20;
const TEST_MARKER = "File-input regression test";

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
  await fs.access(args.rpaScript);
  const rpaOutput = rpaOutputPath(args.output);
  await runRpa({
    script: args.rpaScript,
    cdp: args.cdp,
    output: rpaOutput,
    maxRecords: args.maxRecords,
    robotKeyword: args.robotKeyword,
  });

  const history = await readJson(rpaOutput);
  const records = Array.isArray(history.records) ? history.records : [];
  const markerRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => recordText(record).includes(TEST_MARKER));
  const selectedFileNames = [...new Set(
    (Array.isArray(live.cases) ? live.cases : [])
      .flatMap((item) => Array.isArray(item.files) ? item.files.map(basename) : []),
  )].filter(Boolean);
  const filenameRecords = records
    .map((record, index) => ({ record, index, text: recordText(record) }))
    .filter(({ text }) => selectedFileNames.some((fileName) => text.includes(fileName)));
  const report = {
    generatedAt: new Date().toISOString(),
    liveReport: args.liveReport,
    rpaOutput,
    testMarker: TEST_MARKER,
    live: {
      counts: live.counts ?? null,
      sessionIds: (Array.isArray(live.cases) ? live.cases : [])
        .map((item) => item?.details?.sessionId)
        .filter((value) => typeof value === "string"),
      selectedFileNames,
    },
    history: {
      collectedAt: history.collectedAt ?? null,
      totalRecords: records.length,
      detailErrors: Array.isArray(history.errors) ? history.errors.length : 0,
      markerRecordIndexes: markerRecords.map(({ index }) => index),
      filenameRecordIndexes: filenameRecords.map(({ index }) => index),
    },
    crossCheck: {
      rpaCompleted: true,
      testMarkerFound: markerRecords.length > 0,
      selectedFilenameFound: filenameRecords.length > 0,
    },
  };
  await fs.writeFile(args.output, JSON.stringify(report, null, 2), "utf8");
  console.log(`History cross-check report: ${args.output}`);
  console.log(JSON.stringify(report.crossCheck));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
