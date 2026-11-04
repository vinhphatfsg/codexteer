import { spawnSync } from "node:child_process";

// Provenance only: local Git identity does not prove a Cloud checkout matches.
export function repositorySource(root) {
  const git = args => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 16384, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() || null : null;
  };
  let remote = git(["config", "--get", "remote.origin.url"]);
  if (remote?.includes("://")) {
    try { const url = new URL(remote); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; remote = url.href; } catch { remote = null; }
  }
  return { root, remote_url: remote, branch: git(["symbolic-ref", "--quiet", "--short", "HEAD"]), commit: git(["rev-parse", "--verify", "HEAD"]), cloud_checkout_match: "unverified" };
}
