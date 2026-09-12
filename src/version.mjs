import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = metadata.version;
export const PACKAGE_NAME = metadata.name;
const safeVersion = value => typeof value === "string" && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value);
if (!safeVersion(VERSION)) throw new Error("Invalid package version.");

export function versionCompatibility(state) {
  const runningVersion = safeVersion(state?.codex_steer_version) ? state.codex_steer_version : null;
  const runningPackage = typeof state?.codex_steer_package === "string" && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(state.codex_steer_package) && state.codex_steer_package.length <= 214 ? state.codex_steer_package : null;
  const unknown = !runningVersion || !runningPackage;
  const matches = runningVersion === VERSION && runningPackage === PACKAGE_NAME;
  return {
    status: unknown ? "unverified" : matches ? "matched" : "mismatch",
    client: { package: PACKAGE_NAME, version: VERSION },
    runtime: { package: runningPackage, version: runningVersion },
  };
}
