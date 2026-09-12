import test from "node:test";
import assert from "node:assert/strict";
import { normalizeThreadId, threadComposerDeepLink, threadDeepLink } from "../src/thread-id.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

test("normalizes a UUID", () => {
  assert.equal(normalizeThreadId(THREAD_ID.toUpperCase()), THREAD_ID);
});

test("normalizes a Codex deep link", () => {
  assert.equal(normalizeThreadId(`codex://threads/${THREAD_ID}`), THREAD_ID);
});

test("rejects unrelated URLs and invalid IDs", () => {
  assert.throws(() => normalizeThreadId("codex://new"), /Expected codex/);
  assert.throws(() => normalizeThreadId("not-a-thread"), /Invalid local Codex thread ID/);
});

test("builds a deep link", () => {
  assert.equal(threadDeepLink(THREAD_ID), `codex://threads/${THREAD_ID}`);
});

test("builds a composer-focusing deep link", () => {
  assert.equal(threadComposerDeepLink(THREAD_ID), `codex://threads/${THREAD_ID}?prompt=`);
});

test("encodes a prompt in the composer deep link", () => {
  const link = new URL(threadComposerDeepLink(THREAD_ID, "日本語の指示\n次の行"));
  assert.equal(link.searchParams.get("prompt"), "日本語の指示\n次の行");
});
