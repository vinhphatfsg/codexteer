import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { listLocalThreads } from "../src/thread-store.mjs";

test("lists local session metadata without exposing transcript content", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-steer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "2026", "08", "27");
  await mkdir(day, { recursive: true });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  const file = path.join(day, `rollout-${id}.jsonl`);
  const metadata = {
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-08-27T00:00:00.000Z",
      cwd: "/tmp/project",
      originator: "Codex Desktop",
    },
  };
  await writeFile(file, `${JSON.stringify(metadata)}\n{"secret":"not returned"}\n`);

  const result = await listLocalThreads({ sessionsRoot: root, limit: 10, desktopOnly: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].thread_id, id);
  assert.equal(result[0].cwd, "/tmp/project");
  assert.equal(JSON.stringify(result).includes("not returned"), false);
});

test("CLI thread listing respects CODEX_HOME", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-steer-home-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sessions"));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, originator: "Codex Desktop" } }) + "\n");
  const result = spawnSync(process.execPath, ["bin/codex-steer.mjs", "threads", "list", "--json"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: root } });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).data.threads.map(thread => thread.thread_id), [id]);
});
