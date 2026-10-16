import { realpath } from "node:fs/promises";
import path from "node:path";
import { prepareDeployment } from "./distribution.mjs";
import { codexHome } from "./runtime.mjs";

export const SUPERVISOR_AGENTS = ["claude", "codex"];

export function shellArgument(value) {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw Object.assign(new Error("Cannot generate supervision commands from a path containing control characters. Use a path without them and generate the prompt again."), { code: "SUPERVISION_PATH_UNSAFE" });
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The command is intentionally unbound. Each workflow adds its own connection
// and, for single-thread supervision only, the generated supervisor ID.
export async function preparePromptCommand(usePathCli = false) {
  if (usePathCli) return { command: "codexteer", cli_mode: "path", deployment: null, node: null };
  const node = { path: await realpath(process.execPath), version: process.version };
  const home = codexHome();
  shellArgument(node.path); shellArgument(home);
  const deployment = await prepareDeployment(home);
  const command = `CODEX_HOME=${shellArgument(deployment.codex_home)} ${shellArgument(node.path)} ${shellArgument(path.join(deployment.directory, "bin/codexteer.mjs"))} --require-node-version ${shellArgument(node.version)}`;
  return { command, cli_mode: "saved", deployment, node };
}
