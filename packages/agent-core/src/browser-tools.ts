import type { BrowserLocator, BrowserTarget, JSONSchema } from "@yoomclaw/protocol";
import { BrowserControlError } from "./browser.js";
import type { BuiltinTool, ToolOutcome } from "./tools.js";

const TARGET_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["css", "role", "text", "label", "placeholder", "testId"] },
    value: { type: "string" },
    name: { type: "string" },
    exact: { type: "boolean" },
    index: { type: "number" },
  },
  required: ["kind", "value"],
};

function ok(value: unknown): ToolOutcome {
  return { result: JSON.stringify(value, null, 2), isError: false };
}

function fail(error: unknown, fallbackCode = "BROWSER_ACTION_FAILED"): ToolOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof BrowserControlError ? error.code : fallbackCode;
  return { result: message, isError: true, code };
}

function tabId(args: Record<string, unknown>): string | undefined {
  return typeof args.tabId === "string" && args.tabId.trim() ? args.tabId.trim() : undefined;
}

function locatorArg(args: Record<string, unknown>): BrowserLocator | null {
  if (typeof args.target === "object" && args.target !== null && !Array.isArray(args.target)) {
    const target = args.target as Record<string, unknown>;
    if (
      typeof target.kind === "string"
      && typeof target.value === "string"
      && ["css", "role", "text", "label", "placeholder", "testId"].includes(target.kind)
    ) {
      return {
        kind: target.kind as BrowserTarget["kind"],
        value: target.value,
        ...(typeof target.name === "string" ? { name: target.name } : {}),
        ...(typeof target.exact === "boolean" ? { exact: target.exact } : {}),
        ...(Number.isInteger(target.index) ? { index: Number(target.index) } : {}),
      } satisfies BrowserTarget;
    }
  }
  return typeof args.selector === "string" && args.selector.trim() ? args.selector : null;
}

function locatorDescription(args: Record<string, unknown>): string {
  const target = locatorArg(args);
  return typeof target === "string"
    ? target
    : target
      ? `${target.kind}:${target.value}`
      : "unknown target";
}

function actionOptions(args: Record<string, unknown>): { tabId?: string } {
  const selected = tabId(args);
  return selected ? { tabId: selected } : {};
}

const browserTabs: BuiltinTool = {
  risk: "safe",
  definition: {
    name: "browser_tabs",
    description: "List connected browser tabs or select one tab for subsequent browser actions.",
    toolset: "browser",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "select"] },
        tabId: { type: "string" },
      },
      required: ["action"],
    },
  },
  async run(args, ctx) {
    if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
    try {
      if (args.action === "list") return ok(await ctx.browser.listTabs());
      if (args.action === "select") {
        const selected = tabId(args);
        if (!selected) return { result: "select requires tabId", isError: true, code: "BROWSER_TAB_REQUIRED" };
        return ok(await ctx.browser.selectTab(selected));
      }
      return { result: "browser_tabs action must be list or select", isError: true, code: "BROWSER_TABS_ACTION_INVALID" };
    } catch (error) {
      return fail(error, "BROWSER_TABS_FAILED");
    }
  },
};

export const BROWSER_TOOLS: BuiltinTool[] = [
  browserTabs,
  {
    risk: "safe",
    definition: {
      name: "browser_snapshot",
      description: "Read the current browser page URL, title, visible text, and accessibility snapshot.",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { tabId: { type: "string" } },
      },
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      try { return ok(await ctx.browser.snapshot(actionOptions(args))); } catch (error) { return fail(error); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_navigate",
      description: "Open an http/https page in the selected browser tab.",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, tabId: { type: "string" } },
        required: ["url"],
      },
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      const url = typeof args.url === "string" ? args.url : "";
      if (!url.trim()) return { result: "navigate requires url", isError: true, code: "BROWSER_URL_REQUIRED" };
      try { return ok(await ctx.browser.navigate(url, actionOptions(args))); } catch (error) { return fail(error, "BROWSER_NAVIGATE_FAILED"); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_click",
      description: "Click exactly one browser element using a legacy CSS selector or a semantic target.",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, target: TARGET_SCHEMA, tabId: { type: "string" } },
      },
    },
    assess(args) {
      const description = locatorDescription(args);
      return /submit|send|buy|pay|delete|remove|login|confirm|close/i.test(description)
        ? `Browser click may submit or change state: ${description}`
        : `Browser click will target ${description}.`;
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      const target = locatorArg(args);
      if (!target) return { result: "click requires selector or target", isError: true, code: "BROWSER_TARGET_REQUIRED" };
      try { return ok(await ctx.browser.click(target, actionOptions(args))); } catch (error) { return fail(error, "BROWSER_CLICK_FAILED"); }
    },
  },
  {
    risk: "confirm",
    definition: {
      name: "browser_type",
      description: "Fill exactly one non-password browser field. Input text is never written to logs or confirmation payloads.",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          target: TARGET_SCHEMA,
          text: { type: "string" },
          tabId: { type: "string" },
        },
      },
    },
    assess(args) {
      return `Browser input will be entered into ${locatorDescription(args)}.`;
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      const target = locatorArg(args);
      const text = typeof args.text === "string" ? args.text : null;
      if (!target || text === null) return { result: "type requires selector/target and text", isError: true, code: "BROWSER_TYPE_REQUIRED" };
      try { return ok(await ctx.browser.type(target, text, actionOptions(args))); } catch (error) { return fail(error, "BROWSER_TYPE_FAILED"); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_scroll",
      description: "Scroll the selected browser tab and read the updated visible state.",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down"] }, tabId: { type: "string" } },
        required: ["direction"],
      },
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      const direction = args.direction === "up" || args.direction === "down" ? args.direction : null;
      if (!direction) return { result: "scroll requires direction up or down", isError: true, code: "BROWSER_DIRECTION_REQUIRED" };
      try { return ok(await ctx.browser.scroll(direction, actionOptions(args))); } catch (error) { return fail(error, "BROWSER_SCROLL_FAILED"); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_back",
      description: "Go back in the selected browser tab.",
      toolset: "browser",
      parameters: { type: "object", properties: { tabId: { type: "string" } } },
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      try { return ok(await ctx.browser.back(actionOptions(args))); } catch (error) { return fail(error, "BROWSER_BACK_FAILED"); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_screenshot",
      description: "Save a screenshot of the selected browser tab under the agent data directory.",
      toolset: "browser",
      parameters: { type: "object", properties: { tabId: { type: "string" } } },
    },
    async run(args, ctx) {
      if (!ctx.browser) return { result: "Browser tool is unavailable", isError: true, code: "BROWSER_UNAVAILABLE" };
      try { return ok(await ctx.browser.screenshot(actionOptions(args))); } catch (error) { return fail(error, "BROWSER_SCREENSHOT_FAILED"); }
    },
  },
];
