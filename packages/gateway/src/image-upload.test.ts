import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { Gateway } from "./index.js";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("Gateway sends image data URLs to the image host before the main agent run", async () => {
  const originalFetch = globalThis.fetch;
  let imageHostCalls = 0;
  let receivedToken = "";

  globalThis.fetch = (async (input, init) => {
    if (String(input) === "https://image-host.example.test/api/upload") {
      imageHostCalls += 1;
      receivedToken = new Headers(init?.headers).get("X-Upload-Token") ?? "";
      const form = init?.body as FormData;
      assert.ok(form.get("file") instanceof Blob);
      return new Response(JSON.stringify({
        ok: true,
        url: "https://image-host.example.test/img/abc.png",
        filename: "abc.png",
        size: 68,
        expires_at: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-image-upload-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test", mode: "hermes" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "main-share",
      authorization: "main-token",
    },
    imageHostConfig: {
      uploadUrl: "https://image-host.example.test/api/upload",
      uploadToken: "image-host-token",
    },
  });

  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;

  try {
    const response = await originalFetch(base + "/api/upload/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: PNG_DATA_URL,
        source: "desktop",
        fileName: "source.png",
        mimeType: "image/png",
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { url: string; fileId: string };
    assert.equal(body.url, "https://image-host.example.test/img/abc.png");
    assert.equal(body.fileId, "abc.png");
    assert.equal(imageHostCalls, 1);
    assert.equal(receivedToken, "image-host-token");
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
});
