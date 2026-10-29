import { readFile, realpath, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { discoverRuntime, codexHome } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { validateHostId } from "./target.mjs";

// Registration inventory, not a claim that a remote host is online. Desktop's
// native list currently drops projects when its remote Git metadata read fails.
export async function registeredRemoteProjects(home = codexHome()) {
  const file = path.join(home, ".codex-global-state.json");
  let state;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) throw failure("Unsafe Desktop project registry.", "PROJECT_REGISTRY_UNSAFE");
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const projects = state["remote-projects"] ?? [];
  if (!Array.isArray(projects)) throw failure("Invalid Desktop remote project registry.");
  const ids = new Set();
  return projects.map(project => {
    const hostId = validateHostId(project?.hostId);
    if (hostId === "local" || typeof project.id !== "string" || !project.id || typeof project.label !== "string" || typeof project.remotePath !== "string" || !project.remotePath || /[\0\r\n]/.test(project.remotePath)) throw failure("Invalid Desktop remote project registration.");
    const key = JSON.stringify([hostId, project.id]);
    if (ids.has(key)) throw failure("Duplicate Desktop remote project registration.");
    ids.add(key);
    return { project_id: project.id, desktop_project_ids: [project.id], name: project.label, roots: [project.remotePath],
      project_kind: "remote", host_id: hostId, source: "desktop-registration", availability: "unverified" };
  });
}

const failure = (message, code = "PROJECT_PROTOCOL_ERROR") => Object.assign(new Error(message), { code });

export function validateProject(project) {
  if (!project || typeof project.id !== "string" || !project.id || typeof project.name !== "string"
    || !Array.isArray(project.roots) || !project.roots.length
    || project.roots.some(root => typeof root?.path !== "string" || !path.isAbsolute(root.path) || root.path.includes("\0"))) {
    throw failure("App Server returned an invalid local project.");
  }
  return project;
}

export async function projectsOnClient(client) {
  const projects = [], cursors = new Set(), ids = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await client.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw failure("Invalid App Server project list.");
    for (const project of result.data) {
      validateProject(project);
      if (ids.has(project.id)) throw failure("Duplicate project ID in App Server project list.");
      ids.add(project.id); projects.push(project);
    }
    cursor = result.nextCursor;
    if (cursor == null) return projects;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw failure("Invalid project pagination cursor.");
    cursors.add(cursor);
  }
  throw failure("Project list exceeded the pagination limit.");
}

// Desktop keeps its legacy public IDs while App Server owns canonical IDs.
// Read this mapping only; never edit Desktop's state or infer membership by cwd.
export async function projectAliases(home) {
  try {
    const state = JSON.parse(await readFile(path.join(home, ".codex-global-state.json"), "utf8"));
    const mapping = state["app-server-project-id-by-legacy-project-id-by-host"]?.[`local:${home}`] ?? {};
    return Object.fromEntries(Object.entries(mapping).filter(([key, value]) => typeof key === "string" && typeof value === "string"));
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export function resolveProject(projects, selector, aliases = {}) {
  if (typeof selector !== "string" || !selector.trim()) throw failure("--project requires a project ID or exact name.", "PROJECT_REQUIRED");
  const id = aliases[selector] ?? selector;
  const exact = projects.find(project => project.id === id);
  if (exact) return exact;
  const matches = projects.filter(project => project.name === selector);
  if (matches.length !== 1) throw failure(matches.length ? "Multiple projects have this name. Select the ID from projects list." : "Local project not found. Select the ID or exact name from projects list.", matches.length ? "PROJECT_AMBIGUOUS" : "PROJECT_NOT_FOUND");
  return matches[0];
}

export async function projectWorkspace(project, requestedCwd) {
  validateProject(project);
  const roots = [...new Set(await Promise.all(project.roots.map(async root => {
    const resolved = await realpath(root.path);
    if (!(await stat(resolved)).isDirectory()) throw failure("Project root is not a directory.", "PROJECT_ROOT_UNAVAILABLE");
    return resolved;
  })))];
  const cwd = requestedCwd === undefined ? roots[0] : await realpath(path.resolve(requestedCwd));
  if (!(await stat(cwd)).isDirectory() || !roots.some(root => {
    const relative = path.relative(root, cwd);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  })) throw failure("--cwd must be a directory inside the selected project's source folders.", "PROJECT_CWD_OUTSIDE_ROOTS");
  return { cwd, runtimeWorkspaceRoots: roots };
}

export async function listProjects({ discover = discoverRuntime, connect = RpcClient.connect, aliases = projectAliases } = {}) {
  const { paths, state } = await discover();
  assertRuntimeOperation(state, "read");
  const client = compatibleClient(await connect(paths.socket), state);
  try {
    const projects = await projectsOnClient(client), mapping = await aliases(paths.home);
    return projects.map(project => ({ project_id: project.id, desktop_project_ids: Object.keys(mapping).filter(id => mapping[id] === project.id), name: project.name, roots: project.roots.map(root => root.path) }));
  } finally { client.close(); }
}
