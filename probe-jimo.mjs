/**
 * 积墨 API 能力探测
 * 用途：判断能否支撑 agent 工具循环
 * 运行：node --env-file=.env probe-jimo.mjs
 */
const BASE = process.env.JIMO_API_BASE_URL;
const SHARE_ID = process.env.JIMO_SHARE_ID;
const AUTH = process.env.JIMO_AUTHORIZATION;

if (!SHARE_ID || !AUTH) {
  console.error("缺少 JIMO_SHARE_ID / JIMO_AUTHORIZATION");
  process.exit(1);
}

async function call(label, payload, { raw = false } = {}) {
  const url = `${BASE}/v2/chat/completions/share?shareId=${SHARE_ID}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { label, ok: false, status: res.status, body: text.slice(0, 300) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let chunks = 0;
  let firstAt = null;
  const rawEvents = [];
  const seenEventTypes = new Set();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (raw && rawEvents.length < 6) rawEvents.push(text);
    buffer += text;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const ev of events) {
      let type = "message";
      let data = "";
      for (const line of ev.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("event:")) type = t.slice(6).trim();
        else if (t.startsWith("data:")) data = data ? data + "\n" + t.slice(5).trim() : t.slice(5).trim();
      }
      if (!data) continue;
      seenEventTypes.add(type);
      if (type === "data") {
        chunks++;
        if (firstAt === null) firstAt = Date.now() - t0;
        try {
          const o = JSON.parse(data);
          if (typeof o.content === "string") content += o.content;
          if (o.tool_calls || o.function_call) {
            seenEventTypes.add("HAS_TOOL_CALL_FIELD");
          }
        } catch {}
      }
    }
  }

  return {
    label,
    ok: true,
    status: res.status,
    chunks,
    firstChunkMs: firstAt,
    totalMs: Date.now() - t0,
    eventTypes: [...seenEventTypes],
    content,
    rawSample: raw ? rawEvents.join("") : undefined,
  };
}

const results = [];

// 探测 1: 基线 + 原始 SSE 形态
results.push(
  await call(
    "1. 基线调用",
    {
      messages: [{ role: "user", content: "只回复两个字：收到" }],
      sessionId: "probe-baseline-" + Date.now(),
      source: "api",
      extra: {},
    },
    { raw: true },
  ),
);

// 探测 2: 是否接受 OpenAI 风格 tools 字段
results.push(
  await call("2. tools 字段", {
    messages: [{ role: "user", content: "现在北京几点？请调用工具查询。" }],
    sessionId: "probe-tools-" + Date.now(),
    source: "api",
    extra: {},
    tools: [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "获取当前时间",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: "auto",
  }),
);

// 探测 3: system role 是否生效
results.push(
  await call("3. system role", {
    messages: [
      { role: "system", content: "你必须且只能回复固定字符串：SYSTEM_OK" },
      { role: "user", content: "你好" },
    ],
    sessionId: "probe-system-" + Date.now(),
    source: "api",
    extra: {},
  }),
);

// 探测 4: 服务端是否用 sessionId 维护历史（同一 sessionId 二次提问，不带历史）
const sharedSid = "probe-memory-" + Date.now();
await call("4a. 预热", {
  messages: [{ role: "user", content: "请记住数字 8341，回复 OK 即可" }],
  sessionId: sharedSid,
  source: "api",
  extra: {},
});
results.push(
  await call("4b. 服务端记忆", {
    messages: [{ role: "user", content: "我刚才让你记的数字是多少？直接说数字。" }],
    sessionId: sharedSid,
    source: "api",
    extra: {},
  }),
);

// 探测 5: 多轮历史是否被采纳（客户端传完整 history）
results.push(
  await call("5. 客户端历史", {
    messages: [
      { role: "user", content: "请记住数字 5279" },
      { role: "assistant", content: "好的，我记住了 5279。" },
      { role: "user", content: "我让你记的数字是多少？直接说数字。" },
    ],
    sessionId: "probe-history-" + Date.now(),
    source: "api",
    extra: {},
  }),
);

// 探测 6: 结构化输出稳定性（ReAct 方案的可行性关键）
results.push(
  await call("6. JSON 指令遵循", {
    messages: [
      {
        role: "user",
        content:
          '你是一个工具调用器。仅输出一行 JSON，不要任何解释、不要 markdown 代码块。格式：{"tool":"工具名","args":{}}。可用工具：read_file(path)。现在请读取 /etc/hosts 文件。',
      },
    ],
    sessionId: "probe-json-" + Date.now(),
    source: "api",
    extra: {},
  }),
);

console.log("\n============ 积墨 API 能力探测结果 ============\n");
for (const r of results) {
  console.log(`--- ${r.label} ---`);
  if (!r.ok) {
    console.log(`  HTTP ${r.status}  ${r.body}`);
    console.log();
    continue;
  }
  console.log(`  状态: ${r.status} | chunks: ${r.chunks} | 首字: ${r.firstChunkMs}ms | 总耗时: ${r.totalMs}ms`);
  console.log(`  事件类型: ${r.eventTypes.join(", ")}`);
  console.log(`  回复: ${JSON.stringify(r.content.slice(0, 200))}`);
  if (r.rawSample) {
    console.log(`  原始 SSE 片段:\n${r.rawSample.split("\n").slice(0, 8).map((l) => "    " + l).join("\n")}`);
  }
  console.log();
}
