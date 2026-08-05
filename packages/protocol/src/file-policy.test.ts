import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFileInput,
  countAttachmentParts,
  FILE_INPUT_ACCEPT,
  FILE_INPUT_RULES,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_VIDEO_UPLOAD_BYTES,
  countImageAttachmentParts,
  extractLocalFilePathCandidates,
} from "./file-policy.js";

test("file policy matches the provider upload limits", () => {
  assert.equal(MAX_FILES_PER_MESSAGE, 10);
  assert.equal(MAX_IMAGES_PER_MESSAGE, 10);
  assert.equal(FILE_INPUT_RULES.document.maxBytes, 10_000_000);
  assert.equal(FILE_INPUT_RULES.image.maxBytes, 10_000_000);
  assert.equal(FILE_INPUT_RULES.audio.maxBytes, 30_000_000);
  assert.equal(FILE_INPUT_RULES.video.maxBytes, MAX_VIDEO_UPLOAD_BYTES);
  assert.equal(MAX_VIDEO_UPLOAD_BYTES, 30_000_000);
  assert.match(FILE_INPUT_ACCEPT, /\.docx/);
  assert.match(FILE_INPUT_ACCEPT, /\.mpeg4/);
});

test("classification is case-insensitive and uses the filename extension", () => {
  assert.deepEqual(
    classifyFileInput("资料\\REPORT.DOCX", 10_000_000, "application/octet-stream"),
    {
      fileName: "资料\\REPORT.DOCX",
      extension: "docx",
      mimeType: "application/octet-stream",
      sizeBytes: 10_000_000,
      kind: "document",
      maxBytes: 10_000_000,
      accepted: true,
    },
  );
  assert.equal(classifyFileInput("voice.mp3", 30_000_001).rejectionCode, "FILE_TOO_LARGE");
  assert.equal(classifyFileInput("program.exe", 10).rejectionCode, "UNSUPPORTED_FILE_TYPE");
});

test("video classification enforces the effective transport-safe boundary", () => {
  assert.equal(
    classifyFileInput("clip.mp4", MAX_VIDEO_UPLOAD_BYTES).accepted,
    true,
  );
  assert.equal(
    classifyFileInput("clip.mp4", MAX_VIDEO_UPLOAD_BYTES + 1).rejectionCode,
    "FILE_TOO_LARGE",
  );
});

test("attachment part counting only counts file and image parts", () => {
  assert.equal(countAttachmentParts([
    { type: "text", text: "hello" },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    { type: "file_url", file_url: { url: "https://example.test/a.docx", fileId: "a" } },
  ]), 2);
});

test("image attachment counting is separate from total attachment counting", () => {
  assert.equal(countImageAttachmentParts([
    { type: "text", text: "hello" },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    { type: "file_url", file_url: { url: "https://example.test/a.docx", fileId: "a" } },
  ]), 1);
});

test("local media path extraction handles quoted paths and ignores URLs", () => {
  assert.deepEqual(
    extractLocalFilePathCandidates(
      'read "C:\\Users\\test\\My Pictures\\a.png" and C:\\work\\slides.pptx; ignore https://example.test/a.png',
    ),
    ["C:\\Users\\test\\My Pictures\\a.png", "C:\\work\\slides.pptx"],
  );
  assert.deepEqual(
    extractLocalFilePathCandidates("delete C:\\work\\report.txt and ./notes.txt"),
    ["C:\\work\\report.txt", "./notes.txt"],
  );
  assert.deepEqual(
    extractLocalFilePathCandidates("file:///C:/Users/test/My%20Files/report.txt"),
    ["C:\\Users\\test\\My Files\\report.txt"],
  );
});
