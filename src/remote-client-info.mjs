import { execFileSync } from "node:child_process";
import { VERSION } from "./version.mjs";

// The service derives its controller label from User-Agent. Keep our product
// identity truthful and supply OS information instead of the bare "codexteer".
export function remoteClientInfo({ platform = process.platform, arch = process.arch,
  systemVersion = () => execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim() } = {}) {
  const os = { darwin: "mac_os", win32: "windows", linux: "linux" }[platform] ?? platform;
  let system = { darwin: "Macintosh; Mac OS X", win32: "Windows NT 10.0", linux: "X11; Linux" }[platform] ?? platform;
  if (platform === "darwin") {
    try { const version = systemVersion(); if (/^\d+(?:\.\d+){0,2}$/.test(version)) system += ` ${version.replaceAll(".", "_")}`; } catch { /* OS information is optional, authentication is not. */ }
  }
  return { controller_name: `codexteer_${os}_${arch}`, user_agent: `codexteer/${VERSION} (${system}; ${arch})` };
}

export const REMOTE_CLIENT_INFO = remoteClientInfo();
