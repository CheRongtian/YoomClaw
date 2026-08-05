import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocumentService, createVisionService, AttachmentStore } from "./advanced-services.js";
import { LocalPdfReader } from "./pdf-reader.js";

test("document service reads local text with workspace safety", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-document-service-"));
  const file = path.join(workspace, "notes.md");
  fs.writeFileSync(file, "# Heading\n\ncontent", "utf8");
  const service = createDocumentService(new LocalPdfReader(), new AttachmentStore());
  try {
    const result = await service.read({ path: "notes.md" }, { sessionId: "doc", workspace });
    assert.equal(result.fileName, "notes.md");
    assert.match(result.text, /content/);
    await assert.rejects(
      service.read({ path: "../outside.md" }, { sessionId: "doc", workspace }),
      /outside|workspace|工作区/i,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
test("vision service converts local images and attachment ids into image parts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-vision-service-"));
  const image = path.join(workspace, "pixel.png");
  fs.writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  const attachments = new AttachmentStore();
  attachments.remember("attached.png", "data:image/png;base64,iVBORw0KGgo=", "attached.png", "image/png");
  let received = 0;
  const provider = {
    async analyze(message: { content: unknown }) {
      received = Array.isArray(message.content)
        ? message.content.filter((part: { type?: string }) => part.type === "image_url").length
        : 0;
      return "识别完成";
    },
  };
  const service = createVisionService(provider, attachments);
  assert.ok(service);
  try {
    const result = await service.analyze({ paths: [image], fileIds: ["attached.png"] }, { sessionId: "vision", workspace });
    assert.equal(received, 2);
    assert.equal(result.text, "识别完成");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
