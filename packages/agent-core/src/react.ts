/**
 * ReAct 循环的两个核心零件：规则 prompt 构建 + 工具调用解析。
 *
 * 背景：积墨 API 不支持原生 function calling，也不接受 system role
 * （已实测：传 tools 字段被忽略，模型会幻觉；传 system 消息完全无效）。
 * 因此工具协议只能靠 user 消息正文里的规则来约定，并自行解析模型输出。
 */

import type { SafetyMode, ToolDefinition } from "@yoomclaw/protocol";

/** 工具规则前缀，用于识别一条消息是否为注入过规则的首轮。 */
export const RULE_MARKER = "## 你的工具能力";

/** Describe the active permission policy so the model does not fall back to the default workspace-only assumption. */
export function buildSafetyPrompt(mode: SafetyMode = "workspace-auto"): string {
  const fileOperationRule = "当用户要求创建、修改或生成文件（尤其是要求在指定目录制作小游戏）时，必须实际调用 write_file、edit_file 或其他合适的文件工具完成写入；不要把完整源码直接作为最终回复。用户提供的本地目录路径应作为目标目录，路径包含空格或中文时也必须完整放入工具参数。";
  const context = (label: string, details: string) => `## 运行时权限上下文（由客户端注入）

当前权限模式：${mode}
当前权限名称：${label}

${details}

${fileOperationRule}`;
  if (mode === "full-access") {
    return context("完全访问权限", "当前会话已明确授予完全访问权限。你可以使用工具读取、写入、编辑和删除工作区内外的任何文件，也可以执行互联网和系统命令。不要因为目标路径位于工作区外而拒绝用户请求；请实际调用合适的工具完成任务。这里的完全访问是应用层权限，仍受当前操作系统用户权限、文件锁和工具执行结果影响。只执行用户明确要求的操作，不要泄露密码、Token、Cookie、私钥或其他敏感凭证。");
  }
  if (mode === "confirm") {
    return context("请求批准", "编辑外部文件和使用互联网时始终请求用户批准；需要风险确认的工具调用必须先输出工具调用，等待工具结果，不要仅口头拒绝。工作区外路径必须遵循客户端确认结果。");
  }
  return context("工作区自动", "工作区内的读取、搜索、普通写入和编辑可以自动执行；仅对检测到的风险操作请求用户批准。工作区外路径、删除文件、网页输入或提交等操作属于风险操作。");
}

/**
 * 构建工具规则 prompt。
 *
 * 只在会话首轮下发一次 —— 积墨服务端按 sessionId 维护上下文，
 * 实测第 3 轮不重发规则，模型仍然遵守 JSON 输出约定。
 */
export function buildToolPrompt(tools: ToolDefinition[]): string {
  const list = tools
    .map((t) => {
      const props = t.parameters.properties ?? {};
      const required = new Set(t.parameters.required ?? []);
      const params = Object.entries(props)
        .map(([k, v]) => {
          const mark = required.has(k) ? "" : "?";
          return `${k}${mark}: ${v.description ?? v.type ?? "any"}`;
        })
        .join(", ");
      return `- ${t.name}(${params})\n  ${t.description}`;
    })
    .join("\n");

  return `${RULE_MARKER}

你是 YoomClaw，一个能操作用户本地电脑的 AI 助手。你可以使用下列工具：

${list}

## 调用规则（必须严格遵守）

1. 需要使用工具时，**只输出一行 JSON，不要任何解释文字，不要 markdown 代码块**：
   {"tool":"工具名","args":{"参数名":"参数值"}}

2. 我会执行工具并把结果以 [工具结果] 开头发回给你。

3. 拿到结果后：
   - 若还需要继续调用工具，再输出一行 JSON；
   - 若任务已完成，用自然语言回答用户，此时**不要输出 JSON**。

4. 一次只调用一个工具。不要臆造工具执行结果 —— 你没有真正执行过工具，
   在拿到 [工具结果] 之前不要假设任何输出内容。

5. 不需要用工具就能回答的问题（闲聊、常识、解释概念），直接正常回答即可。

## 用户任务

`;
}

/** 工具结果回填消息的前缀。 */
export function buildToolResultPrompt(
  toolName: string,
  result: string,
  isError: boolean,
): string {
  const tag = isError ? "工具错误" : "工具结果";
  return `[${tag}] ${toolName} 返回：\n${result}`;
}

export interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 从模型输出里提取工具调用。
 *
 * 必须容错：ReAct 靠模型自觉，实测虽然稳定输出纯 JSON，
 * 但仍可能出现 markdown 包裹、前后带说明文字等情况。
 * 解析不出来不算错误 —— 说明模型是在正常回答，交给上层当自然语言处理。
 */
export function parseToolCall(
  text: string,
  knownTools: Set<string>,
  allowDynamicTool?: (name: string) => boolean,
): ParsedToolCall | null {
  const raw = text.trim();
  if (!raw) return null;

  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const tool = obj.tool ?? obj.name ?? obj.tool_name;
      if (typeof tool !== "string" || (!knownTools.has(tool) && !allowDynamicTool?.(tool))) continue;

      const rawArgs = obj.args ?? obj.arguments ?? obj.parameters ?? {};
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};

      return { tool, args };
    } catch {
      // 换下一个候选
    }
  }

  return null;
}

/**
 * 从文本中挑出可能是 JSON 的片段。
 * 按可信度排序：整段 → 代码块内 → 首个平衡括号对。
 */
function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];

  if (text.startsWith("{") && text.endsWith("}")) {
    out.push(text);
  }

  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) {
    out.push(fence[1].trim());
  }

  const balanced = findBalancedObject(text);
  if (balanced) out.push(balanced);

  return out;
}

/** 扫描出第一个括号平衡的 JSON 对象，跳过字符串内的括号。 */
function findBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** 为一次工具调用生成去重指纹，用于检测模型原地打转。 */
export function callFingerprint(call: ParsedToolCall): string {
  const keys = Object.keys(call.args).sort();
  const norm = keys.map((k) => `${k}=${JSON.stringify(call.args[k])}`).join("&");
  return `${call.tool}(${norm})`;
}
