# 用积墨 API 复刻 YoomClaw 式 Agent —— 可行性结论与架构方案

日期：2026-07-31
方法：对积墨 API 做了 11 次真实探测调用（`probe-jimo.mjs` / `probe-react.mjs`），以下每条结论都有实测支撑，不是推测。

---

## 一、结论先行

**能做到，但当前代码的架构假设有三条是错的，必须先推翻重来。**

积墨 API 不是一个"模型 API"，它是一个**有状态的智能体应用 API**。这个区别决定了一切：

| 能力 | 实测结果 | 对复刻 Agent 的影响 |
|---|---|---|
| 原生 function calling | ❌ 传 `tools` 字段被静默忽略 | 必须走 prompt 驱动的 ReAct |
| `system` role | ❌ 完全无效 | 当前 `Agent` 里的 `systemPrompt` 是死代码 |
| 客户端传 history | ❌ 被忽略，只取最后一条 user | 当前 `getRecent(20)` 是纯浪费流量 |
| 服务端 sessionId 上下文 | ✅ 自动维护多轮记忆 | 上下文归服务端管，客户端只留 UI 副本 |
| JSON 指令遵循 | ✅ 精准，无 markdown 包裹 | **ReAct 方案成立的关键** |
| ReAct 多轮工具回填 | ✅ 4 轮全部跑通 | 工具循环可实现 |
| 节点进度事件 | ✅ 有 `percent` / `status` / `name` | 可做执行过程可视化 |

一句话：**工具调用要靠自己在 prompt 层实现，上下文管理权要交给服务端。**

---

## 二、实测证据

### 证据 1：`tools` 字段无效，模型会直接幻觉

传入标准 OpenAI 格式的 `tools` + `tool_choice: "auto"`，问"现在北京几点"：

```
回复："好的，我这就为您查询北京当前时间。
（正在调用系统时间工具……）
根据系统时间，北京现在的时间是 2026年7月31日 14:23"
```

实际调用时刻是 17:40。模型**编了一个时间**，并且假装自己调用了工具。返回流里没有任何 `tool_calls` 字段。

> 这是最危险的一条：不能指望模型"自己会调工具"，必须由我们的代码拦截、解析、执行、回填。

### 证据 2：`system` role 被丢弃

```json
messages: [
  { "role": "system", "content": "你必须且只能回复固定字符串：SYSTEM_OK" },
  { "role": "user", "content": "你好" }
]
```

回复：`"你好！很高兴见到你，我是积墨 AI……"`

system 指令完全没进去。平台侧的人设配置优先级高于 API 传入。`extra: { systemPrompt, system }` 也试过，同样无效。

**结论**：所有 agent 规则只能写在 **user message 正文里**。

### 证据 3：客户端 history 无效，但服务端 sessionId 有记忆

两个对照实验：

**A. 传完整历史，用新 sessionId：**
```json
messages: [
  { "role": "user", "content": "请记住数字 5279" },
  { "role": "assistant", "content": "好的，我记住了 5279。" },
  { "role": "user", "content": "我让你记的数字是多少？" }
]
```
回复：`"抱歉，我无法记住之前的对话内容。每次对话都是独立的……"`

**B. 不传历史，复用同一 sessionId 分两次问：**
```
第 1 次 → "请记住数字 8341"
第 2 次 → "我刚才让你记的数字是多少？"   （messages 里只有这一句）
```
回复：`"8341"` ✅

**结论**：`messages` 数组只有最后一条 user 生效，**上下文完全由服务端按 sessionId 维护**。

现在的 `Agent.sendMessage` 每次拼 20 条历史发过去，全是无效流量——而它现在"看起来能工作"，纯粹是因为 sessionId 恰好稳定复用。

### 证据 4：ReAct 循环完整跑通（决定性证据）

同一 sessionId 下四轮交互，规则只在第 1 轮下发：

