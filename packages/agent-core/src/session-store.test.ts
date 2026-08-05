import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "./index.js";

test("SessionStore supports flags, search and message branching", () => {
  const store = new SessionStore();
  const session = store.create("Pinned session");
  store.appendMessage(session.id, { role: "user", content: "find this phrase" });

  store.setFlags(session.id, { pinned: true, archived: true });
  const summary = store.list()[0];
  assert.equal(summary.pinned, true);
  assert.equal(summary.archived, true);
  assert.equal(store.search("phrase")[0].id, session.id);

  const branched = store.truncateMessages(session.id, 0);
  assert.ok(branched);
  assert.equal(branched.messages.length, 0);
  assert.deepEqual(branched.runs, []);
});

test("SessionStore names a new conversation from its first user input", () => {
  const store = new SessionStore();
  const session = store.create();

  store.appendMessage(session.id, {
    role: "user",
    content: "  读取这个文件\n并总结重点  ",
  });

  assert.equal(store.get(session.id)?.title, "读取这个文件 并总结重点");

  store.appendMessage(session.id, { role: "user", content: "后续问题" });
  assert.equal(store.get(session.id)?.title, "读取这个文件 并总结重点");
});
