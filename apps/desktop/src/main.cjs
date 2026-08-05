/**
 * YoomClaw Desktop - Electron Main Process (CommonJS)
 *
 * 功能:
 *   - 创建主窗口 (无边框 + 自定义标题栏，Windows 风格窗口控件接 window.yoomclaw)
 *   - 应用启动时拉起 Gateway 子进程（node + tsx 跑 packages/gateway/src/bin.ts，监听 :18789）
 *   - 退出时杀掉 Gateway 子进程
 *   - 系统托盘 (常驻)，关闭/最小化行为由用户设置决定 (settings.cjs)
 *   - 系统通知 (AI 回复完成时)
 *   - 单实例锁
 *   - 开发模式加载 http://localhost:5173（Vite 渲染器 dev server）
 *   - 生产模式加载 ../dist/index.html（vite build 产物）
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  Notification,
  ipcMain,
  dialog,
  clipboard,
} = require("electron");
const nodePath = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const settingsStore = require("./settings.cjs");
const { readClipboardFilePaths } = require("./clipboard.cjs");
const { createUpdateManager } = require("./update-manager.cjs");

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownCloseHint = false;
let gatewayChild = null;
let gatewayRestartTimer = null;
let gatewayStopRequested = false;
let windowSizeSaveTimer = null;
let updateManager = null;
let aiTaskActive = false;

// 仓库根目录（apps/desktop/src -> YoomClaw/）
const ROOT = nodePath.resolve(__dirname, "..", "..", "..");
const E2E_LOG_DIR = process.env.YOOMCLAW_E2E_LOG_DIR;
const E2E_LOG_PATH = E2E_LOG_DIR ? nodePath.join(E2E_LOG_DIR, "electron.log") : null;
if (E2E_LOG_DIR) {
  try {
    fs.mkdirSync(E2E_LOG_DIR, { recursive: true });
    fs.appendFileSync(E2E_LOG_PATH, `[${new Date().toISOString()}] Electron main process started\n`, "utf8");
  } catch {}
}

// 开发模式：未打包时视为 dev（Electron 从源码启动时 isPackaged=false）
const isDev = !app.isPackaged;
const RENDERER_DEV_URL = process.env.CLAW_RENDERER_URL || "http://localhost:5173";

// 生产模式静态资源：vite build 产物（apps/desktop/renderer/dist）
const STATIC_DIR = nodePath.join(__dirname, "..", "renderer", "dist");

function defaultWorkspacePath() {
  const workspace = isDev ? ROOT : nodePath.join(app.getPath("documents"), "YoomClaw");
  try { fs.mkdirSync(workspace, { recursive: true }); } catch {}
  return workspace;
}

function getWorkspacePath() {
  const configured = settingsStore.load().workspace?.trim();
  return configured || process.env.YOOMCLAW_WORKSPACE?.trim() || process.env.CLAW_WORKSPACE?.trim() || defaultWorkspacePath();
}

function getUpdateManager() {
  if (!updateManager) {
    updateManager = createUpdateManager({
      app,
      shell,
      isDev,
      onState: (state) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("update:state", state);
      },
    });
  }
  return updateManager;
}

// ===== Gateway 子进程 =====
function resolveTsxCli() {
  const gwDir = nodePath.join(ROOT, "packages", "gateway");
  const candidates = [
    nodePath.join(gwDir, "node_modules", "tsx", "dist", "cli.mjs"),
    nodePath.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    nodePath.join(gwDir, "node_modules", ".bin", "tsx"),
    nodePath.join(ROOT, "node_modules", ".bin", "tsx"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function startGateway() {
  if (gatewayChild) return;
  gatewayStopRequested = false;
  const workspace = getWorkspacePath();
  const dataDir = nodePath.join(app.getPath("userData"), "YoomClaw");
  const envFile = nodePath.join(ROOT, ".env");
  const args = [];
  let command = "node";
  let cwd = ROOT;
  let helperDir = nodePath.join(ROOT, "packages", "gateway");

  if (isDev) {
    const tsxCli = resolveTsxCli();
    if (!tsxCli) {
      console.error("[Gateway] 找不到 tsx，无法启动 Gateway 子进程（请先安装 tsx）");
      return;
    }
    if (fs.existsSync(envFile)) args.push("--env-file=" + envFile);
    args.push(tsxCli, "packages/gateway/src/bin.ts");
  } else {
    command = process.execPath;
    cwd = workspace;
    helperDir = nodePath.join(process.resourcesPath, "runtime-helpers");
    args.push(nodePath.join(__dirname, "..", "runtime", "gateway.mjs"));
  }

  const gatewayEnv = {
    ...process.env,
    YOOMCLAW_WORKSPACE: workspace,
    CLAW_WORKSPACE: workspace,
    YOOMCLAW_DATA_DIR: dataDir,
    YOOMCLAW_HELPER_DIR: helperDir,
  };
  if (!isDev) gatewayEnv.ELECTRON_RUN_AS_NODE = "1";

  const e2eLogDir = E2E_LOG_DIR;
  const gatewayLogPath = e2eLogDir ? nodePath.join(e2eLogDir, "gateway.log") : null;
  if (e2eLogDir) fs.mkdirSync(e2eLogDir, { recursive: true });
  const appendGatewayLog = (chunk) => {
    if (!gatewayLogPath) return;
    try { fs.appendFileSync(gatewayLogPath, String(chunk), "utf8"); } catch {}
  };

  console.log("[Gateway] 启动子进程:", command, args.join(" "));
  gatewayChild = spawn(command, args, {
    cwd,
    stdio: e2eLogDir ? ["ignore", "pipe", "pipe"] : "inherit",
    env: gatewayEnv,
    windowsHide: true,
  });
  if (e2eLogDir) {
    gatewayChild.stdout?.on("data", appendGatewayLog);
    gatewayChild.stderr?.on("data", appendGatewayLog);
  }

  gatewayChild.on("error", (err) => {
    console.error("[Gateway] 子进程启动失败:", err.message);
  });
  gatewayChild.on("exit", (code, signal) => {
    if (!isQuitting) {
      console.warn(`[Gateway] 子进程退出 (code=${code}, signal=${signal})`);
    }
    gatewayChild = null;
    if (!isQuitting && !gatewayStopRequested && !gatewayRestartTimer) {
      console.warn("[Gateway] backend exited unexpectedly; restarting in 2 seconds");
      gatewayRestartTimer = setTimeout(() => {
        gatewayRestartTimer = null;
        if (!isQuitting && !gatewayChild) startGateway();
      }, 2000);
    }
  });
}

function stopGateway() {
  gatewayStopRequested = true;
  if (gatewayRestartTimer) {
    clearTimeout(gatewayRestartTimer);
    gatewayRestartTimer = null;
  }
  if (gatewayChild) {
    try {
      gatewayChild.kill("SIGTERM");
    } catch {}
    gatewayChild = null;
  }
}

function restartGateway() {
  stopGateway();
  gatewayRestartTimer = setTimeout(() => {
    gatewayRestartTimer = null;
    if (!isQuitting) {
      gatewayStopRequested = false;
      startGateway();
    }
  }, 250);
}

function createTrayIcon() {
  const iconPath = nodePath.join(__dirname, "..", "assets", "app-icon.png");
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img.resize({ width: 32, height: 32 });
  } catch {}
  // fallback：用螺旋 SVG（Windows 上 createFromPath 对 svg 支持有限，失败则透明）
  const svgPath = nodePath.join(__dirname, "..", "assets", "logo-spiral.svg");
  try {
    const svg = nativeImage.createFromPath(svgPath);
    if (!svg.isEmpty()) return svg;
  } catch {}
  return nativeImage.createEmpty();
}

/** 把设置里那些"要作用到系统/窗口"的项真正生效 */
function applyRuntimeSettings(s) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(!!s.alwaysOnTop);
    try {
      mainWindow.webContents.setZoomFactor(s.zoomFactor || 1);
    } catch {}
  }
  // dev 模式下注册的是 electron.exe，会污染用户的启动项，所以只在打包后真正写入
  if (!isDev) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!s.launchAtLogin,
        openAsHidden: !!s.startMinimized,
      });
    } catch (err) {
      console.error("[Settings] 开机自启设置失败:", err.message);
    }
  }
}

