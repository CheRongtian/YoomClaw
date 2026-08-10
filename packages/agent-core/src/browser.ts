import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type {
  BrowserActionOptions,
  BrowserLocator,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserStatus,
  BrowserTab,
  BrowserTarget,
} from "@yoomclaw/protocol";
import type { BrowserToolController } from "./tools.js";

const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_ARIA_CHARS = 20_000;
const ACTION_TIMEOUT_MS = 15_000;

export class BrowserControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BrowserControlError";
  }
}

export class ChromeCdpController implements BrowserToolController {
  private browser: Browser | null = null;
  private cdpUrl = "http://127.0.0.1:9222";
  private readonly screenshotDir: string;
  private readonly connectionFile: string;
  private readonly pageIds = new Map<Page, string>();
  private nextTabNumber = 1;
  private selectedTabId: string | undefined;
  private lastTitle = "";
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
      // Keep the existing browser's context untouched when attaching to a
      // user's explicitly supplied CDP endpoint.
      this.browser = await chromium.connectOverCDP(cdpUrl, { noDefaults: true });
      this.pageIds.clear();
      this.selectedTabId = undefined;
      this.lastTitle = "";
      this.lastError = "";
      const context = this.browser.contexts()[0];
      const page = context?.pages()[0];
      if (page) {
        this.selectedTabId = this.getTabId(page);
        this.lastTitle = await page.title().catch(() => "");
      }
      this.persistConnection(true);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.persistConnection(false);
      throw new BrowserControlError(
        `Unable to connect to Chrome CDP ${cdpUrl}: ${this.lastError}`,
        "BROWSER_CDP_CONNECT_FAILED",
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.browser) return;
    // Do not close the user's Chrome process. Dropping the Playwright handle
    // is the supported way for this controller to detach from CDP.
    this.browser = null;
    this.pageIds.clear();
    this.selectedTabId = undefined;
    this.lastTitle = "";
    this.persistConnection(false);
  }

  status(): BrowserStatus {
    const page = this.currentPageOrNull();
    return {
      connected: Boolean(this.browser),
      cdpUrl: this.cdpUrl,
      pageUrl: page?.url(),
      title: this.lastTitle || undefined,
      activeTabId: this.selectedTabId,
      message: this.lastError || undefined,
    };
  }

  async listTabs(): Promise<BrowserTab[]> {
    const context = this.requireContext();
    const pages = context.pages();
    const activePage = this.currentPageOrNull() ?? pages[0];
    if (activePage && !this.selectedTabId) this.selectedTabId = this.getTabId(activePage);
    return Promise.all(pages.map(async (page) => ({
      id: this.getTabId(page),
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: page === activePage,
    })));
  }

  async selectTab(tabId: string): Promise<BrowserTab> {
    const context = this.requireContext();
    const page = this.findPageById(context, tabId);
    if (!page) throw new BrowserControlError(`Browser tab not found: ${tabId}`, "BROWSER_TAB_NOT_FOUND");
    this.selectedTabId = tabId;
    this.lastTitle = await page.title().catch(() => "");
    return {
      id: tabId,
      url: page.url(),
      title: this.lastTitle,
      active: true,
    };
  }

  async snapshot(options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    const page = this.requirePage(options);
    return this.readPage(page);
  }

  async navigate(url: string, options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    if (!/^https?:\/\//i.test(url)) {
      throw new BrowserControlError("Only http/https URLs are allowed", "BROWSER_URL_INVALID");
    }
    const page = this.requirePage(options);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.readPage(page);
  }

  async click(target: BrowserLocator, options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    const page = this.requirePage(options);
    const locator = await this.resolveTarget(page, target);
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
    return this.readPage(page);
  }

  async type(target: BrowserLocator, text: string, options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    const page = this.requirePage(options);
    const locator = await this.resolveTarget(page, target);
    const sensitive = await locator.evaluate((element) => {
      const input = element as unknown as { getAttribute(name: string): string | null };
      const type = input.getAttribute("type")?.toLowerCase();
      const autocomplete = input.getAttribute("autocomplete")?.toLowerCase() ?? "";
      return type === "password" || autocomplete.includes("password");
    }).catch(() => false);
    if (sensitive) throw new BrowserControlError("Password fields cannot be automated", "BROWSER_SENSITIVE_INPUT_BLOCKED");
    await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
    return this.readPage(page);
  }

  async scroll(direction: "up" | "down", options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    const page = this.requirePage(options);
    await page.evaluate(
      (delta) => (globalThis as unknown as { scrollBy?: (x: number, y: number) => void }).scrollBy?.(0, delta),
      direction === "down" ? 720 : -720,
    );
    return this.readPage(page);
  }

  async back(options?: BrowserActionOptions): Promise<BrowserSnapshot> {
    const page = this.requirePage(options);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    return this.readPage(page);
  }

  async screenshot(options?: BrowserActionOptions): Promise<BrowserScreenshot> {
    const page = this.requirePage(options);
    const file = path.join(this.screenshotDir, `screenshot-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const title = await page.title().catch(() => "");
    this.lastTitle = title;
    return {
      url: page.url(),
      title,
      path: file,
      tabId: this.getTabId(page),
    };
  }

  private requireContext(): BrowserContext {
    if (!this.browser) {
      throw new BrowserControlError(
        `Browser is not connected. Start Chrome with remote-debugging-port (${this.cdpUrl}) first.`,
        "BROWSER_UNAVAILABLE",
      );
    }
    const context = this.browser.contexts()[0];
    if (!context) throw new BrowserControlError("Chrome CDP has no usable browser context", "BROWSER_CONTEXT_UNAVAILABLE");
    return context;
  }

  private requirePage(options?: BrowserActionOptions): Page {
    const context = this.requireContext();
    if (options?.tabId) {
      const page = this.findPageById(context, options.tabId);
      if (!page) throw new BrowserControlError(`Browser tab not found: ${options.tabId}`, "BROWSER_TAB_NOT_FOUND");
      this.selectedTabId = options.tabId;
      return page;
    }
    const selected = this.selectedTabId ? this.findPageById(context, this.selectedTabId) : undefined;
    const page = selected ?? context.pages()[0];
    if (page) {
      this.selectedTabId = this.getTabId(page);
      return page;
    }
    const created = context.pages().length === 0 ? undefined : context.pages()[0];
    if (created) {
      this.selectedTabId = this.getTabId(created);
      return created;
    }
    throw new BrowserControlError("Chrome CDP has no open tabs", "BROWSER_NO_TABS");
  }

  private currentPageOrNull(): Page | null {
    if (!this.browser) return null;
    const context = this.browser.contexts()[0];
    if (!context) return null;
    if (this.selectedTabId) {
      const selected = this.findPageById(context, this.selectedTabId);
      if (selected) return selected;
    }
    return context.pages()[0] ?? null;
  }

  private getTabId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `tab-${this.nextTabNumber++}`;
    this.pageIds.set(page, id);
    page.once("close", () => {
      this.pageIds.delete(page);
      if (this.selectedTabId === id) this.selectedTabId = undefined;
    });
    return id;
  }

  private findPageById(context: BrowserContext, tabId: string): Page | undefined {
    return context.pages().find((page) => this.getTabId(page) === tabId);
  }

  private async resolveTarget(page: Page, target: BrowserLocator): Promise<Locator> {
    const locator = typeof target === "string"
      ? page.locator(target)
      : this.locatorFromTarget(page, target);
    try {
      await locator.first().waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
    } catch {
      // Count below provides the stable machine-readable error.
    }
    const count = await locator.count();
    if (count === 0) throw new BrowserControlError("Browser target matched no elements", "BROWSER_TARGET_NOT_FOUND");
    if (typeof target !== "string" && target.index !== undefined) {
      if (!Number.isInteger(target.index) || target.index < 0 || target.index >= count) {
        throw new BrowserControlError(`Browser target index is out of range: ${target.index}`, "BROWSER_TARGET_INDEX_INVALID");
      }
      return locator.nth(target.index);
    }
    if (count !== 1) {
      throw new BrowserControlError(
        `Browser target is ambiguous (${count} elements matched)`,
        "BROWSER_TARGET_AMBIGUOUS",
      );
    }
    return locator.first();
  }

  private locatorFromTarget(page: Page, target: BrowserTarget): Locator {
    if (!target.value?.trim()) throw new BrowserControlError("Browser target value is required", "BROWSER_TARGET_REQUIRED");
    const exact = target.exact ?? true;
    switch (target.kind) {
      case "css":
        return page.locator(target.value);
      case "role":
        return page.getByRole(target.value as never, {
          ...(target.name ? { name: target.name } : {}),
          exact,
        });
      case "text":
        return page.getByText(target.value, { exact });
      case "label":
        return page.getByLabel(target.value, { exact });
      case "placeholder":
        return page.getByPlaceholder(target.value, { exact });
      case "testId":
        return page.getByTestId(target.value);
      default:
        throw new BrowserControlError(`Unsupported browser target kind: ${String((target as { kind?: unknown }).kind)}`, "BROWSER_TARGET_KIND_INVALID");
    }
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

  private async readPage(page: Page): Promise<BrowserSnapshot> {
    const [title, bodyText] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    ]);
    this.selectedTabId = this.getTabId(page);
    this.lastTitle = title;
    const body = bodyText.length > MAX_SNAPSHOT_CHARS
      ? `${bodyText.slice(0, MAX_SNAPSHOT_CHARS)}\n\n[page text truncated]`
      : bodyText;
    const bodyLocator = page.locator("body") as Locator & { ariaSnapshot?: () => Promise<string> };
    const aria = typeof bodyLocator.ariaSnapshot === "function"
      ? await bodyLocator.ariaSnapshot().catch(() => "")
      : "";
    return {
      url: page.url(),
      title,
      text: body,
      ...(aria ? { aria: aria.slice(0, MAX_ARIA_CHARS) } : {}),
      tabId: this.selectedTabId,
    };
  }
}
