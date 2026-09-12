// Exercise the bundled CLI's real Unix WebSocket protocol in a private profile.
// No Desktop process, real task, credentials, paid model, or daemon service.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { BUNDLED_CLI } from "../src/wrapper.mjs";
import { RpcClient } from "../src/rpc.mjs";
import { observationConnection } from "../src/connection.mjs";
import { observeThread } from "../src/observe.mjs";
import { appServerDoctor } from "../src/launcher.mjs";

const root = await mkdtemp("/private/tmp/ct-transport-");
const directory = `${root}/app-server-control`, socket = `${directory}/app-server-control.sock`;
const env = { PATH: "/usr/bin:/bin", HOME: root, CODEX_HOME: root, RUST_LOG: "warn" };
let child, owner, diagnostics = "", providerRequests = 0;
const provider = createServer(async (request, response) => {
  for await (const _ of request) { /* consume the synthetic fixture request */ }
  providerRequests++;
  const item = { type: "message", id: "native-fixture-output", role: "assistant", content: [{ type: "output_text", text: "Synthetic fixture complete." }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "native-fixture-response" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "native-fixture-response", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(`${root}/config.toml`, `model = "gpt-5.4"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\nplugins = false\nremote_plugin = false\napps = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const originalMask = process.umask(0o077);
  try { child = spawn(BUNDLED_CLI, ["app-server", "--listen", `unix://${socket}`], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] }); }
  finally { process.umask(originalMask); }
  child.stderr.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-4000); });
  let launchError; child.on("error", error => { launchError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error("Isolated App Server exited during startup.");
    if (await lstat(socket).catch(() => null)) break;
    await delay(50);
  }
  // Fixture ownership is separate from the guarded observer. A real history
  // file is persisted only after a turn starts. Complete one with a local stub.
  owner = await RpcClient.connect(socket);
  const { thread } = await owner.request("thread/start", { cwd: root, model: "gpt-5.4", approvalPolicy: "never", sandbox: "read-only" });
  assert.ok(thread.id);
  await owner.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Synthetic native protocol fixture", text_elements: [] }] });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.request("thread/read", { threadId: thread.id })).thread.status.type === "idle" && providerRequests > 0) break;
    await delay(50);
  }
  const dependencies = () => {
    const connection = observationConnection("desktop");
    return { ...connection, discover: () => connection.discover(root) };
  };
  const result = await observeThread(thread.id, {}, dependencies());
  assert.equal(result.thread_id, thread.id); assert.equal(result.status, "idle");
  assert.equal(providerRequests, 1);
  assert.ok(result.events.some(event => event.text === "Synthetic native protocol fixture"));
  assert.ok(result.events.some(event => event.text === "Synthetic fixture complete."));
  const cliVersion = execFileSync(BUNDLED_CLI, ["--version"], { env, encoding: "utf8", timeout: 5000 }).trim();
  const report = await appServerDoctor({ threadId: thread.id, versions: { cli_version: cliVersion, desktop_version: "isolated-fixture" }, ...dependencies() });
  assert.equal(report.ready, true, JSON.stringify(report.failure));
  assert.equal(report.compatibility.status, "verified");
  assert.equal(report.runtime_compatibility.operations.send.status, "unsupported");
  assert.equal(report.runtime_compatibility.operations.send_new_turn.status, "unsupported");
  console.log(JSON.stringify({ suite: "isolated-desktop-transport", result: "PASS", cli: cliVersion,
    native_unix_websocket: true, loaded_target: true, history_scope: result.history_scope,
    mutations_disabled: true, fixture_model_requests: providerRequests, real_desktop_validated: false }));
} catch (error) { console.error(error.message); console.error(JSON.stringify({ code: error.code, rpc_code: error.rpcCode })); console.error(diagnostics); process.exitCode = 1; }
finally {
  owner?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await done; } finally { clearTimeout(timer); }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
  provider.closeAllConnections();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
}