/** 通知渲染层窗口最大化状态变化，标题栏据此切换"最大化/还原"图标 */
function pushWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("window:state", {
    maximized: mainWindow.isMaximized(),
  });
}

function persistWindowSize() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
  const [width, height] = mainWindow.getSize();
  settingsStore.save({ windowWidth: width, windowHeight: height });
}

function scheduleWindowSizePersistence() {
  if (windowSizeSaveTimer !== null) clearTimeout(windowSizeSaveTimer);
  windowSizeSaveTimer = setTimeout(() => {
    windowSizeSaveTimer = null;
    persistWindowSize();
  }, 250);
}

function createWindow() {
  const settings = settingsStore.load();

  mainWindow = new BrowserWindow({
    width: settings.windowWidth,
    height: settings.windowHeight,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: process.platform === "darwin",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    alwaysOnTop: !!settings.alwaysOnTop,
    // 与渲染层默认主题（OpenCode dark）的 --bg 对齐，避免启动瞬间闪一下异色
    backgroundColor: "#0d0d0d",
    icon: nodePath.join(__dirname, "..", "assets", "app-icon.png"),
    webPreferences: {
      preload: nodePath.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const windowForLifecycle = mainWindow;
  let devLoadRetryTimer = null;

  if (isDev) {
    // Vite dev server 常比 Electron 晚几秒就绪，直接 loadURL 会吃到
    // ERR_CONNECTION_REFUSED 并永远停在空白窗口。这里失败即重试，最多 ~60s。
    let devLoadTries = 0;
    const MAX_DEV_LOAD_TRIES = 60;
    const loadDevUrl = () => {
      if (windowForLifecycle.isDestroyed()) return;
      windowForLifecycle.loadURL(RENDERER_DEV_URL).catch(() => {});
    };
    windowForLifecycle.webContents.on("did-fail-load", (_e, errorCode) => {
      if (errorCode === -3) return; // ERR_ABORTED：正常的导航打断，不算失败
      if (devLoadTries++ >= MAX_DEV_LOAD_TRIES) {
        console.error(
          `[YoomClaw] 连不上渲染器 dev server (${RENDERER_DEV_URL})，请确认 Vite 已启动`
        );
        return;
      }
      if (devLoadRetryTimer === null) {
        devLoadRetryTimer = setTimeout(() => {
          devLoadRetryTimer = null;
          loadDevUrl();
        }, 1000);
      }
    });
    loadDevUrl();
  } else {
    mainWindow.loadFile(nodePath.join(STATIC_DIR, "index.html"));
  }

  // 缩放要在页面加载完成后设置，否则会被这次导航重置掉
  windowForLifecycle.webContents.on("did-finish-load", () => {
    if (windowForLifecycle.isDestroyed()) return;
    try {
      windowForLifecycle.webContents.setZoomFactor(settingsStore.load().zoomFactor || 1);
    } catch {}
    windowForLifecycle.webContents.send("window:state", {
      maximized: windowForLifecycle.isMaximized(),
    });
  });

  windowForLifecycle.once("ready-to-show", () => {
    if (windowForLifecycle.isDestroyed()) return;
    // 开了"启动时最小化到托盘"就别抢焦点，静默待命
    if (settingsStore.load().startMinimized) return;
    windowForLifecycle.show();
    windowForLifecycle.focus();
  });

  mainWindow.on("maximize", pushWindowState);
  mainWindow.on("unmaximize", () => {
    pushWindowState();
    scheduleWindowSizePersistence();
  });
  mainWindow.on("resize", scheduleWindowSizePersistence);

  mainWindow.on("close", (e) => {
    persistWindowSize();
    if (isQuitting) return;

    // 关闭按钮行为由用户设置决定：收进托盘（默认）或直接退出
    if (settingsStore.load().closeAction === "quit") {
      isQuitting = true;
      return; // 放行，走正常退出流程
    }

    e.preventDefault();
    mainWindow && mainWindow.hide();
    if (!hasShownCloseHint) {
      showTrayNotification("YoomClaw 已最小化到托盘", "点击托盘图标恢复窗口");
      hasShownCloseHint = true;
    }
  });

  mainWindow.on("closed", () => {
    if (devLoadRetryTimer !== null) {
      clearTimeout(devLoadRetryTimer);
      devLoadRetryTimer = null;
    }
    if (windowSizeSaveTimer !== null) {
      clearTimeout(windowSizeSaveTimer);
      windowSizeSaveTimer = null;
    }
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: "deny" };
  });
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => {
        mainWindow && mainWindow.show();
        mainWindow && mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "新建对话",
      click: () => {
        mainWindow && mainWindow.show();
        mainWindow && mainWindow.focus();
        mainWindow && mainWindow.webContents.send("menu:new-chat");
      },
    },
    {
      label: "设置",
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("menu:open-settings");
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("YoomClaw - 本地 AI 助手");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function showTrayNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
}

// ===== IPC 通信 =====

ipcMain.handle("notify", async (_evt, payload) => {
  if (!settingsStore.load().notifyOnComplete) return;
  if (Notification.isSupported() && payload) {
    new Notification({
      title: payload.title || "YoomClaw",
      body: payload.body || "",
      silent: false,
    }).show();
  }
});

// ===== App updates =====

ipcMain.handle("update:state", async () => getUpdateManager().getState());
ipcMain.handle("update:check", async () => getUpdateManager().check());
ipcMain.handle("update:download", async () => getUpdateManager().download());
ipcMain.handle("update:install", async () => {
  if (aiTaskActive) return false;
  return getUpdateManager().install();
});
ipcMain.handle("update:open-downloaded", async () => getUpdateManager().openDownloaded());
ipcMain.handle("update:busy", async (_evt, busy) => {
  aiTaskActive = busy === true;
  return aiTaskActive;
});

ipcMain.handle("hide-to-tray", async () => {
  mainWindow && mainWindow.hide();
  showTrayNotification("YoomClaw 已最小化到托盘", "仍在后台运行");
});

ipcMain.handle("quit", async () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle("window:minimize", async () => {
  if (!mainWindow) return;
  // "最小化到托盘"时不进任务栏，直接隐藏窗口
  if (settingsStore.load().minimizeAction === "tray") {
    mainWindow.hide();
    if (!hasShownCloseHint) {
      showTrayNotification("YoomClaw 已最小化到托盘", "点击托盘图标恢复窗口");
      hasShownCloseHint = true;
    }
    return;
  }
  mainWindow.minimize();
});

ipcMain.handle("window:focus", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

ipcMain.handle("window:toggle-maximize", async () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle("window:close", async () => {
  mainWindow && mainWindow.close();
});

ipcMain.handle("window:is-maximized", async () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// Explorer keeps copied files in native clipboard formats instead of always
// exposing their paths through the renderer's ClipboardEvent. Read those
// formats in the main process so pasted image attachments retain their path.
ipcMain.handle("clipboard:file-paths", async () => readClipboardFilePaths(clipboard));

// ===== 应用设置 =====

ipcMain.handle("settings:get", async () => settingsStore.load());

ipcMain.handle("settings:set", async (_evt, patch) => {
  const next = settingsStore.save(patch || {});
  applyRuntimeSettings(next);
  return next;
});

ipcMain.handle("workspace:get", async () => getWorkspacePath());

ipcMain.handle("workspace:choose", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Agent 工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  const workspace = result.canceled ? null : result.filePaths[0];
  if (!workspace) return null;
  settingsStore.save({ workspace });
  restartGateway();
  return workspace;
});

ipcMain.handle("app:info", async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  dataDir: app.getPath("userData"),
  isDev,
}));

ipcMain.handle("app:open-data-dir", async () => {
  await shell.openPath(app.getPath("userData"));
});

ipcMain.handle("file:save-text", async (_evt, payload) => {
  if (!payload || typeof payload.content !== "string") {
    throw new Error("text content is required");
  }
  if (Buffer.byteLength(payload.content, "utf8") > 10 * 1024 * 1024) {
    throw new Error("text export is too large");
  }
  const requestedName = typeof payload.fileName === "string" ? payload.fileName : "yoomclaw-session.md";
  const safeName = nodePath.basename(requestedName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "-") || "yoomclaw-session.md";
  const e2eExportDir = process.env.YOOMCLAW_E2E_EXPORT_DIR?.trim();
  if (e2eExportDir) {
    // Test-only deterministic export path. The directory is supplied by the
    // isolated E2E harness; production runs never set this variable.
    await fs.promises.mkdir(e2eExportDir, { recursive: true });
    const exportPath = nodePath.join(e2eExportDir, safeName.endsWith(".md") ? safeName : `${safeName}.md`);
    await fs.promises.writeFile(exportPath, payload.content, "utf8");
    return exportPath;
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前对话",
    defaultPath: nodePath.join(app.getPath("downloads"), safeName.endsWith(".md") ? safeName : `${safeName}.md`),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, payload.content, "utf8");
  return result.filePath;
});

// ===== App Lifecycle =====

app.whenReady().then(() => {
  startGateway();
  createWindow();
  createTray();
  // 启动时把持久化设置同步到系统层（开机自启等）
  applyRuntimeSettings(settingsStore.load());
  getUpdateManager().start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow && mainWindow.show();
      mainWindow && mainWindow.focus();
    }
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  // 不退出，保留托盘
});

function prepareForQuit() {
  isQuitting = true;
  persistWindowSize();
  stopGateway();
}

app.on("before-quit-for-update", prepareForQuit);
app.on("before-quit", prepareForQuit);
