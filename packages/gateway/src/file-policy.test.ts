import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { FILE_INPUT_RULES } from "@yoomclaw/protocol";
import { Gateway } from "./index.js";

const FILE_RESPONSE = {
  id: 1,
  source: "desktop",
  processId: null,
  fileName: "note.md",
  fileId: "note.md",
  type: 1,
  url: "https://files.example.test/note.md",
  content: null,
  extra: "{}",
  createAt: 1,
  updateAt: 1,
  deleted: false,
};

async function startTestGateway(): Promise<{ gateway: Gateway; base: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-file-policy-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "main-share",
      authorization: "main-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { gateway, base: `http://127.0.0.1:${address.port}` };
}

test("Gateway forwards supported non-image data URLs to Jimo", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let providerBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("example.test/v2/upload/file/share")) {
      providerCalls += 1;
      providerBody = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
      return new Response(JSON.stringify(FILE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { gateway, base } = await startTestGateway();
  try {
    const response = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "data:text/markdown;base64,SGVsbG8=",
        source: "desktop",
        fileName: "note.md",
        mimeType: "text/markdown",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(providerCalls, 1);
    assert.deepEqual(providerBody, {
      url: "data:text/markdown;base64,SGVsbG8=",
      source: "desktop",
      fileName: "note.md",
      mimeType: "text/markdown",
      kind: "document",
      sizeBytes: 5,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
});

test("Gateway keeps zero-byte supported files within the declared policy", async () => {
  const originalFetch = globalThis.fetch;
  let providerBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("example.test/v2/upload/file/share")) {
      providerBody = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
      return new Response(JSON.stringify(FILE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { gateway, base } = await startTestGateway();
  try {
    const response = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "data:text/markdown;base64,",
        source: "desktop",
        fileName: "empty.md",
        mimeType: "text/markdown",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(providerBody?.fileName, "empty.md");
    assert.equal(providerBody?.kind, "document");
    assert.equal(providerBody?.sizeBytes, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
});

test("Gateway rejects unsupported or oversized files before contacting Jimo", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("example.test/v2/upload/file/share")) providerCalls += 1;
    return originalFetch(input, init);
  }) as typeof fetch;

  const { gateway, base } = await startTestGateway();
  try {
    const unsupported = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "data:application/octet-stream;base64,AA==",
        source: "desktop",
        fileName: "program.exe",
        mimeType: "application/octet-stream",
      }),
    });
    assert.equal(unsupported.status, 415);
    assert.equal((await unsupported.json() as { code: string }).code, "UNSUPPORTED_FILE_TYPE");

    const oversized = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://files.example.test/large.docx",
        source: "desktop",
        fileName: "large.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 10_000_001,
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { code: string }).code, "FILE_TOO_LARGE");

    const oversizedVideo = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://files.example.test/large.mp4",
        source: "desktop",
        fileName: "large.mp4",
        mimeType: "video/mp4",
        sizeBytes: FILE_INPUT_RULES.video.maxBytes + 1,
      }),
    });
    assert.equal(oversizedVideo.status, 413);
    assert.equal((await oversizedVideo.json() as { code: string }).code, "FILE_TOO_LARGE");
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
});

test("Gateway exposes the provider upstream size limit instead of a generic upload error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("example.test/v2/upload/file/share")) {
      return new Response("<html><h1>413 Request Entity Too Large</h1></html>", {
        status: 413,
        headers: { "Content-Type": "text/html" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { gateway, base } = await startTestGateway();
  try {
    const response = await originalFetch(`${base}/api/upload/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "data:video/mp4;base64,AA==",
        source: "desktop",
        fileName: "large.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
      }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { code: string }).code, "PROVIDER_FILE_TOO_LARGE");
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
});

test("Gateway resolves local image paths under the active safety boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-local-media-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-local-media-outside-"));
  const insidePath = path.join(root, "inside.png");
  const outsidePath = path.join(outsideRoot, "outside.png");
  const oversizedPath = path.join(root, "oversized.png");
  fs.writeFileSync(insidePath, Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(outsidePath, Buffer.from([4, 5, 6, 7]));
  fs.writeFileSync(oversizedPath, Buffer.alloc(0));
  fs.truncateSync(oversizedPath, FILE_INPUT_RULES.image.maxBytes + 1);
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "main-share",
      authorization: "main-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const inside = await fetch(`${base}/api/files/read-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: insidePath }),
    });
    assert.equal(inside.status, 200);
    const insideBody = await inside.json() as {
      fileName: string;
      kind: string;
      mimeType: string;
      sizeBytes: number;
      dataUrl: string;
    };
    assert.equal(insideBody.fileName, "inside.png");
    assert.equal(insideBody.kind, "image");
    assert.equal(insideBody.mimeType, "image/png");
    assert.equal(insideBody.sizeBytes, 4);
    assert.match(insideBody.dataUrl, /^data:image\/png;base64,/);

    const oversized = await fetch(base + "/api/files/read-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oversizedPath }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { code: string }).code, "FILE_TOO_LARGE");

    const outsideBlocked = await fetch(`${base}/api/files/read-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outsidePath }),
    });
    assert.equal(outsideBlocked.status, 403);
    assert.equal((await outsideBlocked.json() as { code: string }).code, "LOCAL_FILE_BLOCKED");

    const config = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safetyMode: "full-access" }),
    });
    assert.equal(config.status, 200);
    const outsideAllowed = await fetch(`${base}/api/files/read-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outsidePath }),
    });
    assert.equal(outsideAllowed.status, 200);
  } finally {
    await gateway.stop();
  }
});
