const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  compareVersions,
  createUpdateManager,
  releaseVersion,
  selectMacAsset,
} = require("./update-manager.cjs");

test("compares release versions without the v prefix", () => {
  assert.equal(compareVersions("v0.3.0", "0.2.0"), 1);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.equal(releaseVersion({ tag_name: "v0.4.0" }), "0.4.0");
});

test("selects only the Apple Silicon DMG", () => {
  const assets = [
    { name: "YoomClaw-0.3.0-x64.dmg" },
    { name: "YoomClaw-0.3.0-arm64.dmg" },
    { name: "YoomClaw-0.3.0-arm64.zip" },
  ];
  assert.equal(selectMacAsset(assets, "x64"), null);
  assert.equal(selectMacAsset(assets, "arm64").name, "YoomClaw-0.3.0-arm64.dmg");
});

test("does not contact Releases in development mode", async () => {
  let checks = 0;
  const manager = createUpdateManager({
    app: { getVersion: () => "0.2.0" },
    isDev: true,
    platform: "win32",
    autoUpdater: {
      on() {},
      checkForUpdates: async () => { checks += 1; },
    },
  });

  assert.equal(manager.getState().status, "not-available");
  assert.equal(manager.getState().enabled, false);
  await manager.check();
  assert.equal(checks, 0);
});

test("drives the Windows check, download, and install states", async () => {
  const listeners = new Map();
  const calls = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(name, callback) { listeners.set(name, callback); },
    async checkForUpdates() {
      calls.push("check");
      listeners.get("checking-for-update")?.();
      listeners.get("update-available")?.({ version: "0.3.0" });
    },
    async downloadUpdate() {
      calls.push("download");
      listeners.get("download-progress")?.({ percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 });
      listeners.get("update-downloaded")?.({ version: "0.3.0" });
    },
    quitAndInstall(...args) {
      calls.push(["install", ...args]);
    },
  };
  const manager = createUpdateManager({
    app: { getVersion: () => "0.2.0" },
    isDev: false,
    platform: "win32",
    arch: "x64",
    autoUpdater: updater,
  });

  await manager.check();
  assert.equal(manager.getState().status, "available");
  assert.equal(manager.getState().targetVersion, "0.3.0");

  await manager.download();
  assert.equal(manager.getState().status, "downloaded");
  assert.equal(manager.getState().percent, 100);
  assert.equal(manager.install(), true);
  assert.deepEqual(calls, ["check", "download", ["install", false, true]]);
});

test("downloads an arm64 macOS DMG for manual installation", async () => {
  const downloadsPath = await fs.mkdtemp(path.join(os.tmpdir(), "yoomclaw-update-"));
  let openedPath = null;
  const manager = createUpdateManager({
    app: { getVersion: () => "0.2.0" },
    isDev: false,
    platform: "darwin",
    arch: "arm64",
    shell: { openPath: async (value) => { openedPath = value; return ""; } },
    getDownloadsPath: () => downloadsPath,
    requestJsonImpl: async () => ({
      tag_name: "v0.3.0",
      assets: [
        { name: "YoomClaw-0.3.0-x64.dmg", browser_download_url: "https://example.test/x64", size: 4 },
        { name: "YoomClaw-0.3.0-arm64.dmg", browser_download_url: "https://example.test/arm64", size: 4 },
      ],
    }),
    downloadFileImpl: async (_url, destination, _size, onProgress) => {
      onProgress({ transferred: 2, total: 4 });
      onProgress({ transferred: 4, total: 4 });
      await fs.writeFile(destination, "dmg");
      return destination;
    },
  });

  await manager.check();
  assert.equal(manager.getState().status, "available");
  await manager.download();
  assert.equal(manager.getState().status, "manual-install-required");
  assert.match(manager.getState().downloadedPath, /YoomClaw-0\.3\.0-arm64\.dmg$/);
  assert.equal(await manager.openDownloaded(), true);
  assert.equal(openedPath, manager.getState().downloadedPath);

  await fs.rm(downloadsPath, { recursive: true, force: true });
});
