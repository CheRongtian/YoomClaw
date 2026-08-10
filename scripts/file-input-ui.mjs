import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { _electron } from "../packages/agent-core/node_modules/playwright-core/index.mjs";
import {
  FILE_INPUT_RULES,
  MAX_FILES_PER_MESSAGE,
  MAX_VIDEO_UPLOAD_BYTES,
} from "../packages/protocol/src/file-policy.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const UI_CHAT_REQUEST_LIMIT = 1;
const TIMEOUT_MS = 180_000;
const TEST_MARKER_PREFIX = "File-input regression test";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
  ".claw-data",
]);
const SUPPORTED_EXTENSIONS = new Set(
  Object.values(FILE_INPUT_RULES).flatMap((rule) => rule.extensions),
);
const MIME_TYPES = {
  pdf: "application/pdf",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    live: false,
    reportDir: path.join(REPO_ROOT, ".tmp", "yoomclaw-file-input-tests"),
    inputRoot: "",
    keepArtifacts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--live") {
      args.live = true;
      continue;
    }
    if (current === "--keep-artifacts") {
      args.keepArtifacts = true;
      continue;
    }
    if (current === "--help" || current === "-h") {
      console.log("Usage: pnpm test:file-inputs:ui -- --live [--report-dir <dir>] [--input-root <isolated-dir>] [--keep-artifacts]");
      process.exit(0);
    }
    const [name, inline] = current.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--report-dir") args.reportDir = path.resolve(value);
    else if (name === "--input-root") args.inputRoot = path.resolve(value);
    else throw new Error(`Unknown option: ${current}`);
  }
  if (!args.live) {
    throw new Error("真实端到端 UI 测试必须显式传入 --live；它会调用 Jimo 并产生后台记录。");
  }
  return args;
}

async function createFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoomclaw-file-input-fixtures-"));
  await fs.mkdir(path.join(root, "中文目录"), { recursive: true });
  await fs.writeFile(
    path.join(root, "中文目录", "测试说明.md"),
    "# YoomClaw UI 文件输入测试\n\n这是隔离临时工作区中的中文 Markdown 文件。\n",
    "utf8",
  );
  return root;
}

function isSensitive(fileName, relativePath) {
  if (/^\.env(?:\.|$)/i.test(fileName)) return true;
  const lower = `${fileName} ${relativePath}`.toLowerCase();
  return /(^|[._-])(secret|token|password|credential|cookie|private|apikey|api-key)([._-]|$)/i.test(lower)
    || /.(pem|key|p12|pfx|crt)$/i.test(fileName);
}

function extensionOf(fileName) {
  return path.extname(fileName).slice(1).toLowerCase();
}

async function findInputFile(root) {
  const candidates = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extensionOf(entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (!SUPPORTED_EXTENSIONS.has(extension) || isSensitive(entry.name, relativePath)) continue;
      const stat = await fs.stat(absolutePath);
      candidates.push({
        absolutePath,
        fileName: entry.name,
        extension,
        sizeBytes: stat.size,
        mimeType: MIME_TYPES[extension] ?? "application/octet-stream",
      });
    }
  }
  await visit(root);
  candidates.sort((left, right) => {
    const leftPriority = left.extension === "md" ? 0 : left.extension === "json" ? 1 : 2;
    const rightPriority = right.extension === "md" ? 0 : right.extension === "json" ? 1 : 2;
    return leftPriority - rightPriority || left.sizeBytes - right.sizeBytes;
  });
  // A zero-byte file is covered by Gateway policy tests, but Jimo's remote
  // upload endpoint may reject an empty payload. Use a real existing file for
  // the one live UI request so that this smoke test exercises the full
  // mixed-input path rather than provider behavior for an empty object.
  const repoReadme = candidates.find((item) => item.absolutePath === path.join(REPO_ROOT, "README.md") && item.sizeBytes > 0);
  const file = repoReadme
    ?? candidates.find((item) => item.sizeBytes > 0 && item.sizeBytes <= 1_000_000)
    ?? candidates.find((item) => item.sizeBytes > 0)
    ?? candidates[0];
  if (!file) throw new Error(`No supported, non-sensitive file found under ${root}`);
  return file;
}

async function waitFor(description, predicate, timeoutMs = 60_000) {
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
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
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
  assert(address && typeof address !== "string", "Could not allocate a local renderer port");
  return address.port;
}

async function waitForHttp(url, timeoutMs = 60_000) {
  await waitFor(url, async () => {
    const response = await fetch(url);
    return response.ok;
  }, timeoutMs);
}

