#!/usr/bin/env node

/**
 * Read-only collector for JimoAI platform conversation history.
 *
 * Run with a separate credentials file, for example:
 *   node --env-file=.env.admin web-automation/collect-jimo-history.mjs --output jimo-history.json
 *
 * Required environment variables:
 *   JIMO_ADMIN_TOKEN  - the platform login token, not the share/API token
 *   JIMO_ADMIN_ID     - the platform userId
 *
 * Optional filters mirror the platform's conversation-record page:
 *   JIMO_PROCESS_ID, JIMO_SOURCE, JIMO_KEYWORD, JIMO_START_AT,
 *   JIMO_END_AT, JIMO_FEEDBACK (true/false)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://jimoai-bot-api.xiaohuodui.cn";
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_DETAIL_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 5;

function printHelp() {
  console.log(`Usage:
  node --env-file=.env.admin web-automation/collect-jimo-history.mjs [options]

Options:
  --output <path>          Output JSON path (default: jimo-history-<timestamp>.json)
  --process-id <id>        Limit to one robot/process
  --source <source>        e.g. api, web, platform, robot
  --keyword <text>         Search conversation content
  --start-at <timestamp>   Start timestamp in milliseconds
  --end-at <timestamp>     End timestamp in milliseconds
  --feedback <true|false>  Filter by answer-quality mark
  --session-id <id>        Fetch one known session directly
  --page-size <n>          Session-list page size (default: ${DEFAULT_PAGE_SIZE})
  --detail-page-size <n>   History page size (default: ${DEFAULT_DETAIL_PAGE_SIZE})
  --concurrency <n>        Concurrent detail requests (default: ${DEFAULT_CONCURRENCY})
  --list-only              Collect the session list without message details
  --help                   Show this help

The script only performs GET requests to the platform's list/history endpoints.
`);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help") {
      flags.add("help");
      continue;
    }
    if (token === "--list-only") {
      flags.add("list-only");
      continue;
    }
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals !== -1) {
      values.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    values.set(token.slice(2), argv[i + 1] ?? "");
    i += 1;
  }
  return { values, flags };
}

function getOption(args, name, fallback = undefined) {
  return args.values.has(name) ? args.values.get(name) : fallback;
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return parsed;
}

function setIfPresent(params, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    params.set(key, String(value));
  }
}

function normalizeResponse(payload) {
  const body = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return {
    list: Array.isArray(body?.list) ? body.list : [],
    total: Number.isFinite(Number(body?.total)) ? Number(body.total) : undefined,
    raw: body,
  };
}

async function requestJson(baseUrl, token, path, params) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: token,
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${path} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchAllPages({ baseUrl, token, path, baseParams, pageSize }) {
  const all = [];
  let total;
  for (let offset = 0; ; ) {
    const payload = await requestJson(baseUrl, token, path, {
      ...baseParams,
      offset,
      limit: pageSize,
    });
    const page = normalizeResponse(payload);
    total = page.total ?? total;
    if (page.list.length === 0) break;
    all.push(...page.list);
    offset += page.list.length;
    if ((total !== undefined && offset >= total) || page.list.length < pageSize) break;
  }
  return { list: all, total: total ?? all.length };
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, consume));
  return output;
}

function buildFilters(args) {
  const filters = {
    processId: getOption(args, "process-id", process.env.JIMO_PROCESS_ID),
    source: getOption(args, "source", process.env.JIMO_SOURCE),
    keyword: getOption(args, "keyword", process.env.JIMO_KEYWORD),
    startAt: getOption(args, "start-at", process.env.JIMO_START_AT),
    endAt: getOption(args, "end-at", process.env.JIMO_END_AT),
  };
  const feedback = getOption(args, "feedback", process.env.JIMO_FEEDBACK);
  if (feedback !== undefined && feedback !== "") {
    if (feedback !== "true" && feedback !== "false") {
      throw new Error(`Invalid --feedback: ${feedback}; use true or false`);
    }
    filters.feedback = feedback === "true";
  }
  return filters;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) {
    printHelp();
    return;
  }

  const token = process.env.JIMO_ADMIN_TOKEN?.trim();
  const adminId = process.env.JIMO_ADMIN_ID?.trim();
  if (!token || !adminId) {
    throw new Error(
      "Missing JIMO_ADMIN_TOKEN or JIMO_ADMIN_ID. Keep the platform login token separate from JIMO_AUTHORIZATION.",
    );
  }

  const baseUrl = process.env.JIMO_ADMIN_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const pageSize = positiveInt(getOption(args, "page-size"), DEFAULT_PAGE_SIZE, "page-size");
  const detailPageSize = positiveInt(
    getOption(args, "detail-page-size"),
    DEFAULT_DETAIL_PAGE_SIZE,
    "detail-page-size",
  );
  const concurrency = positiveInt(
    getOption(args, "concurrency"),
    DEFAULT_CONCURRENCY,
    "concurrency",
  );
  const filters = buildFilters(args);
  const sessionId = getOption(args, "session-id", process.env.JIMO_SESSION_ID);

  let sessions;
  if (sessionId) {
    sessions = { list: [{ sessionId }], total: 1 };
  } else {
    sessions = await fetchAllPages({
      baseUrl,
      token,
      path: "/v1/completions/sessions/list",
      baseParams: { adminId, ...filters },
      pageSize,
    });
  }

  console.log(`Found ${sessions.list.length} session record(s).`);
  const errors = [];
  const records = args.flags.has("list-only")
    ? sessions.list.map((session) => ({ session, messages: null }))
    : await mapConcurrent(sessions.list, concurrency, async (session, index) => {
        try {
          const histories = await fetchAllPages({
            baseUrl,
            token,
            path: "/v1/completions/histories",
            baseParams: { sessionId: session.sessionId, adminId },
            pageSize: detailPageSize,
          });
          return {
            session,
            messages: histories.list.slice().reverse(),
            messageCount: histories.list.length,
            reportedMessageCount: histories.total,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ sessionId: session.sessionId, error: message });
          return { session, messages: null, error: message };
        } finally {
          console.log(`Fetched ${index + 1}/${sessions.list.length}`);
        }
      });

  const output = getOption(
    args,
    "output",
    `jimo-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        baseUrl,
        filters,
        totalSessions: sessions.total,
        records,
        errors,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`Wrote ${outputPath}`);
  if (errors.length > 0) console.warn(`Completed with ${errors.length} detail error(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
