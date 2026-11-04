import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// Worker mutation adapters are separate from bootstrap, authentication and
// read-only diagnostics. Adding a sink requires an explicit boundary review.
const sinks = {
  sendWorkTellMessage: ["journal.mjs", "work-tell.mjs"], // internal managed delivery entry only
  sendDesktopMessage: ["desktop.mjs", "desktop-ui-send.mjs"], // desktop-ui gate, managed UI refused
  sendCloudTask: ["cloud-observe.mjs", "cloud-send.mjs"], // turn gate through journal
  sendDesktopCloudInput: ["desktop-cloud.mjs", "app-server.mjs"], // turn gate through journal
  runRemoteCommand: ["remote-io.mjs", "runner.mjs"], // paired-command gate
  runRemoteShellCommand: ["remote-io.mjs", "runner.mjs"], // thread-shell gate
};
const processOwners = {
  "repository-source.mjs": "read-only local Git provenance; fixed argv without a shell",
  "project-wait.mjs": "read-only OS process identity; fixed ps argv for one PID without a shell",
  "runner.mjs": "local-spawn gate",
  "wrapper.mjs": "explicit App Server bootstrap",
  "update.mjs": "explicit Desktop update lifecycle",
  "cloud.mjs": "legacy cloud CLI adapter",
  "cloud-api.mjs": "cloud authentication helper",
  "agent-launch.mjs": "explicit orchestrator launch",
  "turn-repair.mjs": "offline repair tooling",
  "sound.mjs": "notification sound",
  "remote-keychain.mjs": "credential lookup",
  "remote-key-access.mjs": "signed key access",
  "remote-device-login.mjs": "explicit browser authentication",
  "remote-device-key.mjs": "explicit device enrollment",
  "native-command.mjs": "native transport",
  "remote-client-info.mjs": "read-only system metadata",
  "launcher.mjs": "orchestrator lifecycle",
  "prompt-command.mjs": "CLI discovery",
  "cloud-cli.mjs": "legacy route CLI discovery",
  "native-rpc.mjs": "native transport",
  "desktop.mjs": "Desktop UI low-level adapter",
  "desktop-cloud-project.mjs": "read-only project discovery",
};
const mutationOwners = {
  "app-server.mjs": "turn gate via withSupervisedSend",
  "desktop-cloud.mjs": "turn gate via journal; explicit new worker bootstrap",
  "remote-io.mjs": "paired-command/thread-shell gates; accepted command cancellation",
  "thread-create.mjs": "explicit new worker bootstrap",
  "standalone-create.mjs": "explicit new worker bootstrap",
  "remote-management.mjs": "explicit new worker bootstrap",
};
function violations(file, source) {
  const errors = [];
  const opaque = source.replace(/(?:const|let)\s*\{[^{}.]*\}\s*=\s*await\s*import\(["'][^"']*journal\.mjs["']\)/g, "");
  if (!["journal.mjs", "work-tell.mjs"].includes(file) && /(?:import\s*\*\s*as\s+\w+\s*from|export\s*\*\s*from|import\s*\()\s*["'][^"']*journal\.mjs["']/.test(opaque)) errors.push("opaque journal import");
  for (const [sink, owners] of Object.entries(sinks)) if (new RegExp(`\\b${sink}\\b`).test(source) && !owners.includes(file)) errors.push(sink);
  if (/\bmutation\s*:\s*true\b/.test(source) && !mutationOwners[file]) errors.push("mutation RPC");
  // Import checks catch named aliases and namespace/dynamic imports as well as
  // ordinary calls. Disallow other process entry points in new modules too.
  if (/["'](?:node:)?child_process["']|\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/.test(source) && !processOwners[file]) errors.push("child_process");
  return errors;
}
async function sources(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.name.endsWith(".mjs")) result.push([path, await readFile(path, "utf8")]);
  }
  return result;
}
test("external-effect sinks are confined to reviewed adapters and bootstrap owners", async () => {
  for (const [file, source] of [...await sources("src"), ...await sources("bin")]) {
    // Nested modules cannot inherit a basename's exception.
    const owner = file.startsWith("src/") ? file.slice(4) : file;
    assert.deepEqual(violations(owner, source), [], file);
  }
  const kindAdapters = { "runner.mjs": ["local-spawn"], "desktop-ui-send.mjs": ["desktop-ui"],
    "remote-io.mjs": ["paired-command", "thread-shell"], "resource.mjs": ["resource-acquire"],
    "checkpoint.mjs": ["checkpoint-publish"], "supervision.mjs": ["turn"] };
  for (const [file, kinds] of Object.entries(kindAdapters)) {
    const source = await readFile(`src/${file}`, "utf8");
    for (const kind of kinds) assert.ok(source.includes(`"${kind}"`), `${file}: ${kind}`);
    assert.match(source, /dispatchExternalEffect/);
  }
  const gate = await readFile("src/supervision.mjs", "utf8");
  for (const kind of ["turn", "desktop-ui", "local-spawn", "paired-command", "thread-shell", "resource-acquire", "checkpoint-publish"]) assert.ok(gate.includes(`"${kind}"`), kind);
});
test("architecture guard rejects new direct sinks, aliases, namespace and dynamic process imports", () => {
  for (const source of [
    'import {spawn as launch} from "node:child_process"; launch("x")',
    'const p = await import("node:child_process"); p.spawn("x")',
    'import * as p from "child_process";',
    'import {sendDesktopMessage as send} from "./desktop.mjs";',
    'client.request("turn/steer", params, {mutation: true})',
    'import {sendWorkTellMessage as send} from "./journal.mjs";',
    'import * as journal from "./journal.mjs";',
    'const journal = await import("./journal.mjs");',
    'export * from "./journal.mjs";',
    'runRemoteCommand(args)', 'sendCloudTask(task)', 'sendDesktopCloudInput(task)',
  ]) assert.ok(violations("new-route.mjs", source).length, source);
});
