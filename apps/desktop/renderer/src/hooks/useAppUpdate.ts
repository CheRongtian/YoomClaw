import { useCallback, useEffect, useState } from "react";
import type { UpdateState } from "../types";

const INITIAL_STATE: UpdateState = {
  status: "not-available",
  currentVersion: "0.0.0",
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: "当前环境不支持应用更新",
  platform: "browser",
  arch: "unknown",
  enabled: false,
};

function normalizeState(value: unknown): UpdateState {
  if (!value || typeof value !== "object") return INITIAL_STATE;
  const raw = value as Partial<UpdateState>;
  return {
    ...INITIAL_STATE,
    ...raw,
    percent: typeof raw.percent === "number" ? raw.percent : 0,
    transferred: typeof raw.transferred === "number" ? raw.transferred : 0,
    total: typeof raw.total === "number" ? raw.total : 0,
    bytesPerSecond: typeof raw.bytesPerSecond === "number" ? raw.bytesPerSecond : 0,
    enabled: raw.enabled === true,
  };
}

export function getUpdateButtonLabel(state: UpdateState): string {
  switch (state.status) {
    case "checking": return "正在检查更新";
    case "available": return "有新版本";
    case "downloading": return `下载中 ${Math.round(state.percent)}%`;
    case "downloaded": return "重启更新";
    case "manual-install-required": return "打开更新包";
    case "error": return "重试更新";
    case "not-available": return "检查更新";
    default: return "检查更新";
  }
}

export function useAppUpdate({ busy = false }: { busy?: boolean } = {}) {
  const [state, setState] = useState<UpdateState>(INITIAL_STATE);
  const claw = typeof window !== "undefined" ? window.yoomclaw : undefined;

  useEffect(() => {
    if (!claw?.getUpdateState) return;
    let alive = true;
    const off = claw.on("update:state", (payload) => {
      if (alive) setState(normalizeState(payload));
    });
    void claw.getUpdateState()
      .then((next) => {
        if (alive) setState(normalizeState(next));
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [claw]);

  useEffect(() => {
    if (!claw?.setUpdateBusy) return;
    void claw.setUpdateBusy(busy).catch(() => {});
  }, [busy, claw]);

  const action = useCallback(async () => {
    if (!claw || !state.enabled || busy) return;
    if (state.status === "checking" || state.status === "downloading") return;
    if (state.status === "available") {
      await claw.downloadUpdate();
      return;
    }
    if (state.status === "downloaded") {
      await claw.installUpdate();
      return;
    }
    if (state.status === "manual-install-required") {
      await claw.openDownloadedUpdate();
      return;
    }
    await claw.checkForUpdate();
  }, [busy, claw, state]);

  return {
    state,
    action,
    label: getUpdateButtonLabel(state),
    disabled: !state.enabled || busy || state.status === "checking" || state.status === "downloading",
  };
}
