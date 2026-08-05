// 主题系统：类型定义、内置主题、应用逻辑。
// 预设数据（opencode 主题包）由 gen-opencode-themes.py 生成到 themes-data.ts。

export type ThemePalette = Record<string, string>;

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeDef {
  id: string;
  name: string;
  source?: string;
  dark: ThemePalette;
  light: ThemePalette;
}

// ---- 紧凑核心色板（内置主题用），由 buildPalette 派生出完整 token ----
interface CorePalette {
  bg: string;
  bgPanel: string;
  bgElement: string;
  border: string;
  borderSubtle: string;
  borderActive: string;
  text: string;
  textMuted: string;
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  bgElevated?: string;
  bgInput?: string;
}

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildPalette(c: CorePalette): ThemePalette {
  const onPrimary = lum(c.primary) > 140 ? c.bg : c.text;
  const onError = lum(c.error) > 140 ? c.bg : "#ffffff";
  const p: ThemePalette = {
    "--bg": c.bg,
    "--bg-panel": c.bgPanel,
    "--bg-element": c.bgElement,
    "--bg-elevated": c.bgElevated ?? c.bgElement,
    "--bg-input": c.bgInput ?? c.bgElement,
    "--border": c.border,
    "--border-subtle": c.borderSubtle,
    "--border-active": c.borderActive,
    "--text": c.text,
    "--text-secondary": c.text,
    "--text-muted": c.textMuted,
    "--text-dim": c.textMuted,
    "--primary": c.primary,
    "--secondary": c.secondary,
    "--accent": c.accent,
    "--error": c.error,
    "--warning": c.warning,
    "--success": c.success,
    "--info": c.info,
    "--on-primary": onPrimary,
    "--on-error": onError,
    "--send-bg": c.primary,
    "--send-fg": onPrimary,
    "--send-bg-hover": c.primary,
    "--composer-bg": c.bgPanel,
    "--composer-border": c.bgElement,
    "--composer-focus-border": c.primary,
    "--user-bubble-bg": c.primary,
    "--user-bubble-fg": onPrimary,
    "--user-bubble-border": c.primary,
    "--assistant-bubble-bg": c.bgElement,
    "--assistant-bubble-border": c.border,
    "--tool-call-bg": c.bgPanel,
    "--tool-call-border": c.bgElement,
    "--code-bg": c.bgElement,
    "--scrollbar-thumb": c.bgElement,
    "--scrollbar-thumb-hover": c.border,
    "--modal-mask": "rgba(0,0,0,0.5)",
    "--status-running": c.primary,
    "--status-attention": c.warning,
    "--status-completed": c.success,
    "--status-ready": c.success,
    "--status-unconfigured": c.warning,
    "--status-unavailable": c.error,
  };
  return p;
}

function def(id: string, name: string, source: string, dark: CorePalette, light: CorePalette): ThemeDef {
  return { id, name, source, dark: buildPalette(dark), light: buildPalette(light) };
}