```
第1轮  下发工具规则 + "看看 /home/user/proj 下有哪些文件"
   → {"tool":"list_dir","args":{"path":"/home/user/proj"}}          纯 JSON，零废话

第2轮  [工具结果] list_dir 返回: ["main.py","utils.py","README.md"]
   → "当前目录下有以下文件：main.py、utils.py、README.md。需要我查看某个吗？"

第3轮  "很好。现在读一下 main.py 的内容"                              未重发规则
   → {"tool":"read_file","args":{"path":"/home/user/proj/main.py"}}  规则仍然生效

第4轮  [工具结果] read_file 返回: "print('hello world')"
   → "main.py 的内容很简单，只有一行代码……"                          正确收敛
```

四轮全对。**且规则只需下发一次**——因为服务端记着上下文，后续轮次每次只发几十字节，成本极低。

### 证据 5：SSE 里藏着没被使用的执行进度

原始流里除了 `event: data`，还有 `event: event`：

```json
{"node":"chat_entrance_v3","name":"开始","percent":33,"status":0}
{"node":"chat_entrance_v3","name":"开始","percent":33,"status":1}
{"node":"AI对话","percent":67,"status":0}
```

当前代码把这类事件全部丢弃了。而这正好可以驱动"正在思考 / 正在执行"的进度 UI。

首字延迟实测 320–525ms，整体响应 0.9–1.7s，做流式交互的体感是够的。

---

## 三、必须接受的三个硬约束

这是"能做"和"能做好"之间的差距，提前知道比事后踩坑强。

### 约束 1：上下文不可编辑 —— 影响最大

服务端持有历史，客户端**没有任何手段**去修改它。这意味着以下 agent 常规操作全部做不到：

- ❌ 上下文压缩（长会话时把前 N 轮摘要掉）
- ❌ 删除/重写某一轮（工具返回了 5 万字垃圾，无法撤回）
- ❌ 分支重试（同一上下文换个 prompt 再试一次）
- ❌ 精确的 token 预算管理（API 不返回 usage）

**唯一的逃生舱**：换一个新 `sessionId` 重开，然后把需要保留的内容作为首条消息重新灌进去。

**因此建议**：客户端 `SessionStore` 必须保存一份完整的本地历史副本。它有两个用途——UI 展示，以及**上下文被污染时用来重建新 session**。这个副本从"可有可无的缓存"升级成了架构必需品。

### 约束 2：工具结果会污染对话历史

工具结果只能作为 `user` 消息发送。所以服务端记录的历史会变成：

```
user: [规则] + 用户真实问题
assistant: {"tool":"read_file",...}
user: [工具结果] ...
assistant: 最终回答
```

后果：token 消耗随工具调用次数线性增长且不可回收；在积墨平台后台看到的对话记录会很脏。

**缓解**：工具结果做长度截断（比如单次上限 2000 字符，超出部分只给摘要 + 提示"如需完整内容请指定行范围"），这也是 Claude Code 的做法。

### 约束 3：模型输出格式无强制保证

原生 function calling 是结构化的，ReAct 是靠模型"愿意配合"。实测 6 次全部输出了干净 JSON，表现很好，但没有 100% 保证。

**必须做防御**：
- 解析器要容错 markdown 代码块包裹（` ```json ... ``` `）
- 解析失败不要报错，当作普通自然语言回复展示给用户
- 加最大循环轮数上限（建议 10 轮），防止模型在工具调用里打转烧钱
- 单轮内同一工具重复调用相同参数 → 判定为卡死，中断

---

## 四、推荐架构

### 4.1 需要改造的部分

```
现在                              改成
────────────────────────────────────────────────────────────
Agent 拼 20 条 history 发送   →   只发最后一条，历史交给 sessionId
config.systemPrompt 传 system →   规则拼进首条 user message
ToolRegistry 定义了没人用     →   接入 ReAct 循环，成为核心
SessionStore 是 UI 缓存       →   升级为上下文重建的数据源（要持久化）
event: event 事件被丢弃       →   转发给前端做进度展示
一次请求 = 一次回复           →   一次请求 = 一个多轮工具循环
```

