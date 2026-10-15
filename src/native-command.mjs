import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { BUNDLED_CLI, BUNDLED_NODE } from "./wrapper.mjs";
import { nativeRequest } from "./native-rpc.mjs";

const LIMIT = 8 * 1024 * 1024;
const failure = (message, code = "NATIVE_COMMAND_FAILED", uncertain = false) => Object.assign(new Error(message), { code, uncertain });

// An internal JSON-RPC error can arrive after a mutation has run. RpcFailure's
// default uncertain:false only describes the response, not rollback of effects.
// Only method/argument rejection proves that dispatch could not execute it.
export function mutationOutcomeUnknown(error) {
  return Number.isSafeInteger(error.rpcCode) ? ![-32601, -32602].includes(error.rpcCode) : error.uncertain !== false;
}

export function validateNativeCommandSchema(params, response) {
  for (const key of ["command", "cwd", "timeoutMs", "outputBytesCap", "sandboxPolicy"]) if (!params?.properties?.[key]) throw failure("Missing native helper command schema.", "NATIVE_COMMAND_UNVERIFIED");
  const readOnly = params.definitions?.SandboxPolicy?.oneOf?.find(policy => policy.properties?.type?.enum?.includes("readOnly"));
  if (readOnly?.properties?.networkAccess?.type !== "boolean" || !["exitCode", "stdout", "stderr"].every(key => response?.properties?.[key])) throw failure("Native helper sandbox/output schema is unverified.", "NATIVE_COMMAND_UNVERIFIED");
}

export function validateStandaloneCreationSchemas(schemas) {
  const required = { ThreadStartParams: ["cwd", "projectId", "runtimeWorkspaceRoots", "model", "config", "ephemeral"],
    ThreadStartResponse: ["thread"], TurnStartParams: ["threadId", "input", "clientUserMessageId", "effort"],
    TurnStartResponse: ["turn"], ThreadSetNameParams: ["threadId", "name"], ThreadMetadataUpdateParams: ["threadId", "projectId"] };
  for (const [name, keys] of Object.entries(required)) {
    if (!keys.every(key => schemas[name]?.properties?.[key])) throw failure(`Missing standalone creation schema: ${name}.`, "NATIVE_COMMAND_UNVERIFIED");
  }
}

export async function inspectNativeCommandProtocol(state, { run = spawnSync, executable = BUNDLED_CLI, standalone = false } = {}) {
  const version = run(executable, ["--version"], { encoding: "utf8", timeout: 5000 });
  const installed = version.stdout?.match(/codex-cli ([\w.+-]+)/)?.[1];
  if (version.status !== 0 || !installed || installed !== state.cli_version) throw failure("Native helper requires the installed bundled schema to match the running server.", "NATIVE_COMMAND_UNVERIFIED");
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexteer-native-schema-"));
  try {
    const generated = run(executable, ["app-server", "generate-json-schema", "--experimental", "--out", directory], { encoding: "utf8", timeout: 15000, maxBuffer: LIMIT });
    if (generated.status !== 0) throw failure("Cannot inspect native helper command schema.", "NATIVE_COMMAND_UNVERIFIED");
    const schemas = await Promise.all(["CommandExecParams", "CommandExecResponse"].map(async name => JSON.parse(await readFile(path.join(directory, "v2", `${name}.json`), "utf8"))));
    validateNativeCommandSchema(...schemas);
    if (standalone) {
      const names = ["ThreadStartParams", "ThreadStartResponse", "TurnStartParams", "TurnStartResponse", "ThreadSetNameParams", "ThreadMetadataUpdateParams"];
      const creation = Object.fromEntries(await Promise.all(names.map(async name => [name, JSON.parse(await readFile(path.join(directory, "v2", `${name}.json`), "utf8"))])));
      validateStandaloneCreationSchemas(creation); schemas.push(creation);
    }
    return { status: "verified", source: "matching-bundled-command-schema", cli_version: installed, schema_sha256: createHash("sha256").update(JSON.stringify(schemas)).digest("hex"), ...(standalone ? { standalone_creation: "verified" } : {}) };
  } catch (error) { if (error.code === "NATIVE_COMMAND_UNVERIFIED") throw error; throw failure("Cannot read native helper command schemas.", "NATIVE_COMMAND_UNVERIFIED"); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// command/exec is a deterministic App Server API, explicitly independent of
// threads/turns. It launches only our fixed signed-Node worker, never user code
// or a shell. The read-only sandbox allows the local native Unix socket; the
// worker has no HTTP/DNS behavior. No model is invoked.
export async function nativeOnAppServer(client, endpoint, action, args, context, { timeoutMs = 120000, callId } = {}) {
  const mutation = ["create_thread", "move_thread_to_project"].includes(action);
  const request = nativeRequest(action, args, context, callId);
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexteer-native-request-"));
  let result, error, dispatched = false;
  try {
    const input = JSON.stringify({ endpoint: { socketPath: endpoint.socketPath, fingerprint: endpoint.fingerprint }, action, args, context, timeoutMs, callId: request.params?.callId });
    if (Buffer.byteLength(input) > LIMIT) throw failure("Native helper request exceeds its limit.", "NATIVE_PROTOCOL_ERROR");
    const file = path.join(directory, "request.json");
    await writeFile(file, input, { mode: 0o600, flag: "wx" });
    dispatched = true;
    const output = await client.request("command/exec", {
      command: [BUNDLED_NODE, fileURLToPath(new URL("./native-worker.mjs", import.meta.url)), file],
      cwd: fileURLToPath(new URL("..", import.meta.url)), timeoutMs: timeoutMs + 1000, outputBytesCap: LIMIT * 2,
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    }, { mutation });
    let response;
    try { response = JSON.parse(output.stdout); } catch { throw failure("Native helper returned no valid acknowledgement. Inspect the receipt before retrying.", "NATIVE_PROTOCOL_ERROR", mutation); }
    if (response.ok === true && output.exitCode === 0 && Object.hasOwn(response, "result")) { result = response.result; return result; }
    if (response.ok === false && response.error) {
      const error = failure(response.error.message, response.error.code, !!response.error.uncertain);
      if (Number.isSafeInteger(response.error.rpcCode)) error.rpcCode = response.error.rpcCode;
      throw error;
    }
    throw failure("Native helper did not confirm success.", "NATIVE_PROTOCOL_ERROR", mutation);
  } catch (caught) {
    error = caught;
    if (error.uncertain === undefined || Number.isSafeInteger(error.rpcCode)) error.uncertain = dispatched && mutation && mutationOutcomeUnknown(error);
    throw error;
  } finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { if (result) result.native_request_cleanup_required = true; else if (error) error.native_request_cleanup_required = true; }
  }
}
