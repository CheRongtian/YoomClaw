# YoomClaw 代码审查报告

审查日期：2026-07-31
范围：`packages/{protocol,llm-provider,agent-core,gateway}`、`apps/{cli,desktop,webchat}`、构建与环境配置
代码量：约 2000 行 TS/TSX（不含依赖）

---

## 一、项目定位与架构

YoomClaw 是一个仿 OpenClaw 的个人 AI 助手框架，pnpm monorepo，分层清晰：

```
WebChat (Next.js 15 / React 19, :3000)
        │  HTTP + SSE（前端直连，绕开 Next rewrite 缓冲）
        ▼
Gateway (node:http + ws, :18789)  ── SessionStore / ToolRegistry
        ▼
Agent Core（会话、历史、流式编排）
        ▼
LLM Provider（JimoAI SSE 适配）
```

**做得好的地方**

- 分层职责干净，`protocol` 只放类型、无运行时依赖，包间依赖是单向的，没有循环。
- 全链路流式：Provider → Agent → Gateway → 浏览器，都用 async generator / ReadableStream 逐块传递，没有中途 buffer 成整包。
- TypeScript `strict: true`，`tsc --noEmit` 在 gateway/protocol 上零报错。
- Electron 主进程安全基线正确：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 的 `on()` 还做了 channel 白名单。
- Markdown 渲染没有引入 `rehype-raw`，默认不渲染原始 HTML，避开了 XSS 主坑。

**整体判断**：骨架和品味都在线，作为"从零手写一个 agent 框架"的雏形是合格的。但目前更接近一个**能跑通 demo 的原型**，离可用还差：README 宣称的核心能力（工具调用）实际没有接上，另外有 2 个已复现的功能性 Bug 和一组本地服务安全问题。

---

## 二、严重问题（P0，建议立刻修）

### 1. `yoomclaw serve` 必定崩溃，`claw --help` 会偷偷起服务器 —— 已复现

`packages/gateway/src/index.ts:427-440` 的"是否为主模块"判断：

```ts
const arg1 = (process.argv[1] ?? "").replace(/\\/g, "/");
return import.meta.url === `file://${process.argv[1]}` ||
  arg1.endsWith("src/index.ts") ||     // ← 问题在这
  arg1.endsWith("src/index.js");
```

CLI 的入口正好也叫 `apps/cli/src/index.ts`，同样以 `src/index.ts` 结尾。于是只要 `import { startGateway } from "@yoomclaw/gateway"`，**在 import 阶段网关就自启了**。

实测结果：

- `tsx apps/cli/src/index.ts --help` → 打印完帮助后仍然监听端口，进程不退出。
- `tsx apps/cli/src/index.ts serve` → 启动两次，第二次 `EADDRINUSE`，进程崩溃。

这正是仓库里 `gateway.err` 那条 `EADDRINUSE: 127.0.0.1:18789` 的成因。

**修法**：删掉后缀猜测，用标准写法。

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
```

更彻底的做法是把 `startGateway()` 的自执行从库文件里拆出去，单独放一个 `packages/gateway/src/bin.ts`——库就是库，不该有副作用。

### 2. 停止按钮不会真的停止，token 照烧

前端 `ChatPage.tsx` 的 `AbortController` 只中断了浏览器到 Gateway 的这一段。Gateway 的 `handleSendMessage`（`gateway/src/index.ts:168`）调用 `this.agent.sendMessage(sessionId, userMessage)` 时**完全没传 signal**，而 `Agent.sendMessage` 和 `JimoProvider.chat` 明明都支持 `options.signal`。

结果：用户点"停止"，UI 停了，Gateway 仍在从上游拉完整条回复，费用照付，连接照占。

**修法**：把 HTTP 请求的中断事件接上。

```ts
const ac = new AbortController();
req.on("close", () => ac.abort());
for await (const chunk of this.agent.sendMessage(sessionId, userMessage, { signal: ac.signal })) { ... }
```

WebSocket 的 `chat` 分支（`:293`）同理，需要按连接维护 AbortController，`ws.on("close")` 时中断。

### 3. 请求体解析会截断多字节字符（中文乱码）

`gateway/src/index.ts:385-399`：

```ts
let data = "";
req.on("data", (chunk) => (data += chunk));   // Buffer 隐式 toString('utf8')
```

每个 chunk 独立解码。当一个中文字符（3 字节 UTF-8）恰好跨 TCP 包边界被切开时，两半各自解码都会变成替换字符 `�`，JSON.parse 直接失败或内容损坏。长中文消息 + 网络分片下必现。

**修法**：

```ts
const chunks: Buffer[] = [];
req.on("data", (c) => chunks.push(c));
req.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  ...
});
```

