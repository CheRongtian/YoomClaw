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
  applyReducedMotion,
  DEFAULT_MODE,
  DEFAULT_THEME_ID,
  getEffectiveMode,
  REDUCED_MOTION_KEY,
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
  reducedMotion: boolean;
  setThemeId: (id: string) => void;
  setMode: (mode: ThemeMode) => void;
  setReducedMotion: (reduced: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitial(): { themeId: string; mode: ThemeMode; reducedMotion: boolean } {
  if (typeof window === "undefined") {
    return { themeId: DEFAULT_THEME_ID, mode: DEFAULT_MODE, reducedMotion: false };
  }
  const savedThemeId = localStorage.getItem(THEME_ID_KEY);
  const themeId = savedThemeId && THEMES.some((theme) => theme.id === savedThemeId)
    ? savedThemeId
    : DEFAULT_THEME_ID;
  const savedMode = localStorage.getItem(THEME_MODE_KEY);
  const mode: ThemeMode = savedMode === "light" || savedMode === "dark" || savedMode === "system"
    ? savedMode
    : DEFAULT_MODE;
  const reducedMotion = localStorage.getItem(REDUCED_MOTION_KEY) === "true";
  return { themeId, mode, reducedMotion };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = readInitial();
  const [themeId, setThemeIdState] = useState(initial.themeId);
  const [mode, setModeState] = useState<ThemeMode>(initial.mode);
  const [reducedMotion, setReducedMotionState] = useState(initial.reducedMotion);

  // 应用 + 持久化
  useEffect(() => {
    applyPalette(themeId, mode);
    applyReducedMotion(reducedMotion);
    localStorage.setItem(THEME_ID_KEY, themeId);
    localStorage.setItem(THEME_MODE_KEY, mode);
    localStorage.setItem(REDUCED_MOTION_KEY, String(reducedMotion));
  }, [themeId, mode, reducedMotion]);

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
      reducedMotion,
      setThemeId: (id: string) => {
        if (THEMES.some((theme) => theme.id === id)) setThemeIdState(id);
      },
      setMode: (m: ThemeMode) => setModeState(m),
      setReducedMotion: (reduced: boolean) => setReducedMotionState(reduced),
    }),
    [themeId, mode, reducedMotion],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