function startRenderer(port) {
  const viteCli = path.join(REPO_ROOT, "apps", "desktop", "renderer", "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [
    viteCli,
    "--host", "127.0.0.1", "--port", String(port),
  ], {
    cwd: path.join(REPO_ROOT, "apps", "desktop", "renderer"),
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = [];
  const capture = (chunk) => {
    output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    while (output.length > 60) output.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, output };
}

async function assertGatewayFree() {
  try {
    const response = await fetch("http://127.0.0.1:18790/api/health");
    if (response.ok) {
      throw new Error("Port 18790 is already serving a Gateway; close the running YoomClaw instance before UI smoke.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) throw error;
  }
}

async function closeElectron(electronApp) {
  if (!electronApp) return;
  try {
    await electronApp.evaluate(({ app }) => app.quit());
  } catch {
    // The process may already have exited after a failed launch.
  }
  try {
    await electronApp.close();
  } catch {
    // Best effort cleanup; the report still records the test result.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownsInputRoot = !args.inputRoot;
  await assertGatewayFree();
  const inputRoot = args.inputRoot || await createFixtureRoot();
  await fs.access(inputRoot);
  const inputFile = await findInputFile(inputRoot);
  const rendererPort = await findFreePort();
  const renderer = startRenderer(rendererPort);
  const reportRoot = args.reportDir;
  await fs.mkdir(reportRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(reportRoot, "ui-run-"));
  let electronApp;
  let userDataDir;
  const errors = [];
  const startedAt = Date.now();
  const testMarker = `[YC-E2E-${new Date(startedAt).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}] ${TEST_MARKER_PREFIX}`;
  const result = {
    id: "ui-smoke",
    status: "failed",
    liveChatRequests: UI_CHAT_REQUEST_LIMIT,
    testMarker,
    inputFile: {
      fileName: inputFile.fileName,
      extension: inputFile.extension,
      sizeBytes: inputFile.sizeBytes,
      inputRoot,
      isolatedInputRoot: ownsInputRoot,
    },
    checks: {},
    durationMs: 0,
  };

  try {
    await waitForHttp(`http://127.0.0.1:${rendererPort}`);
    const electronPath = path.join(
      REPO_ROOT, "node_modules", "electron", "dist",
      process.platform === "win32" ? "electron.exe" : "electron",
    );
    await fs.access(electronPath);
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoomclaw-ui-user-data-"));
    const electronArgs = [
      `--user-data-dir=${userDataDir}`,
      "--disable-gpu",
      "--no-sandbox",
      path.join(REPO_ROOT, "apps", "desktop"),
    ];
    electronApp = await _electron.launch({
      executablePath: electronPath,
      args: electronArgs,
      env: {
        ...process.env,
        CLAW_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: "18790",
        YOOMCLAW_PROMPT_MODE: "provider",
        YOOMCLAW_AUTO_MEMORY_REVIEW: "false",
        YOOMCLAW_TOOLSETS: "coding,browser",
        YOOMCLAW_WORKSPACE: inputRoot,
        YOOMCLAW_E2E_EXPORT_DIR: path.join(runDir, "exports"),
        YOOMCLAW_E2E_LOG_DIR: path.join(runDir, "logs"),
      },
      timeout: 60_000,
    });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        errors.push(`http: ${response.status()} ${response.url()}`);
      }
    });

    await waitForHttp("http://127.0.0.1:18790/api/health", 60_000);
    await page.getByTestId("compose-bar").waitFor({ state: "visible", timeout: 60_000 });
    await waitFor("Gateway WebSocket connection", async () => {
      const input = page.getByTestId("compose-input");
      if (await input.isEnabled()) return true;
      const cta = page.getByTestId("session-empty-cta");
      if (await cta.isVisible().catch(() => false)) await cta.click();
      return input.isEnabled();
    }, 60_000);
    result.checks.sessionAndConnection = true;

    const accept = await page.locator('input[type="file"]').getAttribute("accept");
    for (const extension of ["pdf", "docx", "xlsx", "md", "png", "mp3", "mp4"]) {
      assert(accept?.toLowerCase().includes(`.${extension}`), `File input accept is missing .${extension}`);
    }
    result.checks.acceptPolicy = true;

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(inputFile.absolutePath);
    await waitFor("file selection chip", async () => (await page.getByTestId("attachment-chip").count()) === 1);
    result.checks.fileSelection = true;
    await page.getByTestId("attachment-remove").first().click();

    const bytes = Array.from(await fs.readFile(inputFile.absolutePath));
    await page.evaluate(({ name, mimeType, bytes: fileBytes }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array(fileBytes)], name, { type: mimeType }));
      const target = document.querySelector('[data-testid="compose-bar"]');
      if (!target) throw new Error("Compose bar not found for drag/drop test");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));
      }
    }, { name: inputFile.fileName, mimeType: inputFile.mimeType, bytes });
    await waitFor("drag/drop chip", async () => (await page.getByTestId("attachment-chip").count()) === 1);
    result.checks.dragAndDrop = true;
    await page.getByTestId("attachment-remove").first().click();

    const rejectedVideoSize = await page.evaluate((maxBytes) => {
      const dataTransfer = new DataTransfer();
      const file = new File(
        [new Uint8Array(maxBytes + 1)],
        "oversized-video.mp4",
        { type: "video/mp4" },
      );
      dataTransfer.items.add(file);
      const target = document.querySelector('[data-testid="compose-bar"]');
      if (!target) throw new Error("Compose bar not found for video size test");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));
      }
      return file.size;
    }, MAX_VIDEO_UPLOAD_BYTES);
    await waitFor("frontend video size rejection", async () => {
      if (await page.getByTestId("attachment-chip").count() !== 0) return false;
      const notice = page.locator(".attachment-notice");
      // The renderer intentionally presents a localized, user-facing message
      // instead of exposing the internal rejection code. Assert the stable UI
      // contract: the file is not attached and a non-empty notice is shown.
      return await notice.count() === 1 && (await notice.innerText()).trim().length > 0;
    });
    result.checks.frontendVideoSizeLimit = {
      maxBytes: MAX_VIDEO_UPLOAD_BYTES,
      rejectedSize: rejectedVideoSize,
    };

    for (let index = 0; index < MAX_FILES_PER_MESSAGE + 1; index += 1) {
      await fileInput.setInputFiles(inputFile.absolutePath);
    }
    await waitFor("10-file UI boundary", async () => (await page.getByTestId("attachment-chip").count()) === MAX_FILES_PER_MESSAGE);
    const notice = page.locator(".attachment-notice");
    assert(await notice.count() === 1 && (await notice.innerText()).trim().length > 0, "11th file was not reported as rejected");
    result.checks.tenAcceptedElevenRejected = {
      acceptedChips: await page.getByTestId("attachment-chip").count(),
      notice: (await notice.innerText()).trim(),
    };
    while (await page.getByTestId("attachment-remove").count() > 0) {
      await page.getByTestId("attachment-remove").first().click();
    }

    const prompt = [
      testMarker,
      "这是桌面端混合输入自动测试。",
      `请确认你已收到附件 ${inputFile.fileName}，只回复“收到：${inputFile.fileName}”，不要调用工具，不要返回空内容。`,
    ].join("\n");
    const emptyCta = page.getByTestId("session-empty-cta");
    if (await emptyCta.isVisible().catch(() => false)) {
      await emptyCta.click();
      await waitFor("new session creation", async () => (
        !(await emptyCta.isVisible().catch(() => false))
      ));
    }
    await fileInput.setInputFiles(inputFile.absolutePath);
    await waitFor("single attachment after file-limit boundary", async () => (
      (await page.getByTestId("attachment-chip").count()) === 1
    ));
    await page.getByTestId("compose-input").fill(prompt);
    await waitFor("send enabled for mixed input", async () => (
      await page.getByTestId("message-send").isEnabled()
    ));
    await page.getByTestId("message-send").click();
    await waitFor("completed mixed text and attachment response", async () => {
      if (await page.getByTestId("message-send").count() === 0) return false;
      const assistantText = await page.locator(".message-row.assistant").allTextContents();
      return assistantText.some((text) => text.trim().length > 0);
    }, TIMEOUT_MS);
    const bodyText = await page.locator("body").innerText();
    const assistantText = (await page.locator(".message-row.assistant").allTextContents())
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
    assert(bodyText.includes(inputFile.fileName), "Mixed-input user message did not retain the file name");
    assert(
      assistantText.includes(inputFile.fileName),
      "Mixed-input response did not semantically acknowledge the attached filename",
    );
    result.checks.mixedTextAndAttachment = {
      finalNonEmpty: true,
      fileNameVisible: true,
      semanticMention: true,
      assistantTextLength: assistantText.length,
    };
    await page.screenshot({ path: path.join(runDir, "ui-final.png"), fullPage: true });
    result.status = errors.length === 0 ? "passed" : "failed";
    result.errors = errors;
  } catch (error) {
    result.status = "failed";
    result.errors = [
      ...errors,
      error instanceof Error ? error.message : String(error),
    ];
    if (electronApp) {
      try {
        const page = await electronApp.firstWindow({ timeout: 1_000 });
        await page.screenshot({ path: path.join(runDir, "ui-failure.png"), fullPage: true });
      } catch {
        // Keep the failure report even when no window is available.
      }
    }
  } finally {
    result.durationMs = Date.now() - startedAt;
    await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      limits: { maxFilesPerMessage: MAX_FILES_PER_MESSAGE, liveChatRequests: UI_CHAT_REQUEST_LIMIT },
      result,
      rendererOutput: renderer.output,
    }, null, 2), "utf8");
    await closeElectron(electronApp);
    if (renderer.child.exitCode === null) renderer.child.kill();
    if (userDataDir && !args.keepArtifacts) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    if (ownsInputRoot && !args.keepArtifacts) await fs.rm(inputRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`UI file-input report: ${runDir}`);
  if (result.status !== "passed") process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
