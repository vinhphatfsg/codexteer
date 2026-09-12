import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { codexHome } from "./runtime.mjs";

const UUID_IN_FILENAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function walk(directory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, output);
    else if (entry.isFile() && UUID_IN_FILENAME.test(entry.name)) output.push(entryPath);
  }));
}

async function readSessionMetadata(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const record = JSON.parse(firstLine);
    return record.type === "session_meta" ? record.payload : {};
  } finally {
    await handle.close();
  }
}

export async function listLocalThreads({
  limit = 20,
  desktopOnly = false,
  sessionsRoot = path.join(codexHome(), "sessions"),
} = {}) {
  const files = [];
  await walk(sessionsRoot, files);
  const recent = await Promise.all(files.map(async (filePath) => ({
    filePath,
    info: await stat(filePath),
  })));
  recent.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

  const threads = [];
  for (const item of recent) {
    if (threads.length >= limit) break;
    let metadata;
    try {
      metadata = await readSessionMetadata(item.filePath);
    } catch {
      continue;
    }
    if (desktopOnly && metadata.originator !== "Codex Desktop") continue;
    const filenameId = UUID_IN_FILENAME.exec(item.filePath)?.[1];
    const threadId = metadata.id ?? metadata.session_id ?? filenameId;
    if (!threadId) continue;
    threads.push({
      thread_id: threadId,
      updated_at: item.info.mtime.toISOString(),
      created_at: metadata.timestamp ?? null,
      cwd: metadata.cwd ?? null,
      originator: metadata.originator ?? null,
      deep_link: `codex://threads/${threadId}`,
    });
  }
  return threads;
}
