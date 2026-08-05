const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");

const UPDATE_REPOSITORY = Object.freeze({
  owner: "Alex-Wang-88",
  repo: "YoomClaw",
});

const UPDATE_STATUSES = Object.freeze([
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "manual-install-required",
  "not-available",
  "error",
]);

function versionParts(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function releaseVersion(release) {
  return String(release?.tag_name || release?.name || "").replace(/^v/i, "").trim();
}

function selectMacAsset(assets, arch = process.arch) {
  const candidates = Array.isArray(assets)
    ? assets.filter((asset) => typeof asset?.name === "string" && /\.dmg$/i.test(asset.name))
    : [];
  if (arch !== "arm64") return null;
  return candidates.find((asset) => /(?:^|[-_.])arm64(?:[-_.]|$)/i.test(asset.name)) || null;
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "更新失败");
}

function requestBuffer(url, headers = {}, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("更新服务器重定向次数过多"));
  const parsed = new URL(url);
  const transport = parsed.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, {
      headers: {
        "User-Agent": "YoomClaw-Updater",
        ...headers,
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        requestBuffer(new URL(response.headers.location, parsed).toString(), headers, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`更新服务器返回 HTTP ${status}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("更新请求超时")));
  });
}

async function requestJson(url, headers = {}) {
  const body = await requestBuffer(url, { Accept: "application/vnd.github+json", ...headers });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("更新服务器返回了无效 JSON");
  }
}

function downloadFile(url, destination, expectedSize, onProgress, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("更新下载重定向次数过多"));
  const parsed = new URL(url);
  const transport = parsed.protocol === "http:" ? http : https;
  const temporary = `${destination}.download`;
  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "YoomClaw-Updater",
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, parsed).toString(), destination, expectedSize, onProgress, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`更新下载返回 HTTP ${status}`));
        return;
      }

      const total = Number(response.headers["content-length"] || expectedSize || 0) || 0;
      let transferred = 0;
      const output = fs.createWriteStream(temporary);
      const fail = (error) => {
        output.destroy();
        void fsp.rm(temporary, { force: true }).finally(() => reject(error));
      };
      response.on("data", (chunk) => {
        transferred += chunk.length;
        onProgress?.({ transferred, total });
      });
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", async () => {
        try {
          const stat = await fsp.stat(temporary);
          if (expectedSize && stat.size !== expectedSize) {
            throw new Error("更新文件大小校验失败");
          }
          await fsp.rename(temporary, destination);
          resolve(destination);
        } catch (error) {
          await fsp.rm(temporary, { force: true }).catch(() => {});
          reject(error);
        }
      });
      response.pipe(output);
    });
    request.on("error", (error) => {
      void fsp.rm(temporary, { force: true }).finally(() => reject(error));
    });
    request.setTimeout(60_000, () => request.destroy(new Error("更新下载超时")));
  });
}

function createInitialState({ currentVersion, platform, arch, enabled }) {
  return {
    status: enabled ? "idle" : "not-available",
    currentVersion,
    targetVersion: undefined,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    downloadedPath: undefined,
    message: enabled ? "尚未检查更新" : "开发模式不检查更新",
    platform,
    arch,
    enabled,
  };
}

function createUpdateManager({
  app,
  shell,
  isDev = !app?.isPackaged,
  platform = process.platform,
  arch = process.arch,
  autoUpdater: suppliedUpdater,
  repository = UPDATE_REPOSITORY,
  onState,
  getDownloadsPath,
  requestJsonImpl = requestJson,
  downloadFileImpl = downloadFile,
} = {}) {
  const currentVersion = app?.getVersion?.() || "0.0.0";
  const enabled = !isDev && (platform === "win32" || platform === "darwin");
  let state = createInitialState({ currentVersion, platform, arch, enabled });
  let updater = suppliedUpdater || null;
  let updaterConfigured = false;
  let macRelease = null;
  let macAsset = null;
  let checkPromise = null;
  let downloadPromise = null;

  const emit = (next) => {
    state = {
      ...state,
      ...next,
    };
    onState?.(state);
    return state;
  };

  const transition = (status, next = {}) => emit({
    status,
    percent: status === "downloading" ? state.percent : 0,
    ...next,
  });

  function configureWindowsUpdater() {
    if (updaterConfigured || platform !== "win32" || !enabled) return updater;
    if (!updater) {
      try {
        updater = require("electron-updater").autoUpdater;
      } catch (error) {
        transition("error", { message: `无法加载 Windows 更新模块：${errorMessage(error)}` });
        return null;
      }
    }
    updaterConfigured = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => transition("checking", { message: "正在检查更新" }));
    updater.on("update-available", (info) => transition("available", {
      targetVersion: info?.version,
      message: `发现新版本 ${info?.version || ""}`.trim(),
    }));
    updater.on("update-not-available", () => transition("not-available", { message: "当前已是最新版本" }));
    updater.on("download-progress", (progress) => transition("downloading", {
      targetVersion: state.targetVersion,
      percent: Number.isFinite(progress?.percent) ? progress.percent : 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
      bytesPerSecond: progress?.bytesPerSecond || 0,
      message: `正在下载更新 ${Math.round(progress?.percent || 0)}%`,
    }));
    updater.on("update-downloaded", (info) => transition("downloaded", {
      targetVersion: info?.version || state.targetVersion,
      percent: 100,
      message: "更新已下载，点击重启更新",
    }));
    updater.on("error", (error) => transition("error", { message: `更新失败：${errorMessage(error)}` }));
    return updater;
  }

  async function checkWindows() {
    const activeUpdater = configureWindowsUpdater();
    if (!activeUpdater) return state;
    transition("checking", { message: "正在检查更新" });
    try {
      await activeUpdater.checkForUpdates();
    } catch (error) {
      transition("error", { message: `更新检查失败：${errorMessage(error)}` });
    }
    return state;
  }

  async function checkMac() {
    if (arch !== "arm64") {
      return transition("error", { message: "当前 macOS 版本仅支持 Apple Silicon" });
    }
    transition("checking", { message: "正在检查更新" });
    try {
      const release = await requestJsonImpl(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`);
      const nextVersion = releaseVersion(release);
      if (!nextVersion || compareVersions(nextVersion, currentVersion) <= 0) {
        macRelease = null;
        macAsset = null;
        return transition("not-available", { message: "当前已是最新版本" });
      }
      const asset = selectMacAsset(release.assets, arch);
      if (!asset?.browser_download_url) {
        return transition("error", { targetVersion: nextVersion, message: "Release 中没有可用的 macOS arm64 DMG" });
      }
      macRelease = release;
      macAsset = asset;
      return transition("available", {
        targetVersion: nextVersion,
        message: `发现新版本 ${nextVersion}`,
      });
    } catch (error) {
      return transition("error", { message: `更新检查失败：${errorMessage(error)}` });
    }
  }

  async function check() {
    if (!enabled) return state;
    if (checkPromise) return checkPromise;
    checkPromise = platform === "win32" ? checkWindows() : checkMac();
    try {
      return await checkPromise;
    } finally {
      checkPromise = null;
    }
  }

  async function downloadWindows() {
    const activeUpdater = configureWindowsUpdater();
    if (!activeUpdater || state.status !== "available") return state;
    transition("downloading", { message: "正在下载更新" });
    try {
      await activeUpdater.downloadUpdate();
    } catch (error) {
      transition("error", { message: `更新下载失败：${errorMessage(error)}` });
    }
    return state;
  }

  async function downloadMac() {
    if (state.status !== "available" || !macAsset || !macRelease) return state;
    const downloadsPath = getDownloadsPath?.() || app?.getPath?.("downloads") || process.cwd();
    const safeVersion = releaseVersion(macRelease).replace(/[^0-9A-Za-z.-]/g, "-");
    const destination = path.join(downloadsPath, `YoomClaw-${safeVersion}-arm64.dmg`);
    await fsp.mkdir(downloadsPath, { recursive: true });
    transition("downloading", { message: "正在下载 macOS 更新", percent: 0 });
    try {
      await downloadFileImpl(macAsset.browser_download_url, destination, Number(macAsset.size) || 0, ({ transferred, total }) => {
        const percent = total ? (transferred / total) * 100 : 0;
        transition("downloading", {
          targetVersion: releaseVersion(macRelease),
          percent,
          transferred,
          total,
          message: `正在下载 macOS 更新 ${Math.round(percent)}%`,
        });
      });
      return transition("manual-install-required", {
        targetVersion: releaseVersion(macRelease),
        percent: 100,
        downloadedPath: destination,
        message: "更新包已下载，点击打开并手动替换应用",
      });
    } catch (error) {
      return transition("error", { message: `macOS 更新下载失败：${errorMessage(error)}` });
    }
  }

  async function download() {
    if (!enabled || downloadPromise) return state;
    downloadPromise = platform === "win32" ? downloadWindows() : downloadMac();
    try {
      return await downloadPromise;
    } finally {
      downloadPromise = null;
    }
  }

  function install() {
    if (platform !== "win32" || state.status !== "downloaded") return false;
    const activeUpdater = configureWindowsUpdater();
    if (!activeUpdater) return false;
    activeUpdater.quitAndInstall(false, true);
    return true;
  }

  async function openDownloaded() {
    if (!state.downloadedPath || !fs.existsSync(state.downloadedPath)) {
      transition("error", { message: "找不到已下载的更新包，请重新检查更新" });
      return false;
    }
    if (platform === "darwin") {
      const error = await shell?.openPath?.(state.downloadedPath);
      if (error) {
        transition("error", { message: `无法打开更新包：${error}` });
        return false;
      }
    } else {
      shell?.showItemInFolder?.(state.downloadedPath);
    }
    return true;
  }

  function start() {
    if (!enabled) return;
    setTimeout(() => void check(), 1800);
  }

  return {
    getState: () => state,
    start,
    check,
    download,
    install,
    openDownloaded,
    configureWindowsUpdater,
  };
}

module.exports = {
  UPDATE_REPOSITORY,
  UPDATE_STATUSES,
  compareVersions,
  createUpdateManager,
  releaseVersion,
  selectMacAsset,
};
