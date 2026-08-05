"""把 opencode 主题 JSON 批量转换为 YoomClaw 的 themes-data.ts。

来源: opencode 主题包 (https://github.com/anomalyco/opencode)
本地 JSON: 由 YOOMCLAW_OPENCODE_THEMES_DIR 指定，默认 ~/.qclaw/workspace/opencode-themes/*.json

输出: apps/desktop/renderer/src/theme/themes-data.ts
每个主题生成 dark + light 两套调色板，并展开为 THEMES_EXTRA 数组。
"""
import json
import os
import sys
from pathlib import Path

# Override this when the source themes live outside the default local folder.
THEMES_DIR = Path(os.environ.get(
    "YOOMCLAW_OPENCODE_THEMES_DIR",
    str(Path.home() / ".qclaw" / "workspace" / "opencode-themes"),
))
OUT_FILE = Path(__file__).resolve().parent / "themes-data.ts"

# opencode 语义键 -> YoomClaw CSS 变量
BASE_MAP = {
    "--bg": "background",
    "--bg-panel": "backgroundPanel",
    "--bg-element": "backgroundElement",
    "--border": "border",
    "--border-subtle": "borderSubtle",
    "--border-active": "borderActive",
    "--text": "text",
    "--text-muted": "textMuted",
    "--primary": "primary",
    "--accent": "accent",
    "--error": "error",
    "--warning": "warning",
    "--success": "success",
    "--info": "info",
}

# A few upstream themes only define a dark palette (or repeat their dark
# values for both modes). Keep their dark appearance, but provide a readable
# light counterpart for YoomClaw's global light mode.
LIGHT_CORE_OVERRIDES = {
    "aura": {
        "--bg": "#fbfaff",
        "--bg-panel": "#f6f2ff",
        "--bg-element": "#eee7ff",
        "--border": "#d7c9ef",
        "--border-subtle": "#e8def8",
        "--border-active": "#805ad5",
        "--text": "#2c2340",
        "--text-muted": "#756b86",
        "--primary": "#7c4dff",
        "--secondary": "#c026a9",
        "--accent": "#7c4dff",
        "--error": "#d14343",
        "--warning": "#a15c00",
        "--success": "#16805a",
        "--info": "#6655cc",
    },
    "ayu": {
        "--bg": "#fafafa",
        "--bg-panel": "#f3f4f5",
        "--bg-element": "#e7e8e9",
        "--border": "#cfd3d6",
        "--border-subtle": "#e5e7e9",
        "--border-active": "#55b4d4",
        "--text": "#5c6166",
        "--text-muted": "#8a9199",
        "--primary": "#399ee6",
        "--secondary": "#a37acc",
        "--accent": "#e6b450",
        "--error": "#d95757",
        "--warning": "#b97800",
        "--success": "#86b300",
        "--info": "#399ee6",
    },
    "catppuccinfrappe": {
        "--bg": "#eff1f5",
        "--bg-panel": "#e6e9ef",
        "--bg-element": "#ccd0da",
        "--border": "#bcc0cc",
        "--border-subtle": "#c6cad4",
        "--border-active": "#8839ef",
        "--text": "#4c4f69",
        "--text-muted": "#7c7f93",
        "--primary": "#1e66f5",
        "--secondary": "#8839ef",
        "--accent": "#8839ef",
        "--error": "#d20f39",
        "--warning": "#df8e1d",
        "--success": "#40a02b",
        "--info": "#04a5e5",
    },
    "catppuccinmacchiato": {
        "--bg": "#eff1f5",
        "--bg-panel": "#e6e9ef",
        "--bg-element": "#ccd0da",
        "--border": "#bcc0cc",
        "--border-subtle": "#c6cad4",
        "--border-active": "#8839ef",
        "--text": "#4c4f69",
        "--text-muted": "#7c7f93",
        "--primary": "#1e66f5",
        "--secondary": "#8839ef",
        "--accent": "#8839ef",
        "--error": "#d20f39",
        "--warning": "#df8e1d",
        "--success": "#40a02b",
        "--info": "#04a5e5",
    },
    "lucentorng": {
        "--bg": "#fffaf7",
        "--bg-panel": "#fff5f0",
        "--bg-element": "#ffebe2",
        "--border": "#f0c5b1",
        "--border-subtle": "#ead8d0",
        "--border-active": "#c94d24",
    },
    "nightowl": {
        "--bg": "#fbfbfb",
        "--bg-panel": "#f4f4f5",
        "--bg-element": "#eceef1",
        "--border": "#d6d9df",
        "--border-subtle": "#e5e7eb",
        "--border-active": "#4876d6",
        "--text": "#403f53",
        "--text-muted": "#7a7f99",
        "--primary": "#4876d6",
        "--secondary": "#994cc3",
        "--accent": "#994cc3",
        "--error": "#c96765",
        "--warning": "#c96765",
        "--success": "#2aa298",
        "--info": "#4876d6",
    },
}


def lum(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) < 6:
        h = h * 2
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


def is_dark_hex(value: str) -> bool:
    return value.startswith("#") and lum(value) < 140


