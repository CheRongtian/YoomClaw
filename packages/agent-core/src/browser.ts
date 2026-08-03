import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserStatus } from "@yoomclaw/protocol";
import type { BrowserToolController } from "./tools.js";

const MAX_SNAPSHOT_CHARS = 12_000;

export class ChromeCdpController implements BrowserToolController {
  private browser: Browser | null = null;
  private cdpUrl = "http://127.0.0.1:9222";
  private readonly screenshotDir: string;
  private readonly connectionFile: string;
  private lastError = "";

  constructor(private readonly dataDir: string, cdpUrl?: string) {
    this.connectionFile = path.join(dataDir, "browser", "connection.json");
    this.cdpUrl = cdpUrl || this.readSavedCdpUrl() || this.cdpUrl;
    this.screenshotDir = path.join(dataDir, "browser");
    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  async connect(cdpUrl = this.cdpUrl): Promise<void> {
    this.cdpUrl = cdpUrl;
    if (this.browser) return;
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.lastError = "";
      this.persistConnection(true);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.persistConnection(false);
      throw new Error(`无法连接 Chrome CDP ${cdpUrl}: ${this.lastError}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.browser) return;
    // Playwright's CDP Browser type does not expose a public disconnect method.
    // Drop our handle without closing the user's Chrome process.
    this.browser = null;
    this.persistConnection(false);
  }

  status(): BrowserStatus {
    const page = this.currentPageOrNull();
    return {
      connected: Boolean(this.browser),
      cdpUrl: this.cdpUrl,
      pageUrl: page?.url(),
      title: page ? undefined : undefined,
      message: this.lastError || undefined,
    };
  }

  async snapshot(): Promise<{ url: string; title: string; text: string }> {
    const page = await this.requirePage();
    return this.readPage(page);
  }

  async navigate(url: string): Promise<{ url: string; title: string; text: string }> {
    if (!/^https?:\/\//i.test(url)) throw new Error("浏览器只允许访问 http/https URL");
    const page = await this.requirePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.readPage(page);
  }

  async click(selector: string): Promise<{ url: string; title: string; text: string }> {
    const page = await this.requirePage();
    await page.locator(selector).first().click({ timeout: 15_000 });
    return this.readPage(page);
  }

  async type(selector: string, text: string): Promise<{ url: string; title: string; text: string }> {
    const page = await this.requirePage();
    await page.locator(selector).first().fill(text, { timeout: 15_000 });
    return this.readPage(page);
  }

  async scroll(direction: "up" | "down"): Promise<{ url: string; title: string; text: string }> {
    const page = await this.requirePage();
    await page.evaluate(
      (delta) => (globalThis as unknown as { scrollBy?: (x: number, y: number) => void }).scrollBy?.(0, delta),
      direction === "down" ? 720 : -720,
    );
    return this.readPage(page);
  }

  async back(): Promise<{ url: string; title: string; text: string }> {
    const page = await this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    return this.readPage(page);
  }

  async screenshot(): Promise<{ url: string; title: string; path?: string }> {
    const page = await this.requirePage();
    const file = path.join(this.screenshotDir, `screenshot-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return { url: page.url(), title: await page.title().catch(() => ""), path: file };
  }

  private async requirePage(): Promise<Page> {
    if (!this.browser) {
      throw new Error(`浏览器未连接。请先启动带 remote-debugging-port 的 Chrome（${this.cdpUrl}）`);
    }
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Chrome CDP 没有可用的浏览器上下文");
    const page = context.pages()[0] ?? (await context.newPage());
    return page;
  }

  private currentPageOrNull(): Page | null {
    return this.browser?.contexts()[0]?.pages()[0] ?? null;
  }

  private readSavedCdpUrl(): string | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.connectionFile, "utf8")) as { cdpUrl?: unknown };
      return typeof raw.cdpUrl === "string" && raw.cdpUrl.trim() ? raw.cdpUrl : undefined;
    } catch {
      return undefined;
    }
  }

  private persistConnection(connected: boolean): void {
    try {
      fs.mkdirSync(path.dirname(this.connectionFile), { recursive: true });
      fs.writeFileSync(this.connectionFile, JSON.stringify({
        cdpUrl: this.cdpUrl,
        connected,
        updatedAt: Date.now(),
      }, null, 2), "utf8");
    } catch {
      // Browser persistence must never prevent ordinary chat tasks.
    }
  }

  private async readPage(page: Page): Promise<{ url: string; title: string; text: string }> {
    const [title, bodyText] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    ]);
    return {
      url: page.url(),
      title,
      text: bodyText.length > MAX_SNAPSHOT_CHARS
        ? `${bodyText.slice(0, MAX_SNAPSHOT_CHARS)}\n\n[页面内容已截断]`
        : bodyText,
    };
  }
}
