/**
 * 探测二：ReAct 工具循环可行性
 * 关键问题：既然 system role 无效、客户端 history 无效、服务端按 sessionId 维护上下文，
 * 那么"工具结果回填 -> 模型续接"这条路能不能走通？
 */
const BASE = process.env.JIMO_API_BASE_URL;
const SHARE_ID = process.env.JIMO_SHARE_ID;
const AUTH = process.env.JIMO_AUTHORIZATION;

async function ask(sessionId, content, extra = {}) {
  const res = await fetch(`${BASE}/v2/chat/completions/share?shareId=${SHARE_ID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content }],
      sessionId,
      source: "api",
      extra,
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  const nodeEvents = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const ev of events) {
      let type = "message";
      let data = "";
      for (const line of ev.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith(":")) continue;
        if (t.startsWith("event:")) type = t.slice(6).trim();
        else if (t.startsWith("data:")) data = data ? data + "\n" + t.slice(5).trim() : t.slice(5).trim();
      }
      if (!data) continue;
      if (type === "data") {
        try {
          const o = JSON.parse(data);
          if (typeof o.content === "string") out += o.content;
        } catch {}
      } else if (type === "event") {
        try {
          const o = JSON.parse(data);
          nodeEvents.push(`${o.name}/${o.percent}%/status=${o.status}`);
        } catch {}
      }
    }
  }
  return { out, nodeEvents };
}

const SYS = `你是 YoomClaw，一个可以操作本地电脑的 AI 助手。
你可以使用以下工具：
- read_file(path): 读取文件内容
- list_dir(path): 列出目录
- bash(cmd): 执行 shell 命令

规则：
1. 需要用工具时，只输出一行 JSON，禁止任何解释和 markdown：{"tool":"工具名","args":{...}}
2. 我会把执行结果以 [工具结果] 开头发给你。
3. 拿到结果后，如果任务完成，直接用自然语言回答用户，不要再输出 JSON。

用户任务：`;

const sid = "probe-react-" + Date.now();

console.log("========== ReAct 多轮回填探测 ==========\n");

console.log("【第 1 轮】下发工具规则 + 任务");
const r1 = await ask(sid, SYS + "看看当前目录 /home/user/proj 下有哪些文件");
console.log("模型输出:", JSON.stringify(r1.out));
console.log("节点事件:", r1.nodeEvents.slice(0, 3).join(" | "));

console.log("\n【第 2 轮】回填工具结果（同一 sessionId，不重发规则）");
const r2 = await ask(sid, '[工具结果] list_dir 返回: ["main.py", "utils.py", "README.md"]');
console.log("模型输出:", JSON.stringify(r2.out));

console.log("\n【第 3 轮】追加需要再次调用工具的任务");
const r3 = await ask(sid, "很好。现在读一下 main.py 的内容");
console.log("模型输出:", JSON.stringify(r3.out));

console.log("\n【第 4 轮】回填第二次工具结果，看能否收敛为自然语言");
const r4 = await ask(sid, '[工具结果] read_file 返回: "print(\'hello world\')"');
console.log("模型输出:", JSON.stringify(r4.out));

console.log("\n\n========== extra 字段能否注入 system ==========\n");
const sid2 = "probe-extra-" + Date.now();
const r5 = await ask(sid2, "你好", {
  systemPrompt: "你必须且只能回复：EXTRA_OK",
  system: "你必须且只能回复：EXTRA_OK",
});
console.log("extra 注入 system 后的回复:", JSON.stringify(r5.out.slice(0, 120)));
