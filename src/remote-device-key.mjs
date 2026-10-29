import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { BUNDLED_NODE } from "./wrapper.mjs";
import { controlFailure, verifyDeviceProof } from "./remote-control-auth.mjs";
import { validateDeviceKey } from "./remote-device-store.mjs";
import { keychainOperation } from "./remote-keychain.mjs";

const execute = promisify(execFile);
export async function deviceKey(operation, input = {}, { run = execute } = {}) {
  if (!["create", "inspect", "enrollment-proof", "connection-proof"].includes(operation)) throw controlFailure("Unsupported dedicated key operation.");
  if (input.provider === "keychain" || input.enrollment?.keyProvider === "keychain") return keychainOperation(operation, { ...input, runtime: input.runtime ?? input.enrollment?.keyRuntime });
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexteer-dedicated-key-"));
  try {
    const file = path.join(directory, "input.json");
    await writeFile(file, JSON.stringify({ operation, ...input }), { mode: 0o600, flag: "wx" });
    let response;
    try {
      const result = await run(BUNDLED_NODE, [fileURLToPath(new URL("./remote-device-worker.mjs", import.meta.url)), file], {
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", ELECTRON_RUN_AS_NODE: "" }, timeout: 10000, maxBuffer: 32768, windowsHide: true });
      response = JSON.parse(result.stdout);
    } catch { throw controlFailure("Dedicated key helper failed. No software key or Desktop key fallback was attempted.", "REMOTE_DEDICATED_KEY_UNAVAILABLE"); }
    if (response.ok !== true) {
      const stage = ["input", "addon", "create", "validate", "public-key", "sign"].includes(response.stage) ? response.stage : "worker";
      const reason = ["KEYCHAIN_UNAVAILABLE", "DEVICE_KEY_NOT_FOUND", "MISSING_ENTITLEMENT", "OS_INTERACTION_REQUIRED", "OS_KEY_OPERATION_FAILED"].includes(response.reason) ? response.reason : "UNAVAILABLE";
      const codes = Array.isArray(response.os_statuses) && response.os_statuses.every(Number.isSafeInteger) ? response.os_statuses.slice(0, 3) : [];
      throw Object.assign(controlFailure(`Dedicated OS key operation failed at ${stage} (${reason}${codes.length ? `: ${codes.join(",")}` : ""}).`, "REMOTE_DEDICATED_KEY_UNAVAILABLE"),
        { key_creation_rejected: stage === "create" && codes.includes(-34018) });
    }
    if (operation === "create") return validateDeviceKey(response.key);
    if (operation === "inspect") { if (response.verified !== true || response.proof) throw controlFailure("Invalid dedicated key inspection receipt."); return; }
    return response.proof;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function dedicatedConnectionProof(enrollment, challenge, context = {}) {
  return verifyDeviceProof(await deviceKey("connection-proof", { ...context, enrollment, challenge }), challenge, enrollment);
}
