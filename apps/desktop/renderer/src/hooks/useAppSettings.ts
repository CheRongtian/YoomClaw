import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";

/**
 * 读写主进程持久化设置（关闭行为 / 开机自启 / 置顶 等）。
 * 浏览器里直接打开 Gateway UI 时没有 window.yoomclaw，此时 available=false，
 * 调用方应把相关设置项标记为"仅桌面端可用"而不是崩掉。
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);
  const updateRevisionRef = useRef(0);
  const updateQueueRef = useRef(Promise.resolve());

  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  useEffect(() => {
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (!claw?.getSettings) {
      setLoading(false);
      return;
    }
    let alive = true;
    claw
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setAvailable(true);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;
    if (!claw?.updateSettings) return;
    const revision = ++updateRevisionRef.current;
    // 乐观更新：开关手感要跟手，主进程返回后再对齐一次真实值
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    const operation = updateQueueRef.current.then(async () => {
      try {
        const next = await claw.updateSettings(patch);
        if (aliveRef.current && revision === updateRevisionRef.current) setSettings(next);
      } catch {
        if (!aliveRef.current || revision !== updateRevisionRef.current) return;
        try {
          const next = await claw.getSettings();
          if (aliveRef.current && revision === updateRevisionRef.current) setSettings(next);
        } catch {}
      }
    });
    updateQueueRef.current = operation.then(() => undefined, () => undefined);
    await operation;
  }, []);

  return { settings, available, loading, update };
}
