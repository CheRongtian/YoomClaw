import type { ToolDefinition } from "@yoomclaw/protocol";
import type { BuiltinTool, ToolContext, ToolOutcome } from "./tools.js";

/** A small registry keeps tool discovery independent from the ReAct engine. */
export interface ToolRegistry {
  register(tool: BuiltinTool): void;
  list(toolsets?: string[]): ToolDefinition[];
  get(name: string): BuiltinTool | undefined;
  execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome>;
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, BuiltinTool>();

  constructor(tools: BuiltinTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: BuiltinTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  list(toolsets?: string[]): ToolDefinition[] {
    const allowed = toolsets ? new Set(toolsets) : undefined;
    return [...this.tools.values()]
      .filter((tool) => !allowed || allowed.has(tool.definition.toolset ?? "coding"))
      .map((tool) => tool.definition);
  }

  get(name: string): BuiltinTool | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    const tool = this.get(name);
    if (!tool) return { result: `Unknown tool: ${name}`, isError: true };
    try {
      return await tool.run(args, context);
    } catch (error) {
      return {
        result: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}
