# YoomClaw

A mini OpenClaw-like personal AI agent framework, built from scratch.

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) — the open-source personal AI assistant framework by Peter Steinberger.

## What is this?

YoomClaw is a minimal implementation of an OpenClaw-style AI assistant framework, including:

- **Gateway** — HTTP + WebSocket server that routes messages between UI and LLM
- **Agent Core** — Session management, tool registry, agent runtime loop
- **LLM Provider** — Pluggable provider abstraction (default: JimoAI SSE format)
- **Desktop App** — Electron + Vite/React chat interface (WebSocket transport, Markdown/LaTeX/code highlighting)
- **CLI** — Command-line entry point

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Desktop App (Electron + Vite/React renderer)                       │
│   ├─ Session sidebar (create / select / delete)          │
│   ├─ Message list (Markdown, code, LaTeX, streaming)     │
│   └─ Compose bar (Enter to send, Shift+Enter for newline)│
└────────────────────┬─────────────────────────────────────┘
                     │ HTTP (SSE for chat, REST for sessions)
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Gateway (HTTP + WS, port 18789)                         │
│   ├─ /api/sessions       — CRUD sessions                 │
│   ├─ /api/sessions/:id/messages — SSE chat               │
│   ├─ /api/upload/file    — Proxy file upload             │
│   ├─ /api/tools          — List tools                    │
│   └─ /ws                  — WebSocket for bidirectional  │
└────────────────────┬─────────────────────────────────────┘
                     │ Custom SSE protocol
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Agent Core                                              │
│   ├─ SessionStore — file-backed sessions and run events  │
│   ├─ ToolRegistry — coding, memory, Skills, browser tools│
│   └─ Agent — orchestrates LLM calls + history + tools    │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│  LLM Provider (JimoAI)                                   │
│   POST /v2/chat/completions/share?shareId=xxx            │
│   Body: { messages, sessionId, source, extra }           │
│   Response: SSE event:data / event:end                   │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your JimoAI credentials
```

Required values:
- `JIMO_SHARE_ID` — from JimoAI platform > 服务发布 > API 接入
- `JIMO_AUTHORIZATION` — same place

### 3. Run in development

```bash
# Terminal 1: Gateway
pnpm dev:gateway

# Terminal 2: Desktop app (Electron + Vite renderer) — spawns Gateway internally
pnpm dev
```

Or both at once:

```bash
pnpm dev:all
```

The YoomClaw desktop window launches automatically (Electron spawns the Gateway). Start chatting.

### 4. Production build

```bash
pnpm build
pnpm start
```

## Project Structure

```
YoomClaw/
├── packages/
│   ├── protocol/         # Shared TypeScript types
│   ├── llm-provider/     # LLM adapter (JimoAI SSE format)
│   ├── agent-core/       # Session store, tool registry, agent loop
│   └── gateway/          # HTTP + WebSocket server
├── apps/
│   ├── cli/              # `claw` CLI entry
│   └── desktop/          # Electron app (main process + Vite/React renderer)
├── skills/               # Skill directory (extensible)
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## API Format

This project uses the JimoAI API format (see [api.md](./docs/api.md)):

- **Chat**: `POST /v2/chat/completions/share?shareId=xxx` with `Authorization` header
- **Request body**: `{ messages, sessionId, source, extra }`
- **Response**: SSE stream with `event: data` (content chunks) and `event: end` (stream end)
- **File upload**: `POST /v2/upload/file/share` with `{ url, source }`

## Extending

### Add a new tool

```typescript
import { DefaultToolRegistry } from "@yoomclaw/agent-core";

const registry = new DefaultToolRegistry();
registry.register({
  risk: "safe",
  definition: {
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
  async run(args, _context) {
    return { result: `Processed: ${String(args.input ?? "")}`, isError: false };
  },
});
```

### Add a new LLM provider

Implement the `LLMProvider` interface in `@yoomclaw/llm-provider` and register it in the factory.

## Hermes Mode

当前默认运行模式是 `Hermes Mode`：它保留现有积墨 AI 主 API 和 Jimo SSE 请求格式，在本地增加了可选工作区、文件优先会话、全局/项目提示词、长期记忆、Skills 草稿、编程工具、Chrome CDP 浏览器工具和独立识图机器人。

桌面端打开“设置 → Agent”即可：

- 选择项目工作区；工作区规则保存为项目根目录的 `AGENTS.md`。
- 编辑全局提示词、用户偏好和项目提示词。
- 开关 Toolsets，编辑记忆，批准或拒绝 Skills 草稿。
- 设置并连接已经用 `--remote-debugging-port=9222` 启动的 Chrome。

运行数据默认保存到 Electron 的 `<userData>/YoomClaw/`，包括 `prompts/`、`memories/`、`skills/`、`sessions/`、`browser/` 和 `logs/`。旧工作区中的 `.claw-data/sessions.json` 会被复制迁移为单会话文件，原文件不会删除。

积墨 API 不支持原生 `system` / `tools` / 客户端完整 history，因此 Hermes 首轮会把规则、记忆、项目提示词和工具说明拼进 user 内容；后续轮次只发送工具结果，并始终使用同一个 provider session id。视觉机器人必须使用独立的 `JIMO_VISION_*` shareId 和 token；未配置时普通文字聊天仍可用。

高风险操作仍会确认或阻止：越出工作区、读取 `.env` / SSH 私钥、管理员权限、递归危险删除、下载后直接执行、Git 提交/合并、浏览器输入和提交操作不会因为工作区自动执行而绕过安全边界。

验证命令：

```bash
pnpm -r --if-present lint
pnpm --dir apps/desktop/renderer run typecheck
pnpm --dir apps/desktop/renderer run build
pnpm test
```

## License

MIT