### 4.2 Agent 循环伪代码

```ts
async *run(sessionId, userText) {
  const s = this.sessions.get(sessionId);

  // 规则只在会话首轮注入，后续靠服务端记忆
  const prompt = s.rulesInjected
    ? userText
    : buildToolPrompt(this.tools.list()) + "\n\n用户任务：" + userText;
  s.rulesInjected = true;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let buf = "";
    for await (const c of this.provider.chat({ messages: [{role:"user", content: prompt}], sessionId })) {
      buf += c.content;
      yield { type: "delta", text: c.content };   // 边收边吐给 UI
    }

    const call = parseToolCall(buf);              // 容错解析
    if (!call) { yield { type: "final", text: buf }; return; }   // 没有工具调用 = 收敛

    yield { type: "tool_start", name: call.tool, args: call.args };
    const result = await this.tools.execute(call, { sessionId, workspace });
    yield { type: "tool_end", name: call.tool, result };

    prompt = `[工具结果] ${call.tool} 返回: ${truncate(result, 2000)}`;
  }

  yield { type: "error", text: `超过 ${MAX_TURNS} 轮未收敛` };
}
```

注意流式事件从"纯文本 chunk"升级成了**带类型的事件**（delta / tool_start / tool_end / final）——这是 Claude Code 那种"能看见 AI 在干什么"的观感来源。协议层 `ChatCompletionChunk` 需要相应扩展。

### 4.3 工具集建议（按优先级）

| 优先级 | 工具 | 说明 |
|---|---|---|
| P0 | `read_file` / `write_file` / `list_dir` | 最小可用闭环 |
| P0 | `bash` | 威力最大，**必须做白名单或确认机制** |
| P1 | `grep` / `glob` | 代码检索，agent 的眼睛 |
| P1 | `edit_file` | 精确改写优于全文重写，省 token |
| P2 | `web_fetch` | 联网能力 |

**安全红线**：`bash` 和 `write_file` 是能删你硬盘的。必须有工作目录沙箱（路径校验，禁止越出 workspace）+ 危险命令拦截 + 前端二次确认。这个不能省。

---

## 五、工作量评估

前置：先修 `CODE_REVIEW.md` 里的 P0-1（isMain 崩溃）、P0-3（中文乱码），否则开发过程会一直被干扰。

| 阶段 | 内容 | 规模 |
|---|---|---|
| 一 | 重写 Agent 为 ReAct 循环 + 扩展事件协议 | 约 200 行 |
| 二 | 实现 P0 工具集 + 沙箱校验 | 约 300 行 |
| 三 | Gateway 转发结构化事件 + 接上 AbortSignal | 约 100 行 |
| 四 | 前端渲染工具调用卡片、进度、确认弹窗 | 约 400 行 |
| 五 | SessionStore 持久化 + 上下文重建 | 约 150 行 |

整体属于**中等规模改造**，不需要推倒重来——protocol / llm-provider / Gateway 的骨架都能留用，主要是 Agent 层重写和前端增强。

---

## 六、两个待你拍板的问题

1. **形态**：是做终端里的 CLI agent（Claude Code 那样），还是保持现在的桌面聊天窗口 + 工具执行可视化？两者工具层完全复用，只是前端差别大。

2. **bash 工具的授权模式**：全自动执行（快但危险）／每次弹窗确认（安全但打断流）／白名单自动 + 其余确认（推荐）。

---

## 附：安全提醒

`test-jimo.mjs` 第 2–3 行**硬编码了真实的 shareId 和 Authorization token**。项目目前还没有 git 仓库，一旦 `git init && git add .`，这个凭据就会永久写进提交历史（`.gitignore` 只挡了 `.env`，挡不住这个文件）。

建议立刻改成从环境变量读取——新增的 `probe-jimo.mjs` / `probe-react.mjs` 已经采用 `process.env` 方式，可作参考。