顺带补上体积上限（比如 1MB），现在这段代码没有任何长度限制，一个大 body 就能把内存吃满。

---

## 三、安全问题（P1）

### 4. 本地网关 = 无鉴权的开放代理，配合 `CORS: *` 可被任意网页驱动

Gateway 对所有响应写死 `Access-Control-Allow-Origin: *`（`:91`），且**没有任何鉴权**。虽然默认只绑 `127.0.0.1`，但浏览器同样能从任意站点发起跨域请求——用户在开着 YoomClaw 时访问一个恶意页面，该页面就能：

- `GET /api/sessions` 读走全部会话标题，`GET /api/sessions/:id` 读走**全部聊天历史**；
- `DELETE` 删除会话；
- `POST /api/sessions/:id/messages` 用你的 JimoAI 额度免费提问。

**修法（任选其一，建议都做）**：

- 启动时生成一个 token，写入 `.env.local` 给前端读，Gateway 校验 `Authorization` 头；
- CORS 白名单收紧到 `http://localhost:3000`，不要 `*`；
- 校验 `Origin` / `Host` 头，拒绝非预期来源（防 DNS rebinding）。

### 5. `/api/upload/file` 是无限制的 SSRF 跳板

`handleUploadFile`（`:212`）把请求体里的任意 `url` 原样转发给上游，没有协议/域名校验，也没有鉴权。攻击者（或本机任意进程）可以拿它探测内网。至少要限制 `http/https`、禁止私网地址段。

### 6. `.env` 里是真实凭据，而项目还没有 git 仓库

`.gitignore` 已经正确忽略了 `.env`，但目前目录下 `git status` 报 `not a git repository`。等于所有代码都没有版本保护，`git init` 之后如果 `.gitignore` 位置或内容出岔子，`JIMO_AUTHORIZATION` 就会被首次提交带上去。建议现在就 `git init` 并立刻确认 `git status` 中看不到 `.env`。

另外 `gateway.log` / `gateway.err` 属于运行产物，应该进 `.gitignore`（现有的 `*.log` 只挡住了前者，`.err` 漏了）。

### 7. Electron 外链处理未校验协议

`main.cjs:108`：

```js
mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
  shell.openExternal(u);   // 未校验协议
  return { action: "deny" };
});
```

页面内容来自 LLM 输出，若出现 `file://`、`smb://` 或自定义 scheme 的链接，会被直接交给系统打开。应只放行 `http:` / `https:`。同时建议补一个 `will-navigate` 拦截，防止主窗口被导航到外部站点。

---

## 四、功能缺失与逻辑缺陷（P2）

### 8. 工具系统是"装饰品" —— README 与实现不符

`ToolRegistry` 写得挺完整（注册、查询、执行、错误包装），Gateway 也注册了 `echo` / `get_time`，`/api/tools` 也能列出来。但 **`Agent.sendMessage` 从头到尾没有碰过 `this.tools`**：不下发 tool 定义给模型，不解析 tool_call，没有"调用工具→回填结果→二次请求"的循环。

README 里"Agent — orchestrates LLM calls + history + tools"和架构图里的 tool 节点目前都是空头支票。要么补上 agent loop，要么先在 README 里标注 WIP。这是当前项目和"agent 框架"之间最大的差距。

### 9. 前端 SSE 错误信息被自己吞掉

`ChatPage.tsx:188-194`：

```ts
} else if (parsed.event === "error") {
  try {
    const errObj = JSON.parse(parsed.data);
    throw new Error(errObj.message ?? "Stream error");  // 抛在 try 里
  } catch {
    throw new Error("Stream error");                    // 被自己 catch，信息丢失
  }
}
```

`throw` 写在 `try` 内部，必然被同一个 `catch` 接住，服务端返回的真实错误（比如"401 token 失效"）永远显示成无意义的 "Stream error"。把 `throw` 挪到 `catch` 外面即可。

### 10. `end` 事件的 `break` 只跳出了内层循环

同文件 `:186`，`break` 位于 `for (const rawEvent of events)` 中，跳不出外层 `while (true)`。现在能正常收尾纯粹是因为服务端主动 `res.end()` 了。想显式处理就要用标志位或带 label 的 break。

### 11. 中断时已生成的内容被丢弃

`stopStreaming` 后走 `finally`，`setStreamingContent("")` 且 `assistantText` 不会被写入消息列表——用户看着输出到一半点停止，屏幕上的内容瞬间消失。但服务端其实已经把完整回复存进 session 了，切换会话再切回来，内容又"复活"，前后端状态不一致。建议中断时把已收到的部分作为一条 assistant 消息落地。

### 12. 错误路径下会话里塞进两条错误记录

