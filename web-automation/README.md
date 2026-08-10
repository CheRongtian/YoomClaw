# Web automation

This directory contains opt-in automation for the Jimo web UI and history
verification. It is not part of the desktop runtime.

## Chrome history RPA

- `collect-jimo-history-rpa.mjs` reads visible history-table and detail-panel
  content through an already logged-in Chrome tab connected over CDP.
- `e2e-chrome-history.mjs` can launch an isolated Chrome profile, wait for
  manual login, and run the collector.
- `file-input-history-crosscheck.mjs` compares a live file-input report with
  the collected history without reading credentials or browser storage.
- `collect-jimo-history.mjs` is the separate, read-only API collector for
  environments that explicitly provide admin credentials.
- `probes/` contains the historical API capability probes used by
  `FEASIBILITY.md`.

Run these commands from the repository root. Generated reports belong under
`.tmp/` or `.claw-data/`; both locations are ignored by Git.

## Browser control smoke test

`browser-control-smoke.mjs` starts a temporary headless Chrome profile and
verifies CDP connection, ARIA/label targeting, strict ambiguity rejection,
multi-tab selection, title reporting, screenshots, and failed-CDP handling.

```bash
pnpm --filter @yoomclaw/agent-core build
node web-automation/browser-control-smoke.mjs
```

## Windows computer-control smoke test

After publishing the Windows helper, `computer-control-smoke.mjs` starts the
actual helper and exercises only `ping` and `list_windows`. It never focuses,
clicks, types into, or screenshots a user window.

```powershell
pnpm --filter @yoomclaw/agent-core build
node web-automation/computer-control-smoke.mjs
```

For the isolated UIA action test, build the disposable WinForms fixture and
run its smoke test. The fixture is the only window the test focuses or edits.

```powershell
pnpm build:computer-fixture
node web-automation/computer-control-fixture-smoke.mjs
```
