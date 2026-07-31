#!/usr/bin/env node
/**
 * @yoomclaw/cli - Command-line interface for YoomClaw
 *
 * Usage:
 *   claw              - Start interactive REPL
 *   yoomclaw serve        - Start the Gateway server
 *   claw --version    - Print version
 *   claw --help       - Print help
 */

import { startGateway } from "@yoomclaw/gateway";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
YoomClaw - A mini OpenClaw-like personal AI assistant

Usage:
  claw                Start interactive REPL (coming soon)
  yoomclaw serve          Start the Gateway server
  claw --version      Print version
  claw --help         Print this help

Environment variables (see .env.example):
  JIMO_API_BASE_URL   JimoAI base URL
  JIMO_SHARE_ID       JimoAI share ID
  JIMO_AUTHORIZATION  JimoAI auth token
  GATEWAY_PORT        Gateway port (default 18789)
  GATEWAY_HOST        Gateway host (default 127.0.0.1)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`YoomClaw v${VERSION}`);
    return;
  }

  const command = args[0] ?? "repl";

  switch (command) {
    case "serve":
    case "server":
    case "start":
      startGateway();
      // Keep process alive
      process.on("SIGINT", () => {
        console.log("\nBye!");
        process.exit(0);
      });
      break;

    case "repl":
      console.log("YoomClaw REPL mode is coming soon.");
      console.log("For now, run `yoomclaw serve` to start the Gateway server, then launch the YoomClaw desktop app.");
      console.log("\n  pnpm dev    # starts the desktop app (gateway + renderer)");
      console.log("\nOr start just the gateway:");
      console.log("  pnpm start");
      break;

    default:
      console.log(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
