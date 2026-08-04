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
