/**
 * 端到端冒烟测试：用真实 JimoAI API 跑一遍新的 ReAct Agent。
 * 凭证从环境变量读取（由 run-smoke 注入），不写死在源码里。
 */
import { Agent, SessionStore, BUILTIN_TOOLS } from "@yoomclaw/agent-core";
import { createProvider } from "@yoomclaw/llm-provider";

const SHARE_ID = process.env.JIMO_SHARE_ID ?? "";
const AUTH = process.env.JIMO_AUTHORIZATION ?? "";
const BASE =
  process.env.JIMO_API_BASE_URL ?? "https://jimoai-bot-api.xiaohuodui.cn";

if (!SHARE_ID || !AUTH) {
  console.error("缺少凭证：请设置 JIMO_SHARE_ID / JIMO_AUTHORIZATION");
  process.exit(1);
}

const provider = createProvider("jimo", {
  baseUrl: BASE,
  shareId: SHARE_ID,
  authorization: AUTH,
});

const sessions = new SessionStore();
const agent = new Agent(
  { provider: "jimo", model: "jimo-default" },
  provider,
  sessions,
  BUILTIN_TOOLS,
  process.cwd(),
);

const session = sessions.create("smoke-test");

async function runQuery(label: string, text: string): Promise<void> {
  console.log(`\n========== ${label} ==========`);
  console.log(`用户: ${text}`);
  let toolCalls = 0;
  let confirms = 0;
  try {
    for await (const ev of agent.run(session.id, text, {
      confirm: async (req) => {
        confirms++;
        console.log(`  [确认] ${req.name} — ${req.reason}`);
        return true; // 测试中自动放行
      },
    })) {
      switch (ev.type) {
        case "delta":
          process.stdout.write(ev.text);
          break;
        case "progress":
          console.log(`\n  [进度] ${ev.name} (${ev.percent}%)`);
          break;
        case "tool_start":
          toolCalls++;
          console.log(`\n  [工具开始] ${ev.name} ${JSON.stringify(ev.args)}`);
          break;
        case "tool_end":
          console.log(
            `  [工具结束] ${ev.name} (${ev.durationMs}ms, ${ev.isError ? "失败" : "成功"})`,
          );
          console.log(`    结果: ${ev.result.slice(0, 200)}`);
          break;
        case "final":
          console.log(`\n[最终回答] ${ev.text.slice(0, 400)}`);
          break;
        case "error":
          console.log(`\n[错误] ${ev.message}`);
          break;
        case "tool_confirm":
          // 已在 confirm 回调里打印
          break;
      }
    }
  } catch (err) {
    console.error("[run 抛异常]", err);
  }
  console.log(`\n--- ${label} 统计: 工具调用=${toolCalls}, 确认=${confirms}`);
}

await runQuery("SAFE 工具", "请列出当前工作目录下的文件和子目录（使用 list_dir 工具）");
await runQuery("时间工具", "现在服务器时间是几点？请用 get_time 工具获取后告诉我");
await runQuery(
  "CONFIRM 工具",
  "请用 bash 工具执行命令 `echo hello-claw` 并把结果告诉我",
);

console.log("\n========== 冒烟测试结束 ==========");
process.exit(0);
