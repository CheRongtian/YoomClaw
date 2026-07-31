"""把 opencode 主题 JSON 批量转换为 YoomClaw 的 themes-data.ts。

来源: opencode 主题包 (https://github.com/anomalyco/opencode)
本地 JSON: C:\\Users\\12992\\.qclaw\\workspace\\opencode-themes\\*.json

输出: apps/desktop/renderer/src/theme/themes-data.ts
每个主题生成 dark + light 两套调色板，并展开为 THEMES_EXTRA 数组。
"""
import json
import sys
from pathlib import Path

THEMES_DIR = Path(r"C:\Users\12992\.qclaw\workspace\opencode-themes")
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


def lum(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) < 6:
        h = h * 2
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


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


def build_palette(theme_json, mode):
    defs = theme_json.get("defs", {})
    theme_obj = theme_json.get("theme", {})
    p = {}

    # 基础语义色
    for css_var, oc_key in BASE_MAP.items():
        p[css_var] = get(theme_obj, oc_key, defs, mode)

    # secondary 缺失时回退到 primary
    p["--text-secondary"] = p["--text"]
    p["--secondary"] = get(theme_obj, "secondary", defs, mode, p["--primary"])
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
        out.append(format_palette(build_palette(tj, "dark"), vd))
        out.append("")
        out.append(format_palette(build_palette(tj, "light"), vl))
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
