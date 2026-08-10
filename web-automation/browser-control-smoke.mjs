import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { ChromeCdpController } from "../packages/agent-core/dist/browser.js";
import { chromium } from "../packages/agent-core/node_modules/playwright-core/index.mjs";

const execFileAsync = promisify(execFile);

const chromeCandidates = [
  process.env.CHROME_PATH ?? "",
  ...(process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  ] : []),
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : "",
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));

if ((process.platform !== "win32" && process.platform !== "darwin") || !chromePath) {
  console.warn("[browser-control-smoke] skipped: Chrome/Edge executable not found");
  process.exit(0);
}

const profileDir = await mkdtemp(path.join(os.tmpdir(), "yoomclaw-browser-profile-"));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "yoomclaw-browser-data-"));
const server = http.createServer((req, res) => {
  const second = req.url?.startsWith("/second");
  const title = second ? "YoomClaw Browser Smoke Second" : "YoomClaw Browser Smoke";
  const body = second
    ? "<h1>Second tab</h1><p id=\"tab-state\">second</p>"
    : `
      <h1>Browser fixture</h1>
      <label for="name">Name</label>
      <input id="name" aria-label="Name">
      <button id="apply">Apply</button>
      <button id="apply-copy">Apply</button>
      <p id="status">Idle</p>
      <script>
        document.querySelector('#apply').addEventListener('click', () => {
          document.querySelector('#status').textContent = 'Hello ' + document.querySelector('#name').value;
        });
      </script>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixturePort = server.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const cdpPort = 9333;
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdio: "ignore", windowsHide: true });
let controller;
let directBrowser;

async function waitForCdp() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("temporary Chrome did not expose CDP in time");
}

try {
  await waitForCdp();
  controller = new ChromeCdpController(dataDir, cdpUrl);
  await controller.connect();
  const first = await controller.navigate(fixtureUrl);
  assert.equal(first.title, "YoomClaw Browser Smoke");
  assert.match(first.aria ?? "", /Name|Apply/);

  const typed = await controller.type({ kind: "label", value: "Name" }, "Ada");
  assert.match(typed.text, /Browser fixture/);
  const clicked = await controller.click("#apply");
  assert.match(clicked.text, /Hello Ada/);
  await assert.rejects(
    () => controller.click({ kind: "role", value: "button", name: "Apply" }),
    (error) => error?.code === "BROWSER_TARGET_AMBIGUOUS",
  );

  directBrowser = await chromium.connectOverCDP(cdpUrl, { noDefaults: true });
  const directContext = directBrowser.contexts()[0];
  assert.ok(directContext);
  const secondPage = await directContext.newPage();
  await secondPage.goto(`${fixtureUrl}/second`, { waitUntil: "domcontentloaded" });
  const tabs = await controller.listTabs();
  assert.ok(tabs.length >= 2);
  const second = tabs.find((tab) => tab.url.includes("/second"));
  assert.ok(second);
  await controller.selectTab(second.id);
  const secondSnapshot = await controller.snapshot();
  assert.equal(secondSnapshot.title, "YoomClaw Browser Smoke Second");

  const screenshot = await controller.screenshot();
  assert.ok(screenshot.path && existsSync(screenshot.path));
  assert.equal(controller.status().title, "YoomClaw Browser Smoke Second");
  await controller.disconnect();
  await directBrowser.close();
  directBrowser = null;

  const invalid = new ChromeCdpController(dataDir, "http://127.0.0.1:1");
  await assert.rejects(
    () => invalid.connect(),
    (error) => error?.code === "BROWSER_CDP_CONNECT_FAILED",
  );
  console.log(JSON.stringify({ ok: true, tabs: tabs.length, screenshot: screenshot.path }));
} finally {
  await controller?.disconnect().catch(() => undefined);
  await directBrowser?.close().catch(() => undefined);
  if (!chrome.killed) {
    if (process.platform === "win32" && chrome.pid) {
      await execFileAsync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"]).catch(() => undefined);
    } else {
      chrome.kill();
    }
  }
  await new Promise((resolve) => {
    if (chrome.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    chrome.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  for (const directory of [profileDir, dataDir]) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}
