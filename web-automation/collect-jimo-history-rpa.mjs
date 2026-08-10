#!/usr/bin/env node

/**
 * Collect Jimo conversation history through the already logged-in page UI.
 *
 * This is intentionally a UI-RPA collector:
 * - it does not call Jimo's backend endpoints;
 * - it does not read cookies, localStorage, or authentication tokens;
 * - it only navigates, clicks, scrolls, and reads visible DOM content.
 *
 * The Chrome instance must be started with --remote-debugging-port (default 9222)
 * and already have an authenticated Jimo tab open.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO_ROOT, "packages", "agent-core", "package.json"));
const { chromium } = require("playwright-core");

const DEFAULT_URL = "https://jimoai.xiaohuodui.cn/robot";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_OUTPUT = path.join(REPO_ROOT, ".claw-data", "jimo-history-rpa.json");

function usage() {
  console.log(`
Usage:
  node web-automation/collect-jimo-history-rpa.mjs [options]

Options:
  --cdp <url>          Chrome CDP URL (default: ${DEFAULT_CDP_URL})
  --url <url>          Jimo page URL (default: ${DEFAULT_URL})
  --output <file>      JSON output path (default: ${DEFAULT_OUTPUT})
  --max-pages <n>      Stop after n table pages; 0 means all pages (default: 0)
  --max-records <n>    Stop after n records; 0 means all records (default: 20)
  --robot-keyword <s>  Filter robot selector by name keyword; e.g. agent
  --no-details         Collect table rows but skip opening each detail panel
  --help               Show this help

Example:
  node web-automation/collect-jimo-history-rpa.mjs --robot-keyword agent --max-records 20
`);
}

function parseArgs(argv) {
  const args = {
    cdp: DEFAULT_CDP_URL,
    url: DEFAULT_URL,
    output: DEFAULT_OUTPUT,
    maxPages: 0,
    maxRecords: 20,
    robotKeyword: "",
    details: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--no-details") {
      args.details = false;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    const needsValue = new Set([
      "--cdp",
      "--url",
      "--output",
      "--max-pages",
      "--max-records",
      "--robot-keyword",
      "--keyword",
    ]);
    if (!needsValue.has(name)) throw new Error(`Unknown option: ${arg}`);
    const value = inlineValue ?? argv[++i];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--cdp") args.cdp = value;
    if (name === "--url") args.url = value;
    if (name === "--output") args.output = path.resolve(value);
    if (name === "--max-pages") args.maxPages = parsePositiveInt(value, name);
    if (name === "--max-records") args.maxRecords = parsePositiveInt(value, name);
    if (name === "--robot-keyword" || name === "--keyword") args.robotKeyword = value;
  }
  return args;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function cleanText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function findHistoryTable(page) {
  const tables = page.locator("table");
  const count = await tables.count();
  for (let index = 0; index < count; index += 1) {
    const table = tables.nth(index);
    if (!(await table.isVisible().catch(() => false))) continue;
    if (await table.locator("tbody tr").count()) return table;
  }
  return null;
}

async function readPaginationTotal(page) {
  const total = await firstVisible(page, [
    ".arco-pagination-total",
    ".ant-pagination-total-text",
  ]);
  if (!total) return 0;
  const match = (await total.innerText().catch(() => "")).match(/([\d,]+)/);
  return match ? Number.parseInt(match[1].replace(/,/g, ""), 10) : 0;
}

async function waitForRowsReady(page, expectedCount = 0) {
  let previousCount = -1;
  let stableRounds = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const table = await findHistoryTable(page);
    if (table) {
      const count = await table.locator("tbody tr").count();
      if (expectedCount > 0 && count >= expectedCount) return table;
      if (count > 0 && count === previousCount) stableRounds += 1;
      else stableRounds = 0;
      if (expectedCount === 0 && stableRounds >= 4) return table;
      previousCount = count;
    }
    await sleep(250);
  }
  return waitForHistoryTable(page);
}

async function waitForHistoryTable(page) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const table = await findHistoryTable(page);
    if (table) {
      await table.locator("tbody tr").first().waitFor({ state: "visible", timeout: 5_000 });
      return table;
    }
    await sleep(250);
  }
  throw new Error("等待对话记录表格超时");
}

async function openHistoryPage(page, url) {
  if (await findHistoryTable(page)) {
    await waitForHistoryTable(page);
    return;
  }

  const links = page.getByText("对话记录", { exact: true });
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    await link.click().catch(() => null);
    if (await findHistoryTable(page)) {
      await waitForHistoryTable(page);
      return;
    }
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHistoryTable(page);
}

async function visiblePlaceholder(page, placeholder) {
  const inputs = page.getByPlaceholder(placeholder);
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (await input.isVisible().catch(() => false)) return input;
  }
  return null;
}

async function visibleQueryButton(page) {
  const buttons = page.getByRole("button", { name: "查询", exact: true });
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) return button;
  }
  return null;
}

// Arco changes the search input placeholder to the selected robot name after
// the first query, so locate the visible searchable select rather than a
// fixed placeholder.
async function visibleRobotSelect(page) {
  const selects = page.locator(".arco-select-view-search");
  const count = await selects.count();
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    if (await select.isVisible().catch(() => false)) return select;
  }
  return null;
}

async function openRobotSearch(page, keyword) {
  const select = await visibleRobotSelect(page);
  if (!select) throw new Error("No visible robot search select");
  const input = select.locator("input.arco-select-view-input");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await select.click({ force: true, position: { x: 8, y: 15 } });
    if (await input.isVisible().catch(() => false)) break;
    await sleep(100);
  }
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill(keyword);
  await sleep(250);
}

async function findRobotOptions(page, keyword) {
  await openRobotSearch(page, keyword);
  const options = page.locator("li.arco-select-option");
  const names = await options.evaluateAll((elements, search) => [...new Set(
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.toLowerCase().includes(String(search).toLowerCase())),
  )], keyword);
  await page.keyboard.press("Escape").catch(() => null);
  return names;
}

async function selectRobotAndQuery(page, keyword, robotName) {
  await openRobotSearch(page, keyword);
  const options = page.locator("li.arco-select-option").filter({ hasText: robotName });
  let target = null;
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    if (cleanText(await option.innerText().catch(() => "")) === robotName) {
      target = option;
      break;
    }
  }
  if (!target) throw new Error(`Robot option not found: ${robotName}`);
  await target.dispatchEvent("click");
  await sleep(250);

  const query = await visibleQueryButton(page);
  if (!query) throw new Error("No visible query button");
  await query.dispatchEvent("click");
  await sleep(500);
  await waitForHistoryTable(page);
}

async function extractTableRows(page, expectedCount = 0) {
  const table = await waitForRowsReady(page, expectedCount);
  const rows = table.locator("tbody tr");
  const count = await rows.count();
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await row.locator("td").allTextContents();
    const rowText = cleanText(await row.innerText());
    if (!rowText) continue;

    const normalizedCells = cells.map(cleanText);
    result.push({
      pageRowIndex: index,
      rowKey: await row.getAttribute("data-row-key")
        ?? await row.getAttribute("data-key")
        ?? null,
      processName: normalizedCells[1] ?? "",
      source: normalizedCells[2] ?? "",
      lastCompletionAt: normalizedCells[3] ?? "",
      firstCompletion: normalizedCells[4] ?? "",
      messageCount: normalizedCells[5] ?? "",
      totalCost: normalizedCells[6] ?? "",
      checkedCount: normalizedCells[7] ?? "",
      feedback: normalizedCells[8] ?? "",
      cells: normalizedCells,
      rowText,
    });
  }
  return result;
}

async function findVisibleDetailPanel(page) {
  return firstVisible(page, [
    ".chat-box",
    ".ant-drawer-open .ant-drawer-body",
    ".ant-drawer-open .ant-drawer-content",
    ".ant-modal-root .ant-modal-body",
    ".ant-modal-root .ant-modal-content",
    '[role="dialog"]',
  ]);
}

async function findScrollablePanel(panel) {
  const candidates = [
    panel,
    panel.locator(".ant-drawer-body"),
    panel.locator(".ant-modal-body"),
    panel.locator('[style*="overflow-y"]'),
    panel.locator('[style*="overflow: auto"]'),
  ];

  let best = panel;
  let bestHeight = 0;
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const metrics = await item.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      })).catch(() => null);
      if (metrics && metrics.scrollHeight - metrics.clientHeight > bestHeight) {
        best = item;
        bestHeight = metrics.scrollHeight - metrics.clientHeight;
      }
    }
  }
  return best;
}

async function scrollDetailToTop(scrollable, page) {
  let previousHeight = -1;
  let stableRounds = 0;
  for (let round = 0; round < 30 && stableRounds < 3; round += 1) {
    const before = await scrollable.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    })).catch(() => null);
    await scrollable.evaluate((element) => { element.scrollTop = 0; });
    await sleep(250);
    const after = await scrollable.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    })).catch(() => null);
    const height = after?.scrollHeight ?? before?.scrollHeight ?? 0;
    if (height === previousHeight && (after?.scrollTop ?? 0) === 0) stableRounds += 1;
    else stableRounds = 0;
    previousHeight = height;
  }
  await page.waitForTimeout(150);
}

async function scrollDetailThroughContent(scrollable, panel, page) {
  const snapshots = [];
  let previousTop = -1;
  let bottomStable = 0;

  for (let round = 0; round < 120; round += 1) {
    const state = await scrollable.evaluate((element) => ({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    const text = await panel.innerText().catch(() => "");
    if (text && !snapshots.some((item) => item.text === text)) {
      snapshots.push({ scrollTop: state.scrollTop, text });
    }

    const atBottom = state.scrollTop + state.clientHeight >= state.scrollHeight - 4;
    if (atBottom) {
      bottomStable = state.scrollTop === previousTop ? bottomStable + 1 : 0;
      if (bottomStable >= 3) break;
    }
    previousTop = state.scrollTop;
    await scrollable.evaluate((element) => {
      element.scrollTop = Math.min(element.scrollTop + Math.max(240, element.clientHeight * 0.85), element.scrollHeight);
    });
    await sleep(180);
  }

  await page.waitForTimeout(150);
  const finalText = await panel.innerText().catch(() => "");
  if (finalText && !snapshots.some((item) => item.text === finalText)) {
    snapshots.push({ scrollTop: 0, text: finalText });
  }
  return snapshots;
}

async function readDetailPanel(page) {
  const panel = await findVisibleDetailPanel(page);
  if (!panel) throw new Error("打开详情后没有找到可见详情面板");
  const scrollable = await findScrollablePanel(panel);

  // Arco's chat panel renders the complete conversation in the DOM when it
  // opens. Trigger one top/bottom pass to activate any lazy content, then use
  // the longest visible DOM snapshot. The bounded pass keeps full collection
  // practical for hundreds of records.
  const immediateText = await panel.innerText().catch(() => "");
  if (immediateText.length > 0) {
    const snapshots = [{ scrollTop: 0, text: immediateText }];
    await scrollable.evaluate((element) => { element.scrollTop = 0; });
    await sleep(250);
    const topText = await panel.innerText().catch(() => "");
    if (topText && !snapshots.some((item) => item.text === topText)) {
      snapshots.push({ scrollTop: 0, text: topText });
    }
    await scrollable.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await sleep(250);
    const bottomText = await panel.innerText().catch(() => "");
    if (bottomText && !snapshots.some((item) => item.text === bottomText)) {
      snapshots.push({ scrollTop: 1, text: bottomText });
    }
    const longest = snapshots.reduce((best, current) => current.text.length > best.length ? current.text : best, "");
    if (longest.length >= 200) {
      return { text: longest, snapshots, snapshotCount: snapshots.length };
    }
  }

  await scrollDetailToTop(scrollable, page);
  const snapshots = await scrollDetailThroughContent(scrollable, panel, page);
  const longest = snapshots.reduce((best, current) => current.text.length > best.length ? current.text : best, "");
  return {
    text: longest,
    snapshots,
    snapshotCount: snapshots.length,
  };
}

async function closeDetailPanel(page) {
  await page.keyboard.press("Escape").catch(() => null);
  await page.waitForTimeout(150);
  const panel = await findVisibleDetailPanel(page);
  if (panel) {
    const closeButton = await firstVisible(page, [
      ".ant-drawer-close",
      ".ant-modal-close",
      '[aria-label="关闭"]',
      '[title="关闭"]',
    ]);
    if (closeButton) await closeButton.click().catch(() => null);
  }
  const table = await findHistoryTable(page);
  if (table) await table.locator("tbody tr").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => null);
}

async function clickDetailsForRow(row) {
  const button = row.getByRole("button", { name: "查看详情" });
  await button.waitFor({ state: "visible", timeout: 10_000 });
  // The page has a floating chat widget that can overlap the table visually.
  // The locator is still scoped to the current row, so force-clicking this
  // read-only "view details" action is safe and avoids a 30s pointer timeout.
  await button.click({ force: true, timeout: 10_000 });
}

async function findNextButton(page) {
  const candidates = [
    page.locator(".arco-pagination-item-next"),
    page.locator(".ant-pagination-next"),
    page.locator('[title="下一页"]'),
    page.locator('button[aria-label="下一页"]'),
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const state = await candidate.evaluate((element) => ({
        className: element.className,
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      })).catch(() => ({ className: "", disabled: false }));
      if (state.disabled || String(state.className).includes("disabled")) return null;
      return candidate;
    }
  }
  return null;
}

async function moveToNextPage(page, nextButton, previousFirstRow) {
  // The fixed right-side detail panel overlaps the visual pagination area.
  // Dispatching the pagination control's own click event keeps this within
  // the page UI flow without sending a backend request or clicking through
  // the detail panel overlay.
  await nextButton.dispatchEvent("click");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    const table = await findHistoryTable(page);
    if (!table) continue;
    const first = table.locator("tbody tr").first();
    const current = cleanText(await first.innerText().catch(() => ""));
    if (current && current !== previousFirstRow) return;
  }
  throw new Error("点击下一页后表格内容没有刷新");
}

async function choosePage(browser, pages, url) {
  const matching = pages.find((candidate) => candidate.url().includes("jimoai.xiaohuodui.cn/robot"));
  if (matching) return matching;
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP 浏览器中没有可用浏览器上下文");
  const page = pages[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page;
}

async function collectCurrentFilter(page, args, records, errors, robotFilter, filterLimit) {
  const filterStart = records.length;
  const seenRows = new Set();
  let pageNumber = 1;
  const totalFromUi = await readPaginationTotal(page);
  let pageSize = 0;

  while (true) {
    if (args.maxPages > 0 && pageNumber > args.maxPages) break;
    if (filterLimit > 0 && records.length - filterStart >= filterLimit) break;

    const expectedCount = pageSize > 0 && totalFromUi > 0
      ? Math.max(0, Math.min(pageSize, totalFromUi - ((pageNumber - 1) * pageSize)))
      : 0;
    const rows = await extractTableRows(page, expectedCount);
    if (rows.length === 0) break;
    if (pageSize === 0) pageSize = rows.length;

    for (const rowData of rows) {
      if (filterLimit > 0 && records.length - filterStart >= filterLimit) break;
      // The UI does not expose a stable row key. Do not deduplicate by
      // visible text: two independent sessions can legitimately share the
      // same timestamp, robot, and first message. Only use a real DOM row key
      // when the platform provides one.
      if (rowData.rowKey) {
        if (seenRows.has(rowData.rowKey)) continue;
        seenRows.add(rowData.rowKey);
      }

      const record = {
        page: pageNumber,
        robotFilter,
        row: rowData,
        detail: null,
      };
      if (args.details) {
        try {
          const currentTable = await waitForHistoryTable(page);
          const currentRows = currentTable.locator("tbody tr");
          const row = currentRows.nth(rowData.pageRowIndex);
          await clickDetailsForRow(row);
          record.detail = await readDetailPanel(page);
          await closeDetailPanel(page);
        } catch (error) {
          record.detail = { error: error instanceof Error ? error.message : String(error) };
          errors.push({ page: pageNumber, robotFilter, row: rowData.rowText, error: record.detail.error });
          await closeDetailPanel(page);
        }
      }
      records.push(record);
      console.log(`[RPA] robot=${robotFilter ?? "all"} page=${pageNumber} records=${records.length} ${rowData.processName} ${rowData.lastCompletionAt}`);
    }

    if (filterLimit > 0 && records.length - filterStart >= filterLimit) break;
    const currentTable = await waitForHistoryTable(page);
    const firstRow = cleanText(await currentTable.locator("tbody tr").first().innerText().catch(() => ""));
    const nextButton = await findNextButton(page);
    if (!nextButton) break;
    await moveToNextPage(page, nextButton, firstRow);
    pageNumber += 1;
  }

  return { pages: pageNumber, records: records.length - filterStart };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.connectOverCDP(args.cdp);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = await choosePage(browser, pages, args.url);
  await page.bringToFront().catch(() => null);
  await openHistoryPage(page, args.url);

  const startedAt = new Date().toISOString();
  const records = [];
  const errors = [];
  let robotNames = [null];
  if (args.robotKeyword) {
    robotNames = await findRobotOptions(page, args.robotKeyword);
    if (robotNames.length === 0) throw new Error(`没有找到名称包含“${args.robotKeyword}”的机器人`);
  }

  const filterRuns = [];
  for (let index = 0; index < robotNames.length; index += 1) {
    if (args.maxRecords > 0 && records.length >= args.maxRecords) break;
    const robotFilter = robotNames[index];
    if (robotFilter) await selectRobotAndQuery(page, args.robotKeyword, robotFilter);
    const remainingRobots = robotNames.length - index;
    const filterLimit = args.maxRecords > 0
      ? Math.ceil((args.maxRecords - records.length) / remainingRobots)
      : 0;
    const run = await collectCurrentFilter(page, args, records, errors, robotFilter, filterLimit);
    filterRuns.push({ robot: robotFilter, ...run });
  }

  const orderedRecords = [...records].sort((left, right) =>
    String(right.row.lastCompletionAt).localeCompare(String(left.row.lastCompletionAt)));
  const outputRecords = args.maxRecords > 0 ? orderedRecords.slice(0, args.maxRecords) : orderedRecords;

  const output = {
    collectedAt: new Date().toISOString(),
    startedAt,
    mode: "ui-rpa",
    url: page.url(),
    cdpUrl: args.cdp,
    detailsCollected: args.details,
    filters: {
      robotKeyword: args.robotKeyword || null,
      selectedRobots: robotNames.filter(Boolean),
    },
    filterRuns,
    pagesCollected: filterRuns.reduce((sum, run) => sum + run.pages, 0),
    totalRecords: outputRecords.length,
    records: outputRecords,
    errors,
  };

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(output, null, 2), "utf8");
  console.log(`Saved ${records.length} records to ${args.output}`);
  if (errors.length) console.log(`Detail errors: ${errors.length}`);
  // Playwright's CDP connection intentionally stays attached to the user's
  // Chrome. Exit the collector without closing that browser process.
  await sleep(50);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
