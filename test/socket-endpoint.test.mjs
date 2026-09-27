import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { inspectAppServerSocket } from "../src/socket-endpoint.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp("/private/tmp/ct-socket-");
  const alias = path.join(home, "rpc.sock");
  const directory = path.join(await fs.realpath("/tmp"), `codex-daemon-${process.getuid()}`);
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const socket = path.join(directory, createHash("sha256").update(alias).digest("hex"));
  const server = createServer(peer => peer.destroy());
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(socket, { force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  server.listen(socket); await once(server, "listening"); await fs.chmod(socket, 0o600);
  await fs.symlink(socket, alias);
  return { home, alias, directory, socket };
}

test("official aliases resolve to the private physical socket, independently of TMPDIR", async t => {
  const f = await fixture(t);
  const old = process.env.TMPDIR; process.env.TMPDIR = f.home;
  t.after(() => { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; });
  assert.equal((await inspectAppServerSocket(f.alias)).socket, f.socket);
  assert.equal((await inspectAppServerSocket(f.socket)).socket, f.socket);
  const before = await inspectAppServerSocket(f.alias);
  // Unrelated profiles may create files in the shared parent without replacing it.
  const unrelated = `${f.socket}.test`;
  await fs.writeFile(unrelated, "", { mode: 0o600 }); await fs.rm(unrelated);
  assert.deepEqual(await inspectAppServerSocket(f.alias), before);
});

test("arbitrary, relative, cross-profile and dangling aliases are rejected", async t => {
  const f = await fixture(t);
  for (const target of ["/tmp/not-a-codex-socket", path.relative(f.home, f.socket), `${f.socket}0`]) {
    await fs.rm(f.alias); await fs.symlink(target, f.alias);
    await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" });
  }
  const otherAlias = path.join(f.home, "another.sock");
  await fs.symlink(f.socket, otherAlias);
  await assert.rejects(inspectAppServerSocket(otherAlias), { code: "SOCKET_UNSAFE" });
  await fs.rm(f.alias); await fs.symlink(f.socket, f.alias); await fs.rm(f.socket);
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "ENOENT" });
});

test("permissive sockets, regular files and chained links remain unsafe", async t => {
  const f = await fixture(t);
  await fs.chmod(f.socket, 0o666);
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" });
  await assert.rejects(inspectAppServerSocket(f.socket), { code: "SOCKET_UNSAFE" });
  await fs.rm(f.socket); await fs.writeFile(f.socket, "not a socket", { mode: 0o600 });
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" });
  await fs.rm(f.socket); await fs.symlink(f.alias, f.socket);
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" });
});

test("foreign ownership and an unsafe protected directory fail closed without repairs", async t => {
  const f = await fixture(t), original = fs.lstat;
  // Model ownership and directory attacks without changing the live daemon root.
  for (const [file, patch] of [
    [f.alias, { uid: process.getuid() + 1 }],
    [f.directory, { uid: process.getuid() + 1 }],
    [f.directory, { mode: 0o40755 }],
    [f.directory, { mode: 0o120700 }],
    [f.socket, { uid: process.getuid() + 1 }],
  ]) {
    const mock = t.mock.method(fs, "lstat", async name => {
      const info = await original(name);
      return name === file ? Object.assign(info, patch) : info;
    });
    try { await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" }); }
    finally { mock.mock.restore(); }
  }
  assert.equal((await original(f.directory)).mode & 0o777, 0o700);
  assert.equal((await original(f.socket)).mode & 0o777, 0o600);
});

test("replacement during inspection fails and inspection denials stay permission errors", async t => {
  const f = await fixture(t), original = fs.readlink;
  const mock = t.mock.method(fs, "readlink", async file => {
    const target = await original(file);
    await fs.rm(file); await fs.symlink("/tmp/replaced-socket", file);
    return target;
  });
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "SOCKET_UNSAFE" });
  mock.mock.restore();
  await fs.rm(f.alias); await fs.symlink(f.socket, f.alias);
  const originalStat = fs.lstat;
  t.mock.method(fs, "lstat", file => {
    if (file === f.directory) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return originalStat(file);
  });
  await assert.rejects(inspectAppServerSocket(f.alias), { code: "EPERM" });
});
