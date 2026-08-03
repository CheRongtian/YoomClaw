import type { BuiltinTool, ToolOutcome } from "./tools.js";

function ok(value: unknown): ToolOutcome {
  return { result: JSON.stringify(value, null, 2), isError: false };
}

function fail(err: unknown): ToolOutcome {
  return { result: err instanceof Error ? err.message : String(err), isError: true };
}

export const BROWSER_TOOLS: BuiltinTool[] = [
  {
    risk: "safe",
    definition: {
      name: "browser_snapshot",
      description: "读取当前 Chrome 页面地址、标题和可见文本。",
      toolset: "browser",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.snapshot()); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_navigate",
      description: "打开一个 http/https 网页。",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "完整网页 URL" } },
        required: ["url"],
      },
    },
    async run(args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.navigate(String(args.url ?? ""))); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_click",
      description: "点击当前网页中的 CSS selector。提交、发送、购买等动作需要先确认。",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { selector: { type: "string", description: "CSS selector" } },
        required: ["selector"],
      },
    },
    assess(args) {
      const selector = String(args.selector ?? "");
      return /submit|send|buy|pay|delete|remove|login/i.test(selector)
        ? `点击可能提交或改变网页状态：${selector}`
        : null;
    },
    async run(args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.click(String(args.selector ?? ""))); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "confirm",
    definition: {
      name: "browser_type",
      description: "在网页输入框中输入文本。密码或敏感信息禁止自动输入。",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          text: { type: "string", description: "输入文本" },
        },
        required: ["selector", "text"],
      },
    },
    assess(args) {
      return `即将在网页元素 ${String(args.selector ?? "")} 中输入内容，需要确认`;
    },
    async run(args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.type(String(args.selector ?? ""), String(args.text ?? ""))); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_scroll",
      description: "向上或向下滚动网页并读取新的可见文本。",
      toolset: "browser",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down"], description: "方向" } },
        required: ["direction"],
      },
    },
    async run(args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      const direction = args.direction === "up" ? "up" : "down";
      try { return ok(await ctx.browser.scroll(direction)); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_back",
      description: "返回当前页面的上一页。",
      toolset: "browser",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.back()); } catch (err) { return fail(err); }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "browser_screenshot",
      description: "保存当前 Chrome 页面截图到本地 Agent 数据目录。",
      toolset: "browser",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.browser) return fail("浏览器工具未初始化");
      try { return ok(await ctx.browser.screenshot()); } catch (err) { return fail(err); }
    },
  },
];
