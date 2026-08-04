#!/usr/bin/env python3
"""Read text from a PDF supplied as base64 JSON on stdin.

This helper intentionally does not write the uploaded PDF to disk. The Gateway
keeps the bytes local and sends only bounded extracted text to the main agent.
"""

from __future__ import annotations

import base64
import io
import json
import sys


def main() -> int:
    try:
        from pypdf import PdfReader
    except Exception as exc:
        print(json.dumps({"error": "pypdf is not installed: " + str(exc)}))
        return 2

    try:
        payload = json.load(sys.stdin)
        raw = base64.b64decode(payload["base64"], validate=True)
        max_pages = max(1, int(payload.get("maxPages", 50)))
        max_chars = max(1000, int(payload.get("maxChars", 60000)))
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:
                raise ValueError("encrypted PDF is not readable without a password") from exc

        total_pages = len(reader.pages)
        page_count = min(total_pages, max_pages)
        sections: list[str] = []
        for index in range(page_count):
            text = (reader.pages[index].extract_text() or "").strip()
            if text:
                sections.append("--- Page " + str(index + 1) + " ---\n" + text)

        combined = "\n\n".join(sections)
        truncated = len(combined) > max_chars or total_pages > max_pages
        if len(combined) > max_chars:
            combined = combined[:max_chars].rstrip()
        # Windows may use GBK for stdout. ASCII-escaped JSON keeps extracted
        # Chinese and private-use glyphs from crashing the helper process.
        print(json.dumps({
            "pages": total_pages,
            "extractedPages": page_count,
            "text": combined,
            "truncated": truncated,
        }, ensure_ascii=True))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
