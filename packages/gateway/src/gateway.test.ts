import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { Gateway } from "./index.js";

test("Gateway exposes Hermes config without provider credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-gateway-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test", mode: "hermes" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "secret-share",
      authorization: "secret-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const configResponse = await fetch(`${base}/api/config`);
    assert.equal(configResponse.ok, true);
    const config = await configResponse.json() as Record<string, unknown>;
    assert.equal(config.mode, "hermes");
    assert.equal(config.workspace, root);
    assert.equal("authorization" in config, false);
    assert.equal("shareId" in config, false);

    const modeResponse = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "legacy" }),
    });
    assert.equal(modeResponse.ok, true);
    assert.equal((await modeResponse.json() as { mode: string }).mode, "legacy");

    const createResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gateway test" }),
    });
    assert.equal(createResponse.status, 201);
    const session = await createResponse.json() as { id: string };
    assert.equal((await fetch(`${base}/api/sessions/${session.id}`)).ok, true);
  } finally {
    await gateway.stop();
  }
});
