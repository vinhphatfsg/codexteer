import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RECORD = ".codex-steer-runtime.json";
const hash = value => createHash("sha256").update(value).digest("hex");
const failure = (message, code = "DEPLOYMENT_UNSAFE") => Object.assign(new Error(message), { code });
const safeName = name => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== "." && name !== "..";
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function check(info, directory, privateMode) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (privateMode ? info.uid !== process.getuid() || (info.mode & 0o7077) : ![0, process.getuid()].includes(info.uid) || (info.mode & 0o7022))
    || (!directory && (info.nlink !== 1 || info.size > 10 * 1024 * 1024))) {
    throw failure("Distribution has unsafe ownership, permissions, links, size, or file type.");
  }
}

async function ownedDirectory(directory, create = false) {
  if (create) await mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
  const info = await lstat(directory); check(info, true, true); return info;
}

async function checkAncestors(directory) {
  // A private leaf is not enough if somebody else can rename one of its
  // parents. Root-owned sticky temporary directories are the sole exception.
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await lstat(current);
    const stickyTemp = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid)
      || (info.mode & 0o6000) || ((info.mode & 0o022) && !stickyTemp)) throw failure("A distribution ancestor can be replaced by another user.");
    if (path.dirname(current) === current) break;
  }
}

async function resolveHome(home) {
  let existing = path.resolve(home), canonical;
  const missing = [];
  while (true) {
    try { canonical = await realpath(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing)); existing = path.dirname(existing);
    }
  }
  await checkAncestors(canonical);
  for (const part of missing) {
    canonical = path.join(canonical, part);
    await ownedDirectory(canonical, true);
  }
  return canonical;
}

async function readSafe(file, privateMode) {
  const before = await lstat(file); check(before, false, privateMode);
  // Do not follow a substituted leaf symlink or block on a substituted FIFO.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); check(info, false, privateMode);
    if (!sameFile(before, info)) throw failure("Distribution changed while being read.");
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length), after = await handle.stat();
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw failure("Distribution changed while being read.");
    return { bytes, info };
  } finally { await handle.close(); }
}

async function writeExclusive(file, bytes, mode) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

// The source is the installed package currently executing, never a path or
// manifest taken from task history, runtime state, or a remote response.
export async function describeDistribution(root = PACKAGE_ROOT) {
  root = await realpath(root);
  await checkAncestors(root);
  check(await lstat(root), true, false);
  const names = ["package.json", "LICENSE", "bin/codex-steer.mjs", "bin/codex-steer-wrapper.mjs", "assets/send-pururu.wav",
    "scripts/send.applescript", "scripts/inspect.applescript", "scripts/accessibility.applescript"];
  for (const directory of ["bin", "assets", "scripts", "src", "node_modules", "node_modules/ws", "node_modules/ws/lib"]) {
    check(await lstat(path.join(root, directory)), true, false);
  }
  for (const name of await readdir(path.join(root, "src"))) {
    if (safeName(name) && name.endsWith(".mjs")) names.push(`src/${name}`);
  }
  names.push(...["package.json", "LICENSE", "README.md", "index.js", "browser.js", "wrapper.mjs"].map(name => `node_modules/ws/${name}`));
  for (const name of await readdir(path.join(root, "node_modules/ws/lib"))) {
    if (!safeName(name) || !name.endsWith(".js")) throw failure("Unexpected file in the bundled ws dependency.");
    names.push(`node_modules/ws/lib/${name}`);
  }
  if (names.length > 256) throw failure("Distribution contains too many files.");
  const files = [], contents = new Map(); let total = 0;
  for (const name of names.sort()) {
    const { bytes, info } = await readSafe(path.join(root, name), false);
    const mode = name.startsWith("bin/") ? 0o700 : 0o600;
    if (mode === 0o700 && !(info.mode & 0o100)) throw failure("A distribution executable is missing its executable permission.");
    total += bytes.length;
    if (total > 32 * 1024 * 1024) throw failure("Distribution is too large.");
    files.push({ path: name, size: bytes.length, sha256: hash(bytes), mode }); contents.set(name, bytes);
  }
  const pkg = JSON.parse(contents.get("package.json"));
  if (typeof pkg.version !== "string" || pkg.version.length > 100 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)) throw failure("Invalid distribution version.");
  const ws = JSON.parse(contents.get("node_modules/ws/package.json"));
  if (ws.name !== "ws" || ws.version !== pkg.dependencies?.ws || Object.keys(ws.dependencies ?? {}).length) throw failure("Bundled dependencies do not match the distribution.");
  const manifest = { schema: 1, package: pkg.name, version: pkg.version, files };
  const sha256 = hash(JSON.stringify(manifest));
  return { root, manifest, sha256, id: `${pkg.version}-${sha256}`, contents };
}

