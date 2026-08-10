# YoomClaw Windows Computer Control Helper

This Windows-only helper exposes a small JSONL protocol over stdin/stdout.
It uses Windows UI Automation for semantic control and Win32 `SendInput` only
when the Node adapter explicitly enables input injection after tool approval.

Build on a Windows machine with the .NET 8 SDK:

```powershell
dotnet publish .\ComputerControlWin.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true -o .\publish
```

The helper is optional at runtime. When the published executable is absent,
YoomClaw reports `COMPUTER_UNAVAILABLE` and keeps browser/coding tools usable.

The repository build script is also safe on machines without the SDK. To use a
specific SDK without changing the global PATH, set `YOOMCLAW_DOTNET_PATH` to
the `dotnet` executable before running `pnpm build:computer-helper`.
