import type { ToolDefinition } from "@yoomclaw/protocol";
import type { BuiltinTool, ToolOutcome } from "./tools.js";
import type { MemoryStoreName } from "./config.js";

const memorySchema: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    store: { type: "string", enum: ["memory", "user"], description: "memory 或 user" },
    content: { type: "string", description: "要保存的稳定事实，不能包含凭证" },
  },
  required: ["store", "content"],
};

function storeName(value: unknown): MemoryStoreName | null {
  return value === "memory" || value === "user" ? value : null;
}

function ok(result: string): ToolOutcome {
  return { result, isError: false };
}

function fail(result: string): ToolOutcome {
  return { result, isError: true };
}

export const MEMORY_TOOLS: BuiltinTool[] = [
  {
    risk: "safe",
    definition: {
      name: "memory_search",
      description: "搜索当前保存的长期记忆和用户偏好。",
      toolset: "memory",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
      },
    },
    async run(args, ctx) {
      if (!ctx.memory) return fail("记忆系统未初始化");
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      if (!query) return fail("缺少参数 query");
      const matches: string[] = [];
      for (const store of ["memory", "user"] as const) {
        for (const line of ctx.memory.read(store).split("\n")) {
          if (line.toLowerCase().includes(query)) matches.push(`[${store}] ${line}`);
        }
      }
      return ok(matches.length ? matches.join("\n") : "没有找到匹配的记忆");
    },
  },
  {
    risk: "safe",
    definition: {
      name: "memory_save",
      description: "保存一条稳定、长期有用的事实或用户偏好。不要保存密码、token、Cookie 或私钥。",
      toolset: "memory",
      parameters: memorySchema,
    },
    async run(args, ctx) {
      if (!ctx.memory) return fail("记忆系统未初始化");
      const store = storeName(args.store);
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!store || !content) return fail("store 必须是 memory/user，且 content 不能为空");
      try {
        ctx.memory.append(store, content);
        return ok(`已保存到 ${store} 记忆`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "memory_replace",
      description: "用整理后的完整内容替换一个记忆文件。",
      toolset: "memory",
      parameters: memorySchema,
    },
    async run(args, ctx) {
      if (!ctx.memory) return fail("记忆系统未初始化");
      const store = storeName(args.store);
      const content = typeof args.content === "string" ? args.content : "";
      if (!store) return fail("store 必须是 memory/user");
      try {
        ctx.memory.replace(store, content);
        return ok(`已更新 ${store} 记忆`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  },
  {
    risk: "safe",
    definition: {
      name: "memory_delete",
      description: "删除包含指定文字的记忆条目。",
      toolset: "memory",
      parameters: {
        type: "object",
        properties: {
          store: { type: "string", enum: ["memory", "user"], description: "memory 或 user" },
          contains: { type: "string", description: "要删除的条目关键词" },
        },
        required: ["store", "contains"],
      },
    },
    async run(args, ctx) {
      if (!ctx.memory) return fail("记忆系统未初始化");
      const store = storeName(args.store);
      const contains = typeof args.contains === "string" ? args.contains : "";
      if (!store || !contains) return fail("参数不完整");
      return ctx.memory.remove(store, contains)
        ? ok(`已从 ${store} 记忆删除匹配条目`)
        : ok("没有找到匹配的记忆条目");
    },
  },
];
