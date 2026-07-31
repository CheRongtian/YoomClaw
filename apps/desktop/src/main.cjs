/**
 * YoomClaw Desktop - Electron Main Process (CommonJS)
 *
 * 功能:
 *   - 创建主窗口 (无边框 + 自定义标题栏，红黄绿控件接 window.yoomclaw)
 *   - 应用启动时拉起 Gateway 子进程（node + tsx 跑 packages/gateway/src/bin.ts，监听 :18789）
 *   - 退出时杀掉 Gateway 子进程
 *   - 系统托盘 (常驻) + 关闭最小化到托盘
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
} = require("electron");
const nodePath = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

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

// 仓库根目录（apps/desktop/src -> claw/）
const ROOT = nodePath.resolve(__dirname, "..", "..", "..");

// 开发模式：未打包时视为 dev（Electron 从源码启动时 isPackaged=false）
const isDev = !app.isPackaged;
const RENDERER_DEV_URL = process.env.CLAW_RENDERER_URL || "http://localhost:5173";

// 生产模式静态资源：vite build 产物（apps/desktop/renderer/dist）
const STATIC_DIR = nodePath.join(__dirname, "..", "renderer", "dist");

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
  const tsxCli = resolveTsxCli();
  if (!tsxCli) {
    console.error("[Gateway] 找不到 tsx，无法启动 Gateway 子进程（请先安装 tsx）");
    return;
  }

  const envFile = nodePath.join(ROOT, ".env");
  const args = ["--env-file=" + envFile, tsxCli, "packages/gateway/src/bin.ts"];

  console.log("[Gateway] 启动子进程:", "node", args.join(" "));
  gatewayChild = spawn("node", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });

  gatewayChild.on("error", (err) => {
    console.error("[Gateway] 子进程启动失败:", err.message);
  });
  gatewayChild.on("exit", (code, signal) => {
    if (!isQuitting) {
      console.warn(`[Gateway] 子进程退出 (code=${code}, signal=${signal})`);
    }
    gatewayChild = null;
  });
}

function stopGateway() {
  if (gatewayChild) {
    try {
      gatewayChild.kill("SIGTERM");
    } catch {}
    gatewayChild = null;
  }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: "#1a1b1e",
    icon: nodePath.join(__dirname, "..", "assets", "app-icon.png"),
    webPreferences: {
      preload: nodePath.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    mainWindow.loadFile(nodePath.join(STATIC_DIR, "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow && mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow && mainWindow.hide();
      if (!hasShownCloseHint) {
        showTrayNotification("YoomClaw 已最小化到托盘", "点击托盘图标恢复窗口");
        hasShownCloseHint = true;
      }
    }
  });

  mainWindow.on("closed", () => {
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
        mainWindow && mainWindow.webContents.send("menu:new-chat");
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
  if (Notification.isSupported() && payload) {
    new Notification({
      title: payload.title || "YoomClaw",
      body: payload.body || "",
      silent: false,
    }).show();
  }
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
  mainWindow && mainWindow.minimize();
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

// ===== App Lifecycle =====

app.whenReady().then(() => {
  startGateway();
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow && mainWindow.show();
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

app.on("before-quit", () => {
  isQuitting = true;
  stopGateway();
});