// ---- 6 个手工调优内置主题 ----
export const THEMES_BUILTIN: ThemeDef[] = [
  def(
    "opencode",
    "OpenCode",
    "builtin",
    {
      bg: "#0d0d0d",
      bgPanel: "#171717",
      bgElement: "#1d1d1d",
      border: "#282828",
      borderSubtle: "#222222",
      borderActive: "#3a3a3a",
      text: "#ececec",
      textMuted: "#8a8a8a",
      primary: "#4a9eff",
      secondary: "#7aa2f7",
      accent: "#4a9eff",
      error: "#f85149",
      warning: "#d29922",
      success: "#3fb950",
      info: "#58a6ff",
    },
    {
      bg: "#ffffff",
      bgPanel: "#f5f5f5",
      bgElement: "#ebebeb",
      border: "#e0e0e0",
      borderSubtle: "#e8e8e8",
      borderActive: "#c4c4c4",
      text: "#1a1a1a",
      textMuted: "#6e6e6e",
      primary: "#1f6feb",
      secondary: "#3b6fd6",
      accent: "#1f6feb",
      error: "#d1242f",
      warning: "#bf8700",
      success: "#1a7f37",
      info: "#0969da",
    },
  ),
  def(
    "dracula",
    "Dracula",
    "builtin",
    {
      bg: "#282a36",
      bgPanel: "#21222c",
      bgElement: "#343746",
      border: "#44475a",
      borderSubtle: "#383a4a",
      borderActive: "#6272a4",
      text: "#f8f8f2",
      textMuted: "#6272a4",
      primary: "#bd93f9",
      secondary: "#ff79c6",
      accent: "#ff79c6",
      error: "#ff5555",
      warning: "#f1fa8c",
      success: "#50fa7b",
      info: "#8be9fd",
    },
    {
      bg: "#f8f8f2",
      bgPanel: "#ffffff",
      bgElement: "#ececf0",
      border: "#e2e2e8",
      borderSubtle: "#e8e8ee",
      borderActive: "#bd93f9",
      text: "#282a36",
      textMuted: "#6272a4",
      primary: "#bd93f9",
      secondary: "#c026a9",
      accent: "#c026a9",
      error: "#ff5555",
      warning: "#b59f00",
      success: "#36b755",
      info: "#1f9bb8",
    },
  ),
  def(
    "catppuccin",
    "Catppuccin Mocha",
    "builtin",
    {
      bg: "#1e1e2e",
      bgPanel: "#181825",
      bgElement: "#313244",
      border: "#45475a",
      borderSubtle: "#3a3d52",
      borderActive: "#585b70",
      text: "#cdd6f4",
      textMuted: "#9399b2",
      primary: "#89b4fa",
      secondary: "#cba6f7",
      accent: "#cba6f7",
      error: "#f38ba8",
      warning: "#f9e2af",
      success: "#a6e3a1",
      info: "#89dceb",
    },
    {
      bg: "#eff1f5",
      bgPanel: "#e6e9ef",
      bgElement: "#ccd0da",
      border: "#bcc0cc",
      borderSubtle: "#c6cad4",
      borderActive: "#8839ef",
      text: "#4c4f69",
      textMuted: "#7c7f93",
      primary: "#1e66f5",
      secondary: "#8839ef",
      accent: "#8839ef",
      error: "#d20f39",
      warning: "#df8e1d",
      success: "#40a02b",
      info: "#04a5e5",
    },
  ),
  def(
    "tokyo",
    "Tokyo Night",
    "builtin",
    {
      bg: "#1a1b26",
      bgPanel: "#16161e",
      bgElement: "#24283b",
      border: "#2f3449",
      borderSubtle: "#292e40",
      borderActive: "#414868",
      text: "#c0caf5",
      textMuted: "#565f89",
      primary: "#7aa2f7",
      secondary: "#bb9af7",
      accent: "#bb9af7",
      error: "#f7768e",
      warning: "#e0af68",
      success: "#9ece6a",
      info: "#7dcfff",
    },
    {
      bg: "#e1e2e7",
      bgPanel: "#d5d6db",
      bgElement: "#c8c9d4",
      border: "#b8b9c4",
      borderSubtle: "#c0c1cc",
      borderActive: "#34548a",
      text: "#343b58",
      textMuted: "#565f89",
      primary: "#34548a",
      secondary: "#8a5cf5",
      accent: "#8a5cf5",
      error: "#f52a4a",
      warning: "#8c6c3e",
      success: "#587539",
      info: "#0f4b6e",
    },
  ),
  def(
    "gruvbox",
    "Gruvbox",
    "builtin",
    {
      bg: "#282828",
      bgPanel: "#1d2021",
      bgElement: "#3c3836",
      border: "#504945",
      borderSubtle: "#45403d",
      borderActive: "#665c54",
      text: "#ebdbb2",
      textMuted: "#a89984",
      primary: "#fe8019",
      secondary: "#fabd2f",
      accent: "#fabd2f",
      error: "#cc241d",
      warning: "#d79921",
      success: "#98971a",
      info: "#83a598",
    },
    {
      bg: "#fbf1c7",
      bgPanel: "#ebdbb2",
      bgElement: "#d5c4a1",
      border: "#bdae93",
      borderSubtle: "#c8b893",
      borderActive: "#9c8a6b",
      text: "#3c3836",
      textMuted: "#7c6f64",
      primary: "#af3a03",
      secondary: "#b57614",
      accent: "#b57614",
      error: "#cc241d",
      warning: "#d79921",
      success: "#79740e",
      info: "#427b58",
    },
  ),
  def(
    "nord",
    "Nord",
    "builtin",
    {
      bg: "#2e3440",
      bgPanel: "#272c36",
      bgElement: "#3b4252",
      border: "#434c5e",
      borderSubtle: "#3b4252",
      borderActive: "#4c566a",
      text: "#d8dee9",
      textMuted: "#7b8394",
      primary: "#88c0d0",
      secondary: "#b48ead",
      accent: "#b48ead",
      error: "#bf616a",
      warning: "#ebcb8b",
      success: "#a3be8c",
      info: "#81a1c1",
    },
    {
      bg: "#eceff4",
      bgPanel: "#e5e9f0",
      bgElement: "#d8dee9",
      border: "#cdd4e0",
      borderSubtle: "#d8dee9",
      borderActive: "#5e81ac",
      text: "#2e3440",
      textMuted: "#7b8394",
      primary: "#5e81ac",
      secondary: "#b48ead",
      accent: "#b48ead",
      error: "#bf616a",
      warning: "#ebcb8b",
      success: "#a3be8c",
      info: "#81a1c1",
    },
  ),
];

