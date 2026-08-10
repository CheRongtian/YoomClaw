# YoomClaw macOS Computer Control

Native Apple Silicon helper for the `computer_use` tool. It communicates with
the Node gateway over JSON Lines on stdin/stdout and uses macOS Accessibility
and CoreGraphics APIs.

Build from the repository root:

```bash
pnpm build:computer-helper
```

At runtime, enable YoomClaw under **System Settings → Privacy & Security →
Accessibility**. Window screenshots additionally require **Screen Recording**.
Password and secure text controls are blocked, and text content is omitted from
the audit log.
