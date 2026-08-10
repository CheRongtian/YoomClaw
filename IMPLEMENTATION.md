# YoomClaw 实现说明（ReAct Agent 全链路）

> 复刻 OpenClaw/Claude Code 式本地 agent，后端沿用积墨 AI（有状态 agent 应用 API）。
> 形态：桌面聊天窗口 + 工具可视化 + bash 白名单自动/其余弹窗确认。

## 架构

```
Next.js WebChat (:3000)
   │  WebSocket /ws  (chat.event 流 + tool.decision 确认)
   ▼
Gateway (:18789, node:http + ws)
   │  Agent.run() 生成器 → AgentEvent 流
   ▼
Agent Core (ReAct 循环)
   │  首轮 user 消息塞工具规则；后续轮回填工具结果
   ▼
JimoProvider (积墨 SSE)  ──  sandbox.ts 路径沙箱 + judgeCommand 命令分级
```

积墨是**有状态 agent 应用 API**，不是模型 API：不支持原生 function calling、
不接收 system role、不接收客户端历史，但 sessionId 上下文有效、能稳定遵循 JSON 工具协议。
因此走 prompt 驱动的 ReAct（规则塞首条 user 消息正文，自行解析模型 JSON）。

## 改动文件

| 包 | 文件 | 改动 |
|----|------|------|
| agent-core | `src/index.ts` | `Agent.run()` 改为 `async *` 生成器，产出 `AgentEvent`；ReAct 循环 + confirm 等待 + 死循环检测 |
| agent-core | `src/sandbox.ts` | 路径沙箱（防 `../../` 穿越）、命令分级（allow/confirm/block）、结果截断 |
| agent-core | `src/tools.ts` | 内置工具：`read_file`/`write_file`/`edit_file`/`list_dir`/`grep`/`glob`/`bash`/`get_time` |
| agent-core | `src/react.ts` | 工具规则 prompt 构造 + 容错 JSON 工具调用解析（兼容跨 chunk 半截 JSON） |
| gateway | `src/index.ts` | HTTP sessions CRUD + WS `/ws` 双向转发 `chat.event` / `tool.decision`；confirm 挂起防挂死 |
| gateway | `src/bin.ts` | 独立启动入口（修 isMain 自启 bug） |
| webchat | `src/components/ChatPage.tsx` | SSE→WebSocket；渲染 `AgentEvent` 流；确认弹窗；修 error 吞掉/中断丢内容两处 bug |
| webchat | `src/components/MessageStream.tsx` | 新增 `ToolCardView`（pending/running/done/error + 结果 + 耗时）+ 进度条 |
| webchat | `src/rehype-katex.d.ts` | 补 rehype-katex 类型垫片（无自带 d.ts） |
| 删除 | `apps/webchat/src/components/MessageList.tsx` | 死代码（与 MessageStream 重复） |
| 根 | `start-dev.ps1` | WebChat 环境变量 `GATEWAY_URL` → `NEXT_PUBLIC_GATEWAY_URL` |

## 校验结果

- `agent-core` / `gateway` / `webchat` 三处 `tsc --noEmit` 均零报错。
- `webchat` `next build` 干净通过（4 页面全部生成）。
- **真实积墨 API 端到端冒烟**（`packages/gateway/smoke-react.ts`）跑通 3 场景：
  `list_dir`（safe）、`get_time`（safe）、`bash`（confirm，弹窗确认后执行）。

## 运行

```bash
# 仓库根目录，确保 .env 含 JIMO_SHARE_ID / JIMO_AUTHORIZATION / JIMO_API_BASE_URL
.\start-dev.ps1
# Gateway:  http://127.0.0.1:18789
# WebChat:  http://localhost:3000
```

前端直连 Gateway（`NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:18789`），不经 Next 代理，
避免 rewrite 缓冲 SSE/WS。

## 遗留事项

1. **前端 emoji 图标**：`🦞`(品牌 mascot) / `☰` / `＋` / `🛠` / `⚠️` 作为图标使用，
   严格说不符合 P0-1（应换项目锁定 SVG 图标库）。属既有品牌设计，标记为后续美化项，未阻塞交付。
2. **旧测试脚本**：早期的 `test-jimo.mjs` 已从工作区清理；所有真实 API 探测脚本均从环境变量读取凭据。
3. **未接入的 app**：`apps/desktop`(Electron) 与 `apps/cli` 尚未接新 Agent 链路，本次只动了
   `webchat` + `gateway` + `agent-core`。
4. **鉴权缺失**：Gateway 目前无鉴权 + `CORS: *`，本地单用户可接受；若暴露到网络需补 token。
