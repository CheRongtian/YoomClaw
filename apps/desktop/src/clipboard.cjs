const FILE_PATH_FORMATS = [
  "FileNameW",
  "FileName",
  "CF_HDROP",
  "text/uri-list",
  "text/plain",
];

function normalizeClipboardPath(value) {
  const trimmed = String(value ?? "").replace(/\u0000/g, "").trim();
  if (!trimmed) return "";

  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "file:") return "";
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:/i.test(pathname)) pathname = pathname.slice(1);
      if (url.hostname && url.hostname !== "localhost") {
        pathname = `\\\\${url.hostname}${pathname}`;
      }
      return pathname.replace(/\//g, "\\");
    } catch {
      return "";
    }
  }

  if (/^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed)) return trimmed;
  return "";
}

function parsePathText(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => normalizeClipboardPath(line))
    .filter(Boolean);
}

/**
 * Decode Windows CF_HDROP/FileNameW clipboard data. CF_HDROP starts with a
 * DROPFILES header; FileNameW contains a UTF-16LE, double-null-terminated
 * list of absolute paths. The fallback also accepts raw text/URI-list data.
 */
function decodeFilePathBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];

  let offset = 0;
  let wide = false;
  if (buffer.length >= 20) {
    const filesOffset = buffer.readUInt32LE(0);
    if (filesOffset >= 20 && filesOffset < buffer.length) {
      offset = filesOffset;
      wide = buffer.readUInt32LE(16) !== 0;
    }
  }

  const body = buffer.subarray(offset);
  // Some clipboard providers expose FileNameW without the DROPFILES header.
  if (!wide && body.length >= 4 && body[1] === 0 && body[3] === 0) wide = true;
  const text = body.toString(wide ? "utf16le" : "latin1");
  return text
    .split("\u0000")
    .flatMap((value) => parsePathText(value));
}

function readClipboardFilePaths(clipboard) {
  if (!clipboard) return [];
  const paths = new Set();
  let formats = [];
  try {
    formats = clipboard.availableFormats("clipboard");
  } catch {
    formats = [];
  }

  const available = new Set(formats.map((format) => String(format).toLowerCase()));
  for (const format of FILE_PATH_FORMATS) {
    if (available.size > 0 && !available.has(format.toLowerCase())) continue;
    try {
      const buffer = clipboard.readBuffer(format);
      const decoded = /text\//i.test(format)
        ? parsePathText(buffer.toString("utf8"))
        : decodeFilePathBuffer(buffer);
      for (const value of decoded) paths.add(value);
    } catch {
      // Clipboard formats differ between Explorer, desktop apps and browsers.
    }
  }

  if (paths.size === 0) {
    try {
      for (const value of parsePathText(clipboard.readText("clipboard"))) paths.add(value);
    } catch {
      // Reading clipboard text is only a best-effort fallback.
    }
  }
  return [...paths];
}

module.exports = { decodeFilePathBuffer, normalizeClipboardPath, readClipboardFilePaths };
