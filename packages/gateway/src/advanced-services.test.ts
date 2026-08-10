import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocumentService, AttachmentStore } from "./advanced-services.js";
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