def resolve(value, defs, theme_obj, mode, seen=None):
    if seen is None:
        seen = set()
    if isinstance(value, str):
        if value.startswith("#"):
            return value
        if value in seen:
            return "#000000"
        seen = seen | {value}
        if value in defs:
            return resolve(defs[value], defs, theme_obj, mode, seen)
        if value in theme_obj:
            return resolve(theme_obj[value], defs, theme_obj, mode, seen)
        return "#000000"
    if isinstance(value, dict):
        if mode in value:
            return resolve(value[mode], defs, theme_obj, mode, seen)
        return "#000000"
    return "#000000"


def get(theme_obj, key, defs, mode, default="#000000"):
    if key in theme_obj:
        return resolve(theme_obj[key], defs, theme_obj, mode)
    return default


def build_palette(theme_json, mode, theme_id=None):
    defs = theme_json.get("defs", {})
    theme_obj = theme_json.get("theme", {})
    p = {}
    light_override = LIGHT_CORE_OVERRIDES.get(theme_id, {}) if mode == "light" else {}

    # 基础语义色
    for css_var, oc_key in BASE_MAP.items():
        p[css_var] = light_override.get(css_var, get(theme_obj, oc_key, defs, mode))

    # secondary 缺失时回退到 primary
    p["--text-secondary"] = p["--text"]
    p["--secondary"] = light_override.get(
        "--secondary", get(theme_obj, "secondary", defs, mode, p["--primary"])
    )
    # text-dim 回退到 text-muted
    p["--text-dim"] = p["--text-muted"]

    # 派生表面
    p["--bg-elevated"] = p["--bg-element"]
    p["--bg-input"] = p["--bg-element"]

    # 主色文字（按亮度决定黑/白）
    primary = p["--primary"]
    on_primary = p["--bg"] if lum(primary) > 140 else p["--text"]
    p["--on-primary"] = on_primary

    # 错误色上的前景文字（按亮度决定黑/白）
    error = p["--error"]
    on_error = p["--bg"] if lum(error) > 140 else "#ffffff"
    p["--on-error"] = on_error

    # 发送/操作按钮
    p["--send-bg"] = primary
    p["--send-fg"] = on_primary
    p["--send-bg-hover"] = primary

    # 输入框（composer）
    p["--composer-bg"] = p["--bg-panel"]
    p["--composer-border"] = p["--bg-element"]
    p["--composer-focus-border"] = primary

    # 气泡
    p["--user-bubble-bg"] = primary
    p["--user-bubble-fg"] = on_primary
    p["--user-bubble-border"] = primary
    p["--assistant-bubble-bg"] = p["--bg-element"]
    p["--assistant-bubble-border"] = p["--border"]

    # 工具调用卡片
    p["--tool-call-bg"] = p["--bg-panel"]
    p["--tool-call-border"] = p["--bg-element"]

    # 代码块
    p["--code-bg"] = p["--bg-element"]

    # 滚动条
    p["--scrollbar-thumb"] = p["--bg-element"]
    p["--scrollbar-thumb-hover"] = p["--border"]

    # 遮罩
    p["--modal-mask"] = "rgba(0,0,0,0.5)"

    # 状态色
    p["--status-running"] = primary
    p["--status-attention"] = p["--warning"]
    p["--status-completed"] = p["--success"]
    p["--status-ready"] = p["--success"]
    p["--status-unconfigured"] = p["--warning"]
    p["--status-unavailable"] = p["--error"]

    return p


def format_palette(palette, var_name):
    lines = [f"export const {var_name}: ThemePalette = {{"]
    for key, value in palette.items():
        lines.append(f'  "{key}": "{value}",')
    lines.append("};")
    return "\n".join(lines)


def theme_id(name: str) -> str:
    return name.replace(".json", "").replace("-", "")


def theme_name(name: str) -> str:
    return " ".join(p.capitalize() for p in name.replace(".json", "").split("-"))


def main():
    files = sorted(THEMES_DIR.glob("*.json"))
    out = [
        "// 自动生成, 请勿手动编辑。来源: opencode 主题包",
        "// https://github.com/anomalyco/opencode/tree/dev/packages/tui/src/theme/assets",
        "// 由 gen-opencode-themes.py 从 opencode 主题 JSON 转换而来。",
        "",
        'import type { ThemeDef, ThemePalette } from "./themes";',
        "",
        "",
    ]
    entries = []
    for f in files:
        tj = json.loads(f.read_text(encoding="utf-8"))
        tid = theme_id(f.name)
        vd, vl = f"{tid}Dark", f"{tid}Light"
        dark_palette = build_palette(tj, "dark", tid)
        light_palette = build_palette(tj, "light", tid)
        if light_palette == dark_palette:
            raise ValueError(f"{tid} has identical dark and light palettes")
        if is_dark_hex(light_palette["--bg"]):
            raise ValueError(f"{tid} has a dark background in its light palette")
        out.append(format_palette(dark_palette, vd))
        out.append("")
        out.append(format_palette(light_palette, vl))
        out.append("")
        entries.append((tid, theme_name(f.name), vd, vl))

    out.append("export const THEMES_EXTRA: ThemeDef[] = [")
    for tid, name, vd, vl in entries:
        out.append(
            f'  {{ id: "{tid}", name: "{name}", source: "opencode", dark: {vd}, light: {vl} }},'
        )
    out.append("];")
    out.append("")

    OUT_FILE.write_text("\n".join(out), encoding="utf-8")
    print(f"OK {OUT_FILE} ({OUT_FILE.stat().st_size} bytes, {len(files)} themes)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
