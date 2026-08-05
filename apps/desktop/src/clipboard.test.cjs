const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeFilePathBuffer,
  normalizeClipboardPath,
  readClipboardFilePaths,
} = require("./clipboard.cjs");

test("decodes Windows FileNameW/CF_HDROP paths", () => {
  const expected = [
    "C:\\Users\\test\\Downloads\\1.png",
    "C:\\Users\\test\\Downloads\\with space.txt",
  ];
  const body = Buffer.from(`${expected.join("\u0000")}\u0000\u0000`, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(header.length, 0);
  header.writeUInt32LE(1, 16);
  assert.deepEqual(decodeFilePathBuffer(Buffer.concat([header, body])), expected);
});

test("normalizes file URI clipboard paths", () => {
  assert.equal(
    normalizeClipboardPath("file:///C:/Users/test/Downloads/1.png"),
    "C:\\Users\\test\\Downloads\\1.png",
  );
});

test("reads native clipboard formats with a text fallback", () => {
  const path = "C:\\Users\\test\\Downloads\\1.png";
  const body = Buffer.from(`${path}\u0000\u0000`, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(header.length, 0);
  header.writeUInt32LE(1, 16);
  const clipboard = {
    availableFormats: () => ["FileNameW"],
    readBuffer: () => Buffer.concat([header, body]),
    readText: () => "",
  };
  assert.deepEqual(readClipboardFilePaths(clipboard), [path]);
});
