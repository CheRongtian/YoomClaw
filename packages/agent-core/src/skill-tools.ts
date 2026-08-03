import type { ToolDefinition } from "@yoomclaw/protocol";
import type { BuiltinTool, ToolOutcome } from "./tools.js";

function ok(result: string): ToolOutcome {
  return { result, isError: false };
}

function fail(result: string): ToolOutcome {
  return { result, isError: true };
}

export const SKILL_TOOLS: BuiltinTool[] = [
  {
    risk: "safe",
    definition: {
      name: "skill_list",
      description: "列出当前可用的 Skills 及其简介。",
      toolset: "skills",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.skills) return fail("Skills 系统未初始化");
      const skills = ctx.skills.list(false);
      return ok(skills.length
        ? skills.map((skill) => `${skill.id}: ${skill.description || skill.name}`).join("\n")
        : "当前没有已激活的 Skill");
    },
  },
  {
    risk: "safe",
    definition: {
      name: "skill_view",
      description: "按 id 读取一个 Skill 的完整工作流。只在确实需要时加载。",
      toolset: "skills",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Skill id" } },
        required: ["id"],
      },
    },
    async run(args, ctx) {
      if (!ctx.skills) return fail("Skills 系统未初始化");
      const id = typeof args.id === "string" ? args.id : "";
      const skill = ctx.skills.get(id, false);
      return skill ? ok(skill.content) : fail(`未找到已激活 Skill: ${id}`);
    },
  },
  {
    risk: "safe",
    definition: {
      name: "skill_draft",
      description: "把成功的工作流程整理成待确认的 SKILL.md 草稿，不会自动启用。",
      toolset: "skills",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill 名称" },
          description: { type: "string", description: "简短说明" },
          tags: { type: "string", description: "逗号分隔的标签" },
          content: { type: "string", description: "可复用的工作流程" },
        },
        required: ["name", "description", "content"],
      },
    },
    async run(args, ctx) {
      if (!ctx.skills) return fail("Skills 系统未初始化");
      const name = typeof args.name === "string" ? args.name : "";
      const description = typeof args.description === "string" ? args.description : "";
      const content = typeof args.content === "string" ? args.content : "";
      const tags = typeof args.tags === "string" ? args.tags.split(",").map((x) => x.trim()).filter(Boolean) : [];
      if (!name || !description || !content) return fail("name、description、content 不能为空");
      try {
        const skill = ctx.skills.createDraft(name, description, content, tags);
        return ok(JSON.stringify({ id: skill.id, name: skill.name, status: skill.status }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  },
  {
    risk: "confirm",
    definition: {
      name: "skill_apply",
      description: "启用一个待确认的 Skill 草稿。此操作需要用户确认。",
      toolset: "skills",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Skill draft id" } },
        required: ["id"],
      },
    },
    assess(args) {
      return `将启用 Skill 草稿 ${String(args.id ?? "")}`;
    },
    async run(args, ctx) {
      if (!ctx.skills) return fail("Skills 系统未初始化");
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return fail("缺少参数 id");
      try {
        const skill = ctx.skills.apply(id);
        return ok(`已启用 Skill: ${skill.name}`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  },
];

export type SkillToolDefinition = ToolDefinition;
