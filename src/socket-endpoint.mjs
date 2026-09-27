import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const unsafe = () => Object.assign(new Error("App Server socket has unsafe ownership, permissions, file type, or link target."), { code: "SOCKET_UNSAFE" });
const identity = info => [info.dev, info.ino, info.ctimeMs];
const same = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));

function checkSocket(info) {
  if (info.uid !== process.getuid() || (info.mode & 0o077) || !info.isSocket()) throw unsafe();
}

// Callers validate the advertised path's private parent directories separately.
// Codex 0.155 publishes a deterministic alias to a protected socket:
// codex-rs/app-server-transport/src/transport/unix_socket.rs and uds/src/daemon_directory.rs.
// Accept only that layout; never follow arbitrary links or repair permissions.
export async function inspectAppServerSocket(file) {
  const advertised = await fs.lstat(file);
  if (!advertised.isSymbolicLink()) {
    checkSocket(advertised);
    return { socket: file, fingerprint: [identity(advertised)] };
  }
  // Link permission bits do not describe access to its target.
  if (advertised.uid !== process.getuid()) throw unsafe();
  const canonical = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  // Upstream deliberately ignores TMPDIR, HOME and CODEX_HOME for this root.
  const directory = path.join(await fs.realpath("/tmp"), `codex-daemon-${process.getuid()}`);
  const socket = path.join(directory, createHash("sha256").update(canonical).digest("hex"));
  if (await fs.readlink(file) !== socket) throw unsafe();
  const parent = await fs.lstat(directory);
  if (parent.uid !== process.getuid() || !parent.isDirectory() || (parent.mode & 0o777) !== 0o700) throw unsafe();
  const target = await fs.lstat(socket);
  checkSocket(target); // lstat rejects a second link, even if it ends at a socket.
  const currentParent = await fs.lstat(directory);
  if (!same(advertised, await fs.lstat(file)) || await fs.readlink(file) !== socket
    || parent.dev !== currentParent.dev || parent.ino !== currentParent.ino
    || parent.mode !== currentParent.mode || parent.uid !== currentParent.uid) throw unsafe();
  // Directory timestamps change when unrelated profiles create sockets.
  return { socket, fingerprint: [identity(advertised), [parent.dev, parent.ino], identity(target)] };
}
