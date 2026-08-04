import assert from "node:assert/strict";
import test from "node:test";
import {
  ImageHostClient,
  dataUrlMimeType,
  isHostableDataUrl,
  isImageDataUrl,
} from "./image-host.js";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";

test("image host client uploads a data URL as multipart with the token header", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  let uploadedBytes = 0;
  let uploadedMime = "";
  let uploadedName = "";

  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    const form = init?.body as FormData;
    const file = form.get("file");
    assert.ok(file instanceof Blob);
    uploadedBytes = (await file.arrayBuffer()).byteLength;
    uploadedMime = file.type;
    uploadedName = file instanceof File ? file.name : "";
    return new Response(JSON.stringify({
      ok: true,
      url: "https://yunbloom.cn/img/test.png",
      filename: "test.png",
      size: uploadedBytes,
      expires_at: null,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ImageHostClient({
      uploadUrl: "https://yunbloom.cn/img/api/upload",
      uploadToken: "test-upload-token",
    });
    const result = await client.upload({
      url: PNG_DATA_URL,
      source: "desktop",
      fileName: "测试图片.png",
      mimeType: "image/png",
    });

    assert.equal(requestedUrl, "https://yunbloom.cn/img/api/upload");
    assert.equal(requestedHeaders?.get("X-Upload-Token"), "test-upload-token");
    assert.equal(uploadedMime, "image/png");
    assert.equal(uploadedName, "____.png");
    assert.ok(uploadedBytes > 0);
    assert.equal(result.url, "https://yunbloom.cn/img/test.png");
    assert.equal(result.fileId, "test.png");
    assert.match(result.extra, /image-host/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image host helpers only accept supported image data URLs", () => {
  assert.equal(dataUrlMimeType(PNG_DATA_URL), "image/png");
  assert.equal(isImageDataUrl(PNG_DATA_URL), true);
  assert.equal(isImageDataUrl("data:text/plain;base64,SGVsbG8="), false);
  assert.equal(isImageDataUrl("https://example.test/a.png"), false);
  assert.equal(isHostableDataUrl(PDF_DATA_URL), true);
});

test("image host client rejects non-HTTPS response URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    url: "http://image-host.example.test/img.png",
    filename: "img.png",
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  try {
    const client = new ImageHostClient({
      uploadUrl: "https://image-host.example.test/api/upload",
      uploadToken: "test-upload-token",
    });
    await assert.rejects(
      client.upload({ url: PNG_DATA_URL, source: "test", fileName: "image.png" }),
      /HTTPS image URL/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