`Agent.sendMessage` catch 到异常时，先往 session 里 append 一条 `[Error] xxx`，然后**继续 rethrow**；Gateway 捕获后又给前端发 `error` 事件，前端再本地插一条 `⚠️ 错误: xxx`。同一次失败在服务端历史和前端 UI 里表现为两条不同措辞的记录，重新加载会话时用户会看到"两次报错"。二选一即可。

### 13. SSE 解析器不兼容 CRLF

`llm-provider/src/index.ts:127` 和前端 `parseSSE` 都按 `\n\n` 切分事件。若上游或中间层使用 `\r\n\r\n`（SSE 规范允许），整条流会被当成一个永不完整的事件缓存在 buffer 里，表现为"完全没有输出"。建议先 `replace(/\r\n/g, "\n")` 再切分。

### 14. 缺少凭据校验，失败信息不友好

`startGateway` 里 `shareId` / `authorization` 缺失时默认成空字符串，照常启动，用户只有在发第一条消息时才收到一个上游 401。建议启动时校验并直接报错退出，提示去配 `.env`。

### 15. 会话仅存内存，重启即失忆

`SessionStore` 是纯 `Map`，进程一重启历史全没。作为原型可以接受，但既然 UI 已经做了会话侧栏和"N 条消息"这种持久化语义的展示，用户预期一定是能留存的。落一个 JSON 文件或 SQLite 都不难。

另外 `create()` 的默认标题 `Session ${size + 1}` 在删除后会重号，多个会话可能同名。

---

## 五、工程与整洁度（P3）

| 问题 | 位置 | 说明 |
|---|---|---|
| 死代码 | `apps/webchat/src/components/MessageList.tsx` | 201 行，全项目无任何引用，实际用的是 `MessageStream.tsx` |
| 重复文件 | `apps/desktop/src/main.ts`、`preload.cjs.ts` | 与 `.cjs` 版本内容基本一致，Electron 实际加载的是 `.cjs`，TS 版是废弃残留 |
| 调试残留 | 早期 `packages/gateway/src/debug.mjs`、根目录 `test-jimo.mjs` / `test-streaming.mjs` | 已从工作区清理 |
| 运行日志入库 | `gateway.log` / `gateway.err` | 已加入 `.gitignore` 并清理现有残留 |
| 跨平台脚本 | 根 `package.json` 的 `clean: rm -rf ...` | Windows PowerShell 下不可用，建议换 `rimraf` |
| 依赖重复 | 根 `devDependencies.electron` 与 `apps/desktop` 各声明一份 | 建议只留 app 级 |
| 潜在坑 | `next.config.mjs` 无 `transpilePackages` | 现在 webchat 只 `import type` 所以能编译；一旦从 `@yoomclaw/protocol` 引入任何运行时值（枚举、常量、函数），Next 会因为直接吃 TS 源码而构建失败 |
| 无测试 | 全项目 | 零单测。SSE 解析器、SessionStore 这两块纯函数逻辑最值得先补，成本很低 |
| React hooks 依赖 | `ChatPage.tsx:48` | `refreshSessions` 内部调用了 `selectSession` 但未列入依赖数组，`eslint-plugin-react-hooks` 会告警 |
| 类型冗余 | `JimoProvider.chat` 里 `request.source ?? "api"` | `ChatCompletionRequest.source` 已是必填 string，`??` 永远不生效 |

---

## 六、建议的修复顺序

1. **修 `isMain` 判断** —— 一行改动，直接让 CLI 从"完全不可用"变成可用（P0-1）
2. **接上 AbortSignal** —— 停止按钮生效，省钱（P0-2）
3. **改 `readJsonBody` 为 Buffer 拼接 + 体积上限** —— 中文场景必踩（P0-3）
4. **Gateway 加 token 鉴权 + 收紧 CORS + 限制 upload 的 URL** —— 本地服务的基本自保（P1-4/5）
5. **`git init` 并确认 `.env` 未被跟踪**（P1-6）
6. **修前端错误吞没 + 中断丢内容 + 双重错误记录**（P2-9/11/12）
7. **补 agent tool loop，或在 README 标注 WIP** —— 决定这个项目是"聊天客户端"还是"agent 框架"（P2-8）
8. **清理死代码，补 SSE 解析器和 SessionStore 的单测**（P3）

---

## 七、一句话总结

架构分层和流式设计的品味都不错，安全基线（Electron 侧、Markdown 渲染）也没踩明显的坑；但 CLI 入口有个已复现的致命 Bug 导致 `yoomclaw serve` 必崩，停止按钮和中文长消息各有一处真实缺陷，本地网关缺鉴权，而 README 承诺的工具调用能力目前完全没有实现——先按上面 1→3 的顺序修，项目就能从"demo"进到"能日常用"。
