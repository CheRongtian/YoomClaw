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
│   ├─ SessionStore — in-memory chat history               │
│   ├─ ToolRegistry — pluggable tools (echo, get_time, …)  │
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
import { ToolRegistry } from "@yoomclaw/agent-core";

registry.register(
  {
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
  async (args, ctx) => ({
    toolCallId: "",
    result: `Processed: ${args.input}`,
  }),
);
```

### Add a new LLM provider

Implement the `LLMProvider` interface in `@yoomclaw/llm-provider` and register it in the factory.

## License

MIT
