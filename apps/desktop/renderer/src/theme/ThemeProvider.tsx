import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyPalette,
  DEFAULT_MODE,
  DEFAULT_THEME_ID,
  getEffectiveMode,
  THEME_ID_KEY,
  THEME_MODE_KEY,
  THEMES,
  type ThemeDef,
  type ThemeMode,
} from "./themes";

interface ThemeContextValue {
  themeId: string;
  mode: ThemeMode;
  effectiveMode: "light" | "dark";
  themes: ThemeDef[];
  setThemeId: (id: string) => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitial(): { themeId: string; mode: ThemeMode } {
  if (typeof window === "undefined") return { themeId: DEFAULT_THEME_ID, mode: DEFAULT_MODE };
  const themeId = (localStorage.getItem(THEME_ID_KEY) as string) || DEFAULT_THEME_ID;
  const mode = (localStorage.getItem(THEME_MODE_KEY) as ThemeMode) || DEFAULT_MODE;
  return { themeId, mode };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = readInitial();
  const [themeId, setThemeIdState] = useState(initial.themeId);
  const [mode, setModeState] = useState<ThemeMode>(initial.mode);

  // 应用 + 持久化
  useEffect(() => {
    applyPalette(themeId, mode);
    localStorage.setItem(THEME_ID_KEY, themeId);
    localStorage.setItem(THEME_MODE_KEY, mode);
  }, [themeId, mode]);

  // 跟随系统：mode=system 时监听系统配色变化
  useEffect(() => {
    if (mode !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyPalette(themeId, "system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, themeId]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      mode,
      effectiveMode: getEffectiveMode(mode),
      themes: THEMES,
      setThemeId: (id: string) => setThemeIdState(id),
      setMode: (m: ThemeMode) => setModeState(m),
    }),
    [themeId, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
