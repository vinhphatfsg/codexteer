import { stat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export async function fingerprintFile(input) {
  const ref = path.resolve(input), canonical = await realpath(ref), before = await stat(canonical);
  if (!before.isFile()) throw new Error("Evidence must be a file or an http(s)/codex URL.");
  const hash = createHash("sha256");
  for await (const data of createReadStream(canonical)) hash.update(data);
  const after = await stat(canonical);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || (await realpath(ref)) !== canonical) throw new Error("File changed while being fingerprinted. Try again after editing finishes.");
  return { type: "file", ref, path: canonical, size: after.size, mode: after.mode & 0o777, sha256: hash.digest("hex") };
}

export async function collectEvidence(refs = []) {
  return Promise.all(refs.map(async ref => {
    if (/^(https?|codex):\/\//i.test(ref)) {
      const url = new URL(ref);
      if (url.username || url.password) throw new Error("Evidence URLs must not contain credentials.");
      return { type: "url", ref: url.href, verification: "reference_only" };
    }
    return fingerprintFile(ref);
  }));
}

export async function verifyEvidence(evidence = []) {
  for (const old of evidence.filter(e => e.type === "file")) {
    let current;
    try { current = await fingerprintFile(old.ref); } catch { throw Object.assign(new Error("Evidence file is missing or changed. Read it again before sending."), { code: "STALE_EVIDENCE" }); }
    if (["path", "size", "mode", "sha256"].some(k => old[k] !== current[k])) throw Object.assign(new Error("Evidence file changed. Read it again before sending."), { code: "STALE_EVIDENCE" });
  }
}
