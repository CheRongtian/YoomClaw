#!/usr/bin/env node
/**
 * Gateway 独立启动入口。
 *
 * 库文件（index.ts）不应有副作用，因此把 startGateway() 的自执行拆到这里。
 * 之前用 argv[1].endsWith("src/index.ts") 猜测是否主模块，会与 apps/cli/src/index.ts
 * 撞名，导致 import 即自启、yoomclaw serve 双启动 EADDRINUSE。
 */
import { startGateway } from "./index.js";

const gateway = startGateway();

const shutdown = async (signal: string) => {
  console.log(`\n收到 ${signal}，正在关闭 Gateway...`);
  try {
    await gateway.stop();
  } catch {
    // 忽略关闭期异常
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