import { THEMES_EXTRA } from "./themes-data";

export const THEMES: ThemeDef[] = [...THEMES_BUILTIN, ...THEMES_EXTRA];

export const DEFAULT_THEME_ID = "opencode";
export const DEFAULT_MODE: ThemeMode = "system";

export const THEME_ID_KEY = "yoomclaw-theme-id";
export const THEME_MODE_KEY = "yoomclaw-theme-mode";
export const REDUCED_MOTION_KEY = "yoomclaw-reduced-motion";

export function getEffectiveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  }
  return mode;
}

/** 按 id 取主题；找不到（比如用户删了自定义主题）时回落到第一个内置主题，保证永远有可用调色板 */
export function findTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES_BUILTIN[0];
}

export function resolvePalette(themeId: string, mode: ThemeMode): { palette: ThemePalette; effective: "light" | "dark" } {
  const theme = findTheme(themeId);
  const effective = getEffectiveMode(mode);
  return { palette: effective === "dark" ? theme.dark : theme.light, effective };
}

/** 把调色板应用到 document.documentElement（内联 CSS 变量，覆盖 :root 默认值）。 */
export function applyPalette(themeId: string, mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const theme = findTheme(themeId);
  const effective = getEffectiveMode(mode);
  const palette = effective === "dark" ? theme.dark : theme.light;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(palette)) {
    root.style.setProperty(k, v);
  }
  root.dataset.mode = effective;
  root.dataset.themeId = theme.id;
  root.style.colorScheme = effective;
}

export function applyReducedMotion(reducedMotion: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.reducedMotion = reducedMotion ? "true" : "false";
}

/** 在 React 挂载前同步应用，避免首帧闪烁。 */
export function applyInitialTheme(): void {
  if (typeof window === "undefined") return;
  const id = (localStorage.getItem(THEME_ID_KEY) as string) || DEFAULT_THEME_ID;
  const mode = (localStorage.getItem(THEME_MODE_KEY) as ThemeMode) || DEFAULT_MODE;
  const reducedMotion = localStorage.getItem(REDUCED_MOTION_KEY) === "true";
  applyPalette(id, mode);
  applyReducedMotion(reducedMotion);
}
