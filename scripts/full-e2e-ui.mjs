#!/usr/bin/env node

/**
 * Full Electron UI regression runner.
 *
 * This runner intentionally requires --live.  It never substitutes a fake LLM
 * for the user-facing chat path; lower-level unit tests remain the place for
 * deterministic tool contracts.  The runner creates an isolated workspace and
 * Electron profile, records every case, and leaves Chrome untouched.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron } from "../packages/agent-core/node_modules/playwright-core/index.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_TIMEOUT = 20_000;
const LIVE_TIMEOUT = 180_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isBlockedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /18789|Gateway|Jimo|credential|凭证|登录|Chrome CDP|不可用|未配置|timeout|超时/i.test(message);
}

function parseArgs(argv) {
  const args = {
    live: false,
    fullLive: false,
    reportDir: path.join(REPO_ROOT, ".tmp", "yoomclaw-e2e"),
    chromeCdp: "http://127.0.0.1:9222",
    requireChrome: false,
    keepArtifacts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm test:e2e:ui -- --live [--full-live] [--report-dir <dir>] [--require-chrome]");
      process.exit(0);
    }
    if (arg === "--live") args.live = true;
    else if (arg === "--full-live") args.fullLive = true;
    else if (arg === "--require-chrome") args.requireChrome = true;
    else if (arg === "--keep-artifacts") args.keepArtifacts = true;
    else {
      const [name, inline] = arg.split("=", 2);
      const value = inline ?? argv[++index];
      if (!value) throw new Error(`Missing value for ${name}`);
      if (name === "--report-dir") args.reportDir = path.resolve(value);
      else if (name === "--chrome-cdp") args.chromeCdp = value;
      else throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.live) {
    throw new Error("真实端到端 UI 测试必须显式传入 --live；它会调用 Jimo 并产生后台记录。");
  }
  return args;
}

async function waitFor(description, predicate, timeoutMs = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`等待${description}超时${suffix}`);
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert(address && typeof address !== "string", "无法分配 Renderer 端口");
  return address.port;
}

async function waitForHttp(url, timeoutMs = DEFAULT_TIMEOUT) {
  await waitFor(url, async () => {
    const response = await fetch(url);
    return response.ok;
  }, timeoutMs);
}

async function assertGatewayFree() {
  try {
    const response = await fetch(`${GATEWAY_URL}/api/health`);
    if (response.ok) {
      throw new Error("18789 端口已有 Gateway；请先关闭正在运行的 YoomClaw，再运行 E2E。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("已有 Gateway")) throw error;
  }
}

function startRenderer(port) {
  const viteCli = path.join(REPO_ROOT, "apps", "desktop", "renderer", "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(REPO_ROOT, "apps", "desktop", "renderer"),
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = [];
  const capture = (chunk) => {
    output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    while (output.length > 100) output.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, output };
}

async function createFixtures(root) {
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside-workspace");
  const exportDir = path.join(root, "exports");
  await fs.mkdir(path.join(workspace, "中文目录"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(exportDir, { recursive: true });
  const files = {
    markdown: path.join(workspace, "中文目录", "测试说明.md"),
    json: path.join(workspace, "数据.json"),
    csv: path.join(workspace, "表格.csv"),
    html: path.join(workspace, "页面.html"),
    image: path.join(workspace, "中文图片.png"),
    outsideDelete: path.join(outside, "可删除测试文件.txt"),
    sensitive: path.join(workspace, ".env.test"),
    malformedPdf: path.join(workspace, "损坏.pdf"),
    malformedPptx: path.join(workspace, "损坏.pptx"),
    malformedXlsx: path.join(workspace, "损坏.xlsx"),
    malformedDocx: path.join(workspace, "损坏.docx"),
  };
  await fs.writeFile(files.markdown, "# 中文测试\n\n这是 YoomClaw E2E 的本地 Markdown 文件。\n", "utf8");
  await fs.writeFile(files.json, JSON.stringify({ name: "中文数据", value: 42 }, null, 2), "utf8");
  await fs.writeFile(files.csv, "名称,数值\n中文,42\n", "utf8");
  await fs.writeFile(files.html, "<html><head><title>中文页面</title><script>bad()</script></head><body><p>正文内容</p></body></html>", "utf8");
  await fs.writeFile(files.outsideDelete, "仅允许在 full-access 测试中删除\n", "utf8");
  await fs.writeFile(files.sensitive, "E2E_SECRET_MARKER=must-not-be-read\n", "utf8");
  await fs.writeFile(files.malformedPdf, Buffer.from("not a pdf", "utf8"));
  await fs.writeFile(files.malformedPptx, Buffer.from("not a pptx", "utf8"));
  await fs.writeFile(files.malformedXlsx, Buffer.from("not an xlsx", "utf8"));
  await fs.writeFile(files.malformedDocx, Buffer.from("not a docx", "utf8"));
  // 1x1 transparent PNG; this is enough to exercise the renderer attachment path.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(files.image, png);
  return { root, workspace, outside, exportDir, files };
}

async function closeElectron(electronApp) {
  if (!electronApp) return;
  try {
    await electronApp.evaluate(({ app }) => app.quit());
  } catch {}
  try {
    await electronApp.close();
  } catch {}
}

async function checkChrome(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function safeSlug(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "case";
}

async function ariaSnapshot(page) {
  try {
    const body = page.locator("body");
    return typeof body.ariaSnapshot === "function" ? await body.ariaSnapshot() : "";
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const runId = `YC-E2E-${startedAt.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.mkdir(args.reportDir, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(args.reportDir, `${safeSlug(runId)}-`));
  const fixtures = await createFixtures(path.join(runDir, "fixtures"));

  const report = {
    runId,
    testMarker: `[${runId}]`,
    startedAt: startedAt.toISOString(),
    rendererPort: null,
    gatewayUrl: GATEWAY_URL,
    logsDir: path.join(runDir, "logs"),
    chromeCdp: args.chromeCdp,
    chromeReady: false,
    fixtures: { workspace: fixtures.workspace, outside: fixtures.outside, files: fixtures.files },
    expectations: {
      sessionTitleContains: "",
      userMessageContains: "",
      fileNames: [path.basename(fixtures.files.markdown)],
      toolNames: args.fullLive ? ["update_plan", "read_document", "execute_code"] : [],
    },
    cases: [],
    errors: [],
    consoleErrors: [],
    networkErrors: [],
    status: "failed",
  };
  const electronPath = path.join(REPO_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  let userDataDir;
  let renderer;

  try {
    await assertGatewayFree();
    await fs.access(electronPath);
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoomclaw-e2e-user-data-"));
    report.rendererPort = await findFreePort();
    renderer = startRenderer(report.rendererPort);
  } catch (error) {
    report.status = isBlockedError(error) ? "blocked" : "failed";
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`Full UI E2E report: ${runDir}`);
    console.log(JSON.stringify({ status: report.status, runId, chromeReady: false }));
    process.exitCode = 1;
    return;
  }
  let electronApp;

  const recordCase = async (id, action, fn) => {
    const item = { id, action, status: "failed", startedAt: new Date().toISOString() };
    report.cases.push(item);
    try {
      const detail = await fn();
      item.status = "passed";
      if (detail !== undefined) item.detail = detail;
    } catch (error) {
      item.status = isBlockedError(error) ? "blocked" : "failed";
      item.error = error instanceof Error ? error.message : String(error);
      report.errors.push(`${id}: ${item.error}`);
      if (electronApp) {
        try {
          const page = await electronApp.firstWindow({ timeout: 1_000 });
          await page.screenshot({ path: path.join(runDir, `${safeSlug(id)}-failure.png`), fullPage: true });
          await fs.writeFile(path.join(runDir, `${safeSlug(id)}-failure.html`), await page.content(), "utf8");
          await fs.writeFile(path.join(runDir, `${safeSlug(id)}-failure.txt`), await page.locator("body").innerText().catch(() => ""), "utf8");
          await fs.writeFile(path.join(runDir, `${safeSlug(id)}-failure.aria.txt`), await ariaSnapshot(page), "utf8");
        } catch {}
      }
    }
    item.finishedAt = new Date().toISOString();
    return item.status === "passed";
  };

  try {
    report.chromeReady = await checkChrome(args.chromeCdp);
    if (args.requireChrome && !report.chromeReady) {
      throw new Error(`Chrome CDP 不可用：${args.chromeCdp}。请用独立测试配置文件启动 Chrome。`);
    }
    await waitForHttp(`http://127.0.0.1:${report.rendererPort}`, 60_000);
    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: [`--user-data-dir=${userDataDir}`, "--disable-gpu", "--no-sandbox", path.join(REPO_ROOT, "apps", "desktop")],
      env: {
        ...process.env,
        CLAW_RENDERER_URL: `http://127.0.0.1:${report.rendererPort}`,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: "18789",
        YOOMCLAW_WORKSPACE: fixtures.workspace,
        YOOMCLAW_AGENT_MODE: "hermes",
        YOOMCLAW_PROMPT_MODE: "provider",
        YOOMCLAW_AUTO_MEMORY_REVIEW: "false",
        YOOMCLAW_E2E_EXPORT_DIR: fixtures.exportDir,
        YOOMCLAW_E2E_LOG_DIR: path.join(runDir, "logs"),
      },
      timeout: 60_000,
    });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    page.setDefaultNavigationTimeout(60_000);
    page.on("pageerror", (error) => {
      report.consoleErrors.push(`pageerror: ${error.message}`);
      report.errors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        report.consoleErrors.push(message.text());
        report.errors.push(`console: ${message.text()}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        const error = `${response.status()} ${response.url()}`;
        report.networkErrors.push(error);
        report.errors.push(`http: ${error}`);
      }
    });

    const testId = (id) => page.getByTestId(id);
    const click = async (id) => {
      const locator = testId(id);
      await locator.waitFor({ state: "visible" });
      await locator.click();
    };
    const closeSidebarOverlayIfVisible = async () => {
      const overlay = page.locator(".sidebar-overlay");
      if (await overlay.isVisible().catch(() => false)) {
        const box = await overlay.boundingBox();
        assert(box, "侧栏遮罩没有布局盒子");
        // On mobile the open sidebar sits above the left side of the overlay;
        // click the far-right edge so the real overlay receives the pointer.
        await overlay.click({ position: { x: Math.max(8, box.width - 8), y: 8 } });
        await overlay.waitFor({ state: "hidden" }).catch(() => {});
      }
    };
    const bodyText = () => page.locator("body").innerText();
    const snapshot = async (name) => {
      await page.screenshot({ path: path.join(runDir, `${safeSlug(name)}.png`), fullPage: true });
      await fs.writeFile(path.join(runDir, `${safeSlug(name)}.html`), await page.content(), "utf8");
      await fs.writeFile(path.join(runDir, `${safeSlug(name)}.txt`), await bodyText(), "utf8");
      await fs.writeFile(path.join(runDir, `${safeSlug(name)}.aria.txt`), await ariaSnapshot(page), "utf8");
    };

    await recordCase("BOOT-01", "Renderer、Gateway 和 WebSocket 启动", async () => {
      await waitForHttp(`${GATEWAY_URL}/api/health`, 60_000);
      await testId("compose-input").waitFor({ state: "visible", timeout: 60_000 });
      await waitFor("WebSocket 连接", async () => (await bodyText()).includes("已连接"), 60_000);
      const configResponse = await fetch(`${GATEWAY_URL}/api/config`);
      assert(configResponse.ok, "Gateway 配置状态不可读取");
      const config = await configResponse.json();
      report.capabilities = {
        agent: config.agent ?? { id: "main", model: "gpt-5.6-luna" },
        mode: config.mode,
        promptMode: config.promptMode,
        imageHostConfigured: config.imageHostConfigured === true,
        searchConfigured: config.searchConfigured === true,
        mcpConfigured: config.mcpConfigured === true,
        toolsets: Array.isArray(config.toolsets) ? config.toolsets : [],
      };
    });

    await recordCase("WIN-01", "最小化并恢复窗口", async () => {
      await click("window-minimize");
      await waitFor("窗口最小化", async () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() === true));
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
      await page.evaluate(() => window.yoomclaw?.focusWindow?.());
    });

    await recordCase("WIN-02", "最大化与还原", async () => {
      await click("window-maximize");
      assert(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized()), "窗口没有最大化");
      assert(await testId("window-maximize").getAttribute("aria-label") === "向下还原", "最大化后按钮没有切换为还原");
      await click("window-maximize");
      assert(!(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())), "窗口没有还原");
    });

    await recordCase("WIN-03", "关闭按钮进入托盘并恢复窗口", async () => {
      await click("window-close");
      await waitFor("窗口隐藏到托盘", async () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() === false));
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
      await testId("compose-input").waitFor({ state: "visible" });
    });

    await recordCase("NAV-01", "侧栏开关", async () => {
      const sidebar = page.locator(".sidebar");
      assert((await sidebar.getAttribute("class")).includes("open"), "侧栏初始没有打开");
      await click("sidebar-toggle");
      assert((await sidebar.getAttribute("class")).includes("closed"), "侧栏没有关闭");
      await click("sidebar-toggle");
      assert((await sidebar.getAttribute("class")).includes("open"), "侧栏没有恢复");
    });

    await recordCase("NAV-02", "新建会话和输入焦点", async () => {
      const emptySuggestion = page.locator('[data-testid^="session-empty-prompt-"]').first();
      if (await emptySuggestion.isVisible().catch(() => false)) {
        await emptySuggestion.click();
        assert((await testId("compose-input").inputValue()).trim().length > 0, "空状态建议词没有预填输入框");
        await testId("compose-input").fill("");
      }
      const emptyCta = testId("session-empty-cta");
      if (await emptyCta.isVisible().catch(() => false)) {
        await emptyCta.click();
        assert(await testId("compose-input").isEnabled(), "空状态开始新对话没有激活输入框");
      }
      await click("session-new");
      await waitFor("会话创建", async () => (await page.locator('[data-testid^="session-row-"]').count()) > 0);
      assert(await page.locator(".compose-input").isEnabled(), "新会话输入框不可用");
    });

    await recordCase("NAV-03", "设置面板标签和关闭", async () => {
      await click("settings-open");
      await testId("settings-close").waitFor({ state: "visible" });
      for (const tab of ["agent", "general", "appearance", "about"]) await click(`settings-tab-${tab}`);
      await testId("about-open-data-dir").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await testId("settings-close").waitFor({ state: "detached" });
      await click("settings-open");
      await page.locator(".settings-mask").click({ position: { x: 4, y: 4 } });
      await testId("settings-close").waitFor({ state: "detached" });
    });

    await recordCase("NAV-04", "三种访问权限菜单", async () => {
      await click("safety-mode");
      for (const mode of ["confirm", "workspace-auto", "full-access"]) {
        await click(`safety-mode-${mode}`);
        assert((await testId("safety-mode").innerText()).length > 0, `${mode} 没有更新权限按钮`);
        await click("safety-mode");
      }
      await click("safety-mode-workspace-auto");
    });

    await recordCase("NAV-05", "任务工作台开关", async () => {
      await click("workbench-open");
      await testId("workbench-close").waitFor({ state: "visible" });
      const entry = page.locator('[data-testid^="workbench-entry-"]').first();
      if (await entry.count()) await entry.click();
      await click("workbench-close");
      await testId("workbench-close").waitFor({ state: "detached" });
    });

    await recordCase("NAV-08", "侧栏键盘宽度调整", async () => {
      const separator = testId("sidebar-resizer");
      const before = Number(await separator.getAttribute("aria-valuenow"));
      const box = await separator.boundingBox();
      assert(box, "侧栏拖动分隔条没有布局盒子");
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 24, box.y + 40);
      await page.mouse.up();
      await waitFor("侧栏拖动宽度更新", async () => Number(await separator.getAttribute("aria-valuenow")) > before);
      await separator.focus();
      await page.keyboard.press("ArrowRight");
      await waitFor("侧栏宽度更新", async () => Number(await separator.getAttribute("aria-valuenow")) > before);
      await page.keyboard.press("Home");
      assert(Number(await separator.getAttribute("aria-valuenow")) >= 220, "侧栏宽度低于最小值");
      await page.keyboard.press("End");
      assert(Number(await separator.getAttribute("aria-valuenow")) <= 440, "侧栏宽度超过最大值");
    });

    await recordCase("CHAT-01", "文件选择、附件移除和拖拽入口", async () => {
      const input = page.locator('input[type="file"]');
      await input.setInputFiles(fixtures.files.markdown);
      await testId("attachment-remove").first().waitFor({ state: "visible" });
      await page.getByTestId("attachment-remove").first().click();
      assert(await page.locator(".attach-chip").count() === 0, "附件移除失败");
    });

    const sendLivePrompt = async (prompt, files = []) => {
      const before = await page.locator(".message-row").count();
      if (files.length) await page.locator('input[type="file"]').setInputFiles(files);
      await testId("compose-input").fill(prompt);
      await click("message-send");
      await waitFor("Agent 回复", async () => {
        const stop = await testId("message-stop").count();
        const rows = await page.locator(".message-row").count();
        return stop === 0 && rows > before && (await bodyText()).includes(prompt.slice(0, 16));
      }, LIVE_TIMEOUT);
      const assistants = await page.locator(".message-row.assistant").allTextContents();
      const text = assistants.map((value) => value.trim()).filter(Boolean).at(-1) ?? "";
      assert(text, "Agent 回复为空");
      return text;
    };

    const prompt = [
      report.testMarker,
      "这是中文 UI 全流程测试，请只回复已收到，以及测试文件名：测试说明.md。不要调用工具。",
    ].join("\n");
    await recordCase("CHAT-02", "真实 Jimo 中文聊天和首条标题", async () => {
      const reply = await sendLivePrompt(prompt, [fixtures.files.markdown]);
      assert(!/[�]{2,}/.test(reply), "Agent 回复包含乱码替换字符");
      assert((await bodyText()).includes("测试说明.md"), "用户消息没有保留文件名");
      assert((await bodyText()).includes(report.testMarker), "测试标记没有出现在当前会话");
      const row = page.locator('[data-testid^="session-row-"]').filter({ hasText: report.testMarker }).first();
      await row.waitFor({ state: "visible" });
      report.sessionId = (await row.getAttribute("data-testid")).replace("session-row-", "");
      report.expectations.sessionTitleContains = report.testMarker;
      report.expectations.userMessageContains = report.testMarker;
      return {
        replyLength: reply.length,
        sessionId: report.sessionId,
        files: [path.basename(fixtures.files.markdown)],
      };
    });

    await recordCase("CHAT-03", "复制用户和 Agent 消息", async () => {
      const userRow = page.locator(".message-row.user").last();
      const userCopy = userRow.getByTestId("message-copy");
      await userRow.hover();
      await userCopy.click();
      await waitFor("用户复制状态", async () => (await userCopy.getAttribute("aria-label")) === "已复制");
      const assistantRow = page.locator(".message-row.assistant").last();
      const assistantCopy = assistantRow.getByTestId("message-copy");
      await assistantRow.hover();
      await assistantCopy.click();
      await waitFor("Agent 复制状态", async () => (await assistantCopy.getAttribute("aria-label")) === "已复制");
    });

    await recordCase("CHAT-04", "编辑消息预填和布局检查", async () => {
      const userRow = page.locator(".message-row.user").last();
      await userRow.hover();
      await userRow.getByTestId("message-edit").click();
      const value = await testId("compose-input").inputValue();
      assert(value.includes(report.testMarker), "编辑没有预填原消息");
      const userBox = await userRow.locator(".message-bubble").boundingBox();
      const actionBox = await userRow.locator(".message-actions").boundingBox();
      assert(userBox && actionBox && actionBox.y >= userBox.y + userBox.height - 1, "消息操作按钮仍位于消息框内部");
      const rowGeometry = await userRow.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          left: Number.parseFloat(style.paddingLeft),
          right: Number.parseFloat(style.paddingRight),
        };
      });
      assert(Math.abs(rowGeometry.left - rowGeometry.right) < 0.5, "消息行左右内边距不一致");
      await testId("compose-input").fill("");
    });

    await recordCase("CHAT-05", "导出 UTF-8 对话", async () => {
      await click("export-session");
      const exported = (await fs.readdir(fixtures.exportDir)).find((name) => name.endsWith(".md"));
      assert(exported, "没有生成导出文件");
      const content = await fs.readFile(path.join(fixtures.exportDir, exported), "utf8");
      assert(content.includes(report.testMarker) && content.includes("测试说明.md"), "导出文件内容不完整");
    });

    await recordCase("NAV-06", "重命名、置顶、删除临时会话", async () => {
      const before = await page.locator('[data-testid^="session-row-"]').count();
      await click("session-new");
      await waitFor("临时会话", async () => (await page.locator('[data-testid^="session-row-"]').count()) > before);
      const tempRow = page.locator('[data-testid^="session-row-"]').first();
      const tempId = (await tempRow.getAttribute("data-testid")).replace("session-row-", "");
      await tempRow.getByTestId("session-rename").click();
      await testId("session-rename-input").fill("E2E 临时会话");
      await testId("session-rename-input").press("Enter");
      await waitFor("会话重命名", async () => (await tempRow.innerText()).includes("E2E 临时会话"));
      await tempRow.getByTestId("session-rename").click();
      await testId("session-rename-input").fill("E2E 不应保存");
      await testId("session-rename-input").press("Escape");
      assert((await tempRow.innerText()).includes("E2E 临时会话"), "Escape 没有取消重命名");
      await tempRow.getByTestId("session-rename").click();
      await testId("session-rename-input").fill("E2E 失焦会话");
      await testId("session-search").click();
      await waitFor("失焦保存重命名", async () => (await tempRow.innerText()).includes("E2E 失焦会话"));
      await testId("session-search").fill("E2E 失焦");
      await waitFor("会话搜索过滤", async () => {
        const rows = page.locator('[data-testid^="session-row-"]');
        return await rows.count() === 1 && (await rows.first().innerText()).includes("E2E 失焦会话");
      });
      await testId("session-search").fill("");
      await tempRow.getByTestId("session-pin").click();
      await waitFor("会话置顶", async () => (await tempRow.getByTestId("session-pin").getAttribute("title")) === "取消置顶");
      await tempRow.getByTestId("session-delete").click();
      await click("session-delete-cancel");
      assert(await testId(`session-row-${tempId}`).count() === 1, "删除取消后会话消失");
      await tempRow.getByTestId("session-delete").click();
      await page.keyboard.press("Escape");
      assert(await testId(`session-row-${tempId}`).count() === 1, "Escape 后会话消失");
      await tempRow.getByTestId("session-delete").click();
      await click("session-delete-confirm");
      await testId(`session-row-${tempId}`).waitFor({ state: "detached" });
    });

    await recordCase("NAV-07", "删除临时会话后恢复原始会话", async () => {
      if (report.sessionId) {
        const original = testId(`session-row-${report.sessionId}`);
        await original.click();
        await waitFor("恢复原始会话", async () => (await bodyText()).includes(report.testMarker));
      }
    });

    await recordCase("SET-01", "Agent 设置和 Toolset 开关", async () => {
      await click("settings-open");
      await testId("settings-tab-agent").click();
      await testId("agent-auto-memory").click();
      await waitFor("自动记忆保存", async () => (await page.locator(".agent-status").innerText()).includes("配置已保存"));
      await testId("agent-auto-memory").click();
      await testId("agent-toolset-mcp").click();
      await testId("agent-toolset-mcp").click();
      await testId("agent-prompt-tab-project").click();
      await testId("agent-prompt-editor").fill("[YC-E2E] 项目提示词保存测试");
      await testId("agent-prompt-save").click();
      await waitFor("提示词保存", async () => (await page.locator(".agent-status").innerText()).includes("提示词已保存"));
      await click("settings-close");
    });

    await recordCase("SET-02", "外观和通用设置入口", async () => {
      await click("settings-open");
      await click("settings-tab-appearance");
      await page.locator('[data-testid^="appearance-mode-"]').first().click();
      const theme = page.locator('[data-testid^="appearance-theme-"]').first();
      await theme.click();
      const selectedTheme = await page.locator("html").getAttribute("data-theme-id");
      assert(selectedTheme, "主题切换没有更新 HTML 主题标识");
      await click("settings-tab-general");
      const options = page.locator('[data-testid^="setting-option-"]');
      assert(await options.count() >= 4, "通用设置选项没有完整渲染");
      for (let index = 0; index < await options.count(); index += 1) await options.nth(index).click();
      const zoomSlider = page.getByTestId("setting-zoom-slider");
      assert(await zoomSlider.count() === 1, "界面缩放滑动条没有完整渲染");
      assert(await zoomSlider.getAttribute("type") === "range", "界面缩放控件不是滑动条");
      assert(await zoomSlider.getAttribute("min") === "75", "界面缩放最小值错误");
      assert(await zoomSlider.getAttribute("max") === "150", "界面缩放最大值错误");
      assert(await zoomSlider.getAttribute("step") === "1", "界面缩放精度不是 1%");
      const toggles = page.locator('[data-testid^="setting-toggle-"]');
      assert(await toggles.count() >= 4, "通用设置开关没有完整渲染");
      for (let index = 0; index < await toggles.count(); index += 1) {
        assert((await toggles.nth(index).getAttribute("aria-label"))?.trim(), "通用设置开关缺少可访问名称");
      }
      await click("settings-close");
      await page.reload({ waitUntil: "domcontentloaded" });
      await testId("compose-input").waitFor({ state: "visible", timeout: 60_000 });
      await closeSidebarOverlayIfVisible();
      assert(await page.locator("html").getAttribute("data-theme-id") === selectedTheme, "刷新后主题没有保持");
    });

    if (args.fullLive) {
      const requestToolConfirmation = async (prompt) => {
        await testId("compose-input").fill(prompt);
        await click("message-send");
        await testId("confirm-deny").waitFor({ state: "visible", timeout: LIVE_TIMEOUT });
      };

      const sendPromptAndApprove = async (prompt) => {
        const before = await page.locator(".message-row").count();
        await testId("compose-input").fill(prompt);
        await click("message-send");
        await testId("confirm-allow").waitFor({ state: "visible", timeout: LIVE_TIMEOUT });
        await click("confirm-allow");
        await waitFor("Agent 回复", async () => {
          const stop = await testId("message-stop").count();
          const rows = await page.locator(".message-row").count();
          return stop === 0 && rows > before && (await bodyText()).includes(prompt.slice(0, 16));
        }, LIVE_TIMEOUT);
        const assistants = await page.locator(".message-row.assistant").allTextContents();
        const text = assistants.map((value) => value.trim()).filter(Boolean).at(-1) ?? "";
        assert(text, "Agent 回复为空");
        return text;
      };

      await recordCase("PERM-01", "confirm 拒绝工作区外删除", async () => {
        await click("safety-mode");
        await click("safety-mode-confirm");
        await requestToolConfirmation(`${report.testMarker}\n请调用 delete_file 删除绝对路径 ${fixtures.files.outsideDelete}。只等待用户确认。`);
        await click("confirm-deny");
        await waitFor("确认拒绝完成", async () => (await testId("confirm-deny").count()) === 0);
        await fs.access(fixtures.files.outsideDelete);
      });

      await recordCase("PERM-02", "full-access 将临时工作区外文件移到回收站", async () => {
        await click("safety-mode");
        await click("safety-mode-full-access");
        await sendLivePrompt(`${report.testMarker}\n请调用 delete_file 将绝对路径 ${fixtures.files.outsideDelete} 移到系统回收站，完成后回复 FULL-ACCESS-TRASHED。`);
        await waitFor("测试文件移到回收站", async () => {
          try {
            await fs.access(fixtures.files.outsideDelete);
            return false;
          } catch {
            return true;
          }
        }, LIVE_TIMEOUT);
      });

      await click("safety-mode");
      await click("safety-mode-workspace-auto");

      await recordCase("AGENT-01", "真实 Jimo 触发计划和工具卡片", async () => {
        const reply = await sendLivePrompt(`${report.testMarker}\n请调用 update_plan 创建两个步骤，然后回复计划已创建。`);
        assert(reply.length > 0, "计划请求没有回复");
        assert(await page.locator("[data-testid^='message-row-']").count() > 0, "没有消息行");
      });
      await recordCase("AGENT-02", "真实 Jimo 读取文档", async () => {
        await sendLivePrompt(`${report.testMarker}\n请使用 read_document 读取相对路径：中文目录/测试说明.md，并在回复中包含“中文测试”。`);
        assert((await bodyText()).includes("中文测试"), "文档结果没有显示中文内容");
      });
      await recordCase("AGENT-03", "真实 Jimo 代码执行", async () => {
        await sendPromptAndApprove(`${report.testMarker}\n请使用 execute_code 执行 JavaScript：console.log('YC-E2E-CODE')，然后报告 stdout。`);
        assert((await bodyText()).includes("YC-E2E-CODE"), "代码执行结果没有显示");
      });

      await recordCase("CHAT-06", "重试 Agent 回复", async () => {
        const before = await page.locator(".message-row").count();
        const assistantRow = page.locator(".message-row.assistant").last();
        await assistantRow.hover();
        const retry = assistantRow.getByTestId("message-retry");
        await retry.click();
        // Retrying an assistant turn that previously called execute_code
        // creates a fresh confirmation request; approve that real dialog.
        await testId("confirm-allow").waitFor({ state: "visible", timeout: LIVE_TIMEOUT });
        await click("confirm-allow");
        await waitFor("重试完成", async () => (await testId("message-stop").count()) === 0 && (await page.locator(".message-row").count()) >= before);
        assert((await page.locator(".message-row.assistant").last().innerText()).trim().length > 0, "重试后的 Agent 回复为空");
      });

      await recordCase("CHAT-07", "停止生成并恢复发送按钮", async () => {
        await testId("compose-input").fill(`${report.testMarker}\n请开始一个较长的回答，测试停止按钮，不要调用危险工具。`);
        await click("message-send");
        await testId("message-stop").waitFor({ state: "visible", timeout: LIVE_TIMEOUT });
        await click("message-stop");
        await testId("message-send").waitFor({ state: "visible", timeout: LIVE_TIMEOUT });
      });
    }

    await snapshot("ui-final");
    const hasFailedCase = report.cases.some((item) => item.status === "failed");
    const hasBlockedCase = report.cases.some((item) => item.status === "blocked");
    report.status = report.errors.length > 0 || hasFailedCase
      ? "failed"
      : hasBlockedCase
        ? "blocked"
        : "passed";
  } catch (error) {
    report.status = isBlockedError(error) ? "blocked" : "failed";
    report.errors.push(error instanceof Error ? error.message : String(error));
    if (electronApp) {
      try {
        const page = await electronApp.firstWindow({ timeout: 1_000 });
        await page.screenshot({ path: path.join(runDir, "fatal-failure.png"), fullPage: true });
        await fs.writeFile(path.join(runDir, "fatal-failure.html"), await page.content(), "utf8");
        await fs.writeFile(path.join(runDir, "fatal-failure.txt"), await page.locator("body").innerText().catch(() => ""), "utf8");
        await fs.writeFile(path.join(runDir, "fatal-failure.aria.txt"), await ariaSnapshot(page), "utf8");
      } catch {}
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    report.rendererOutput = renderer.output;
    await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
    await closeElectron(electronApp);
    if (renderer.child.exitCode === null) renderer.child.kill();
    if (!args.keepArtifacts) {
      // Keep the report directory itself; only transient user-data is safe to remove.
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`Full UI E2E report: ${runDir}`);
  console.log(JSON.stringify({ status: report.status, runId, sessionId: report.sessionId, chromeReady: report.chromeReady }));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
