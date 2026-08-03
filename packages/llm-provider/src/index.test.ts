import assert from "node:assert/strict";
import test from "node:test";
import { JimoProvider, JimoVisionProvider } from "./index.js";

function sseResponse(chunks: string[]): Response {
  let index = 0;
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  const body = {
    getReader() {
      return {
        async read() {
          if (index >= encoded.length) return { done: true, value: undefined };
          return { done: false, value: encoded[index++] };
        },
        releaseLock() {},
      };
    },
  };
  return { ok: true, body } as unknown as Response;
}

test("Jimo SSE parser handles CRLF, split chunks and malformed JSON", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return sseResponse([
      "event: data\r",
      "\ndata: {\"role\":\"assistant\",\"content\":\"你\"}\r",
      "\n\r\n",
      "event: data\ndata: {\"role\":\"assistant\",\"content\":\"好\"}\n\n",
      "event: data\ndata: {bad json}\n\n",
      "event: end\ndata: {\"end\":{},\"role\":\"assistant\"}\n\n",
    ]);
  }) as typeof fetch;

  try {
    const provider = new JimoProvider({
      baseUrl: "https://example.test",
      shareId: "main-share",
      authorization: "token",
    });
    const chunks: string[] = [];
    for await (const chunk of provider.chat({
      messages: [{ role: "user", content: "hello" }],
      sessionId: "session-1",
      source: "api",
      extra: {},
    })) {
      if (chunk.kind === "content") chunks.push(chunk.content);
    }
    assert.deepEqual(chunks, ["你", "好"]);
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    assert.equal(body.sessionId, "session-1");
    assert.equal("system" in body, false);
    assert.equal("tools" in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vision provider uses its own Jimo share and session namespace", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestBody = "";
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestBody = String(init?.body ?? "");
    return sseResponse(["event: data\ndata: {\"role\":\"assistant\",\"content\":\"OCR\"}\n\nevent: end\ndata: {}\n\n"]);
  }) as typeof fetch;
  try {
    const provider = new JimoVisionProvider({
      baseUrl: "https://vision.example.test",
      shareId: "vision-share",
      authorization: "vision-token",
    });
    const result = await provider.analyze({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://image.test/a.png" } }],
    }, "session-2");
    assert.equal(result, "OCR");
    assert.match(requestedUrl, /shareId=vision-share/);
    assert.equal((JSON.parse(requestBody) as { sessionId: string }).sessionId, "vision-session-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