export async function verifyDeployment(directory, distribution) {
  await ownedDirectory(directory);
  const expected = new Map(distribution.manifest.files.map(file => [file.path, file]));
  const record = Buffer.from(JSON.stringify({ manifest: distribution.manifest, sha256: distribution.sha256 }) + "\n");
  expected.set(RECORD, { size: record.length, sha256: hash(record), mode: 0o600 });
  const found = new Set();
  async function visit(relative = "") {
    const current = path.join(directory, relative); await ownedDirectory(current);
    for (const name of await readdir(current)) {
      if (name !== RECORD && !safeName(name)) throw failure("Unexpected deployment path.");
      const child = relative ? `${relative}/${name}` : name, file = path.join(directory, child);
      const info = await lstat(file);
      if (info.isDirectory()) {
        if (![...expected.keys()].some(key => key.startsWith(child + "/"))) throw failure("Unexpected deployment directory.");
        await visit(child); continue;
      }
      const entry = expected.get(child);
      if (!entry) throw failure("Unexpected deployment file.");
      const { bytes, info: opened } = await readSafe(file, true);
      if ((opened.mode & 0o777) !== entry.mode || bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw failure("Deployed files differ from the installed distribution.", "DEPLOYMENT_MODIFIED");
      found.add(child);
    }
  }
  await visit();
  if (found.size !== expected.size) throw failure("Deployment is incomplete.", "DEPLOYMENT_MODIFIED");
  return { directory, wrapper_path: path.join(directory, "bin/codex-steer-wrapper.mjs"), version: distribution.manifest.version, sha256: distribution.sha256 };
}

export async function prepareDeployment(home, { sourceRoot = PACKAGE_ROOT } = {}) {
  const distribution = await describeDistribution(sourceRoot);
  // CODEX_HOME may itself be a user-configured symlink; only its canonical
  // owner-writable directory is accepted. Never follow links below that root.
  const canonicalHome = await resolveHome(home);
  const homeInfo = await lstat(canonicalHome);
  if (!homeInfo.isDirectory() || homeInfo.uid !== process.getuid() || (homeInfo.mode & 0o7022)) throw failure("CODEX_HOME must be an owner-controlled directory.");
  const stateRoot = path.join(canonicalHome, "codex-steer"), root = path.join(stateRoot, "runtimes");
  await ownedDirectory(stateRoot, true); await ownedDirectory(root, true);
  const target = path.join(root, distribution.id), lock = path.join(root, `.install-${distribution.id}`);
  let lockInfo;
  // An abandoned lock is never stolen. A concurrent caller can reuse the
  // completed distribution after its installer releases this lock.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); lockInfo = await ownedDirectory(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await ownedDirectory(lock).catch(e => { if (e.code !== "ENOENT") throw e; });
      await delay(50);
    }
  }
  if (!lockInfo) throw failure("Runtime placement is busy or an earlier installation was interrupted. Inspect the installation lock before retrying.", "DEPLOYMENT_BUSY");
  let stage, stageInfo;
  try {
    const existing = await lstat(target).catch(e => { if (e.code !== "ENOENT") throw e; return null; });
    if (existing) return { ...await verifyDeployment(target, distribution), reused: true };
    stage = await mkdtemp(path.join(root, ".stage-")); stageInfo = await ownedDirectory(stage);
    for (const file of distribution.manifest.files) {
      const parts = file.path.split("/"); parts.pop(); let parent = stage;
      for (const part of parts) { parent = path.join(parent, part); await ownedDirectory(parent, true); }
      await writeExclusive(path.join(stage, file.path), distribution.contents.get(file.path), file.mode);
    }
    await writeExclusive(path.join(stage, RECORD), JSON.stringify({ manifest: distribution.manifest, sha256: distribution.sha256 }) + "\n", 0o600);
    await verifyDeployment(stage, distribution);
    // All cooperating installers hold the exclusive lock, and the parent is
    // private. Refuse even an empty existing directory rather than replacing it.
    if (await lstat(target).catch(e => { if (e.code !== "ENOENT") throw e; return null; })) throw failure("Deployment destination appeared during placement.");
    await rename(stage, target); stage = null;
    return { ...await verifyDeployment(target, distribution), reused: false };
  } finally {
    if (stage && sameFile(stageInfo, await lstat(stage).catch(() => ({})))) await rm(stage, { recursive: true });
    if (sameFile(lockInfo, await lstat(lock).catch(() => ({})))) await rm(lock, { recursive: true });
  }
}
