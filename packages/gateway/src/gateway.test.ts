import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import WebSocket from "ws";
import { Gateway } from "./index.js";

test("Gateway exposes Hermes config without provider credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-gateway-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test", mode: "hermes" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "secret-share",
      authorization: "secret-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const configResponse = await fetch(`${base}/api/config`);
    assert.equal(configResponse.ok, true);
    const config = await configResponse.json() as Record<string, unknown>;
    assert.equal(config.mode, "hermes");
    assert.equal(config.workspace, root);
    assert.equal("authorization" in config, false);
    assert.equal("shareId" in config, false);

    const modeResponse = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "legacy" }),
    });
    assert.equal(modeResponse.ok, true);
    assert.equal((await modeResponse.json() as { mode: string }).mode, "legacy");

    const createResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gateway test" }),
    });
    assert.equal(createResponse.status, 201);
    const session = await createResponse.json() as { id: string };
    assert.equal((await fetch(`${base}/api/sessions/${session.id}`)).ok, true);

    const renameResponse = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed gateway test" }),
    });
    assert.equal(renameResponse.status, 200);
    assert.equal((await renameResponse.json() as { title: string }).title, "Renamed gateway test");

    const pinResponse = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinResponse.status, 200);
    assert.equal((await pinResponse.json() as { pinned: boolean }).pinned, true);

    const archiveResponse = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(archiveResponse.status, 200);
    assert.equal((await archiveResponse.json() as { archived: boolean }).archived, true);

    const searchResponse = await fetch(`${base}/api/sessions/search?q=renamed%20gateway`);
    assert.equal(searchResponse.status, 200);
    assert.deepEqual(
      (await searchResponse.json() as Array<{ id: string }>).map((item) => item.id),
      [session.id],
    );

    const branchResponse = await fetch(`${base}/api/sessions/${session.id}/branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIndex: 0 }),
    });
    assert.equal(branchResponse.status, 200);
    assert.equal((await branchResponse.json() as { messageCount: number }).messageCount, 0);

    const invalidBranchResponse = await fetch(`${base}/api/sessions/${session.id}/branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIndex: 1 }),
    });
    assert.equal(invalidBranchResponse.status, 400);

    const fixtureFile = path.join(root, "README.test.md");
    fs.writeFileSync(fixtureFile, "workspace preview\n");
    const treeResponse = await fetch(`${base}/api/workspace/tree?path=.`);
    assert.equal(treeResponse.status, 200);
    const tree = await treeResponse.json() as { entries: Array<{ name: string; type: string }> };
    assert.equal(tree.entries.some((entry) => entry.name === "README.test.md" && entry.type === "file"), true);

    const fileResponse = await fetch(`${base}/api/workspace/file?path=README.test.md`);
    assert.equal(fileResponse.status, 200);
    assert.equal((await fileResponse.json() as { content: string }).content, "workspace preview\n");

    const blockedResponse = await fetch(`${base}/api/workspace/file?path=..%2FREADME.test.md`);
    assert.equal(blockedResponse.status, 403);

    const outsideName = `yoomclaw-outside-${path.basename(root)}.txt`;
    const outsideFile = path.join(path.dirname(root), outsideName);
    fs.writeFileSync(outsideFile, "full access preview\n");
    try {
      const safetyResponse = await fetch(`${base}/api/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ safetyMode: "full-access" }),
      });
      assert.equal(safetyResponse.ok, true);
      assert.equal((await safetyResponse.json() as { safetyMode: string }).safetyMode, "full-access");
      const outsideResponse = await fetch(`${base}/api/workspace/file?path=${encodeURIComponent(`../${outsideName}`)}`);
      assert.equal(outsideResponse.status, 200);
      assert.equal((await outsideResponse.json() as { content: string }).content, "full access preview\n");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }

    const gitResponse = await fetch(`${base}/api/workspace/git`);
    assert.equal(gitResponse.status, 200);
    const git = await gitResponse.json() as { available: boolean; branch: string; status: string; diff: string };
    assert.equal(typeof git.available, "boolean");
    assert.equal(typeof git.branch, "string");
    assert.equal(typeof git.status, "string");
    assert.equal(typeof git.diff, "string");
  } finally {
    await gateway.stop();
  }
});

test("Gateway accepts ten attachment parts but rejects the eleventh before Agent execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-gateway-file-count-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test", mode: "hermes" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "secret-share",
      authorization: "secret-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const waitForMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Gateway WebSocket response")), 5_000);
      socket.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

  try {
    const socket = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    try {
      const tenParts = Array.from({ length: 10 }, (_, index) => ({
        type: "file_url",
        file_url: { url: `https://files.example.test/${index}.md`, fileId: String(index) },
      }));
      socket.send(JSON.stringify({
        type: "chat.start",
        sessionId: "missing-session",
        runId: "ten-files",
        message: { role: "user", content: tenParts },
      }));
      const tenResponse = await waitForMessage(socket);
      assert.equal(tenResponse.type, "error");
      assert.equal(tenResponse.code, undefined);
      assert.equal(tenResponse.message, "Session not found");

      const elevenParts = [...tenParts, {
        type: "file_url",
        file_url: { url: "https://files.example.test/11.md", fileId: "11" },
      }];
      socket.send(JSON.stringify({
        type: "chat.start",
        sessionId: "missing-session",
        runId: "eleven-files",
        message: { role: "user", content: elevenParts },
      }));
      const elevenResponse = await waitForMessage(socket);
      assert.equal(elevenResponse.type, "error");
      assert.equal(elevenResponse.code, "TOO_MANY_FILES");
      assert.equal(elevenResponse.runId, "eleven-files");

      const elevenImages = Array.from({ length: 11 }, (_, index) => ({
        type: "image_url",
        image_url: { url: `https://files.example.test/${index}.png` },
      }));
      socket.send(JSON.stringify({
        type: "chat.start",
        sessionId: "missing-session",
        runId: "eleven-images",
        message: { role: "user", content: elevenImages },
      }));
      const elevenImagesResponse = await waitForMessage(socket);
      assert.equal(elevenImagesResponse.type, "error");
      assert.equal(elevenImagesResponse.code, "TOO_MANY_IMAGES");
      assert.equal(elevenImagesResponse.runId, "eleven-images");
    } finally {
      socket.close();
    }
  } finally {
    await gateway.stop();
  }
});

test("Gateway aborts active runs before deleting a session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoomclaw-gateway-delete-run-"));
  const gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    workspace: root,
    dataDir: path.join(root, "data"),
    agentConfig: { provider: "jimo", model: "test", mode: "hermes" },
    jimoConfig: {
      baseUrl: "https://example.test",
      shareId: "secret-share",
      authorization: "secret-token",
    },
  });
  gateway.start();
  const server = (gateway as unknown as { httpServer: Server }).httpServer;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Delete run test" }),
    });
    const session = await createResponse.json() as { id: string };
    const controller = new AbortController();
    const activeRuns = (gateway as unknown as {
      activeRuns: Map<string, { sessionId: string; controller: AbortController }>;
    }).activeRuns;
    activeRuns.set("delete-run", { sessionId: session.id, controller });

    const deleteResponse = await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);
    assert.equal(controller.signal.aborted, true);
    assert.equal(activeRuns.has("delete-run"), false);
  } finally {
    await gateway.stop();
  }
});
