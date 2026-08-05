"""Small dependency-free Office document text extractor used by the Gateway."""

from __future__ import annotations

import base64
import io
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree


MAX_CHARS = 100_000


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def xml_text(data: bytes) -> list[str]:
    root = ElementTree.fromstring(data)
    return [element.text.strip() for element in root.iter() if local_name(element.tag) == "t" and element.text and element.text.strip()]


def extract_docx(zf: zipfile.ZipFile, max_chars: int) -> str:
    data = zf.read("word/document.xml")
    root = ElementTree.fromstring(data)
    paragraphs: list[str] = []
    current: list[str] = []
    for element in root.iter():
        name = local_name(element.tag)
        if name == "t" and element.text:
            current.append(element.text)
        elif name == "p" and current:
            paragraphs.append("".join(current).strip())
            current = []
    if current:
        paragraphs.append("".join(current).strip())
    return "\n\n".join(item for item in paragraphs if item)[:max_chars]


def extract_pptx(zf: zipfile.ZipFile, slide: int | None, max_chars: int) -> str:
    slide_paths = sorted(
        name for name in zf.namelist()
        if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
    )
    if slide is not None:
        if slide < 1 or slide > len(slide_paths):
            return ""
        slide_paths = [slide_paths[slide - 1]]
    blocks: list[str] = []
    for index, name in enumerate(slide_paths, 1):
        texts = xml_text(zf.read(name))
        if texts:
            blocks.append(f"[幻灯片 {index}]\n" + " ".join(texts))
    return "\n\n".join(blocks)[:max_chars]


def extract_xlsx(zf: zipfile.ZipFile, sheet: str | None, max_chars: int) -> str:
    shared: list[str] = []
    if "xl/sharedStrings.xml" in zf.namelist():
        shared = xml_text(zf.read("xl/sharedStrings.xml"))
    sheet_paths = sorted(
        name for name in zf.namelist()
        if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
    )
    sheet_names: list[str] = []
    if "xl/workbook.xml" in zf.namelist():
        workbook_root = ElementTree.fromstring(zf.read("xl/workbook.xml"))
        sheet_names = [
            str(element.attrib.get("name") or "")
            for element in workbook_root.iter()
            if local_name(element.tag) == "sheet"
        ]
    if sheet:
        try:
            selected_index = next(index for index, name in enumerate(sheet_names) if name == sheet)
        except StopIteration:
            raise ValueError(f"找不到工作表：{sheet}")
        if selected_index >= len(sheet_paths):
            raise ValueError(f"工作表没有可读取的内容：{sheet}")
        sheet_paths = [sheet_paths[selected_index]]
    blocks: list[str] = []
    for index, name in enumerate(sheet_paths, 1):
        root = ElementTree.fromstring(zf.read(name))
        rows: list[str] = []
        for row in (element for element in root.iter() if local_name(element.tag) == "row"):
            values: list[str] = []
            for cell in (element for element in row if local_name(element.tag) == "c"):
                cell_type = cell.attrib.get("t")
                value = ""
                for child in cell:
                    if local_name(child.tag) == "v" and child.text is not None:
                        value = child.text
                        break
                    if local_name(child.tag) == "is":
                        value = " ".join(xml_text(ElementTree.tostring(child, encoding="utf-8")))
                if cell_type == "s":
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        pass
                values.append(value)
            if values:
                rows.append(" | ".join(values))
        if rows:
            label = sheet if sheet else (sheet_names[index - 1] if index - 1 < len(sheet_names) else str(index))
            blocks.append(f"[工作表 {label}]\n" + "\n".join(rows))
    return "\n\n".join(blocks)[:max_chars]


def extract_office(file_name: str, data: bytes, slide: int | None, sheet: str | None, max_chars: int) -> str:
    suffix = PurePosixPath(file_name).suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return extract_xlsx(zf, sheet, max_chars)
    if suffix == ".pptx":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return extract_pptx(zf, slide, max_chars)
    if suffix == ".docx":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return extract_docx(zf, max_chars)
    return ""


def main() -> None:
    payload = json.loads(sys.stdin.read())
    file_name = str(payload.get("fileName") or "document")
    data = base64.b64decode(str(payload.get("base64") or ""), validate=True)
    max_chars = min(MAX_CHARS, max(1000, int(payload.get("maxChars") or 50_000)))
    text = extract_office(
        file_name,
        data,
        int(payload["slide"]) if payload.get("slide") is not None else None,
        str(payload["sheet"]) if payload.get("sheet") else None,
        max_chars,
    )
    print(json.dumps({
        "text": text,
        "fileName": file_name,
        "kind": PurePosixPath(file_name).suffix.lstrip(".").lower() or "document",
        "truncated": len(text) >= max_chars,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # JSON error channel keeps Gateway responses stable.
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise
