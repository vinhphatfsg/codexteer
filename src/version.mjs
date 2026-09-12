import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = metadata.version;
export const PACKAGE_NAME = metadata.name;
export const RUNTIME_PROTOCOL = 1;
const safeVersion = value => typeof value === "string" && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value);
if (!safeVersion(VERSION)) throw new Error("Invalid package version.");

export function versionCompatibility(state) {
  const runningVersion = safeVersion(state?.codex_steer_version) ? state.codex_steer_version : null;
  const runningPackage = typeof state?.codex_steer_package === "string" && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(state.codex_steer_package) && state.codex_steer_package.length <= 214 ? state.codex_steer_package : null;
  const runningProtocol = Number.isSafeInteger(state?.codex_steer_protocol) ? state.codex_steer_protocol : null;
  const unknown = !runningVersion || !runningPackage || runningProtocol === null;
  const matches = runningVersion === VERSION && runningPackage === PACKAGE_NAME && runningProtocol === RUNTIME_PROTOCOL;
  return {
    status: unknown ? "unverified" : matches ? "matched" : "mismatch",
    client: { package: PACKAGE_NAME, version: VERSION, protocol: RUNTIME_PROTOCOL },
    runtime: { package: runningPackage, version: runningVersion, protocol: runningProtocol },
  };
}

export function assertCompatibleVersion(state) {
  const result = versionCompatibility(state);
  if (result.status !== "matched") throw Object.assign(new Error("The running codex-steer wrapper is a different or unverified package/version/protocol. Use the same fixed version for Desktop startup and all operations. Finish current tasks before quitting and restarting Desktop."), {
    code: result.status === "unverified" ? "STEER_VERSION_UNVERIFIED" : "STEER_VERSION_MISMATCH",
  });
  return result;
}
