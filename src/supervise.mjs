import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDeployment } from "./distribution.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { codexHome } from "./runtime.mjs";

function shellArgument(value) {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw Object.assign(new Error("Cannot generate supervision commands from a path containing control characters. Use a path without them and generate the prompt again."), { code: "SUPERVISION_PATH_UNSAFE" });
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function prepareSupervisorPrompt(threadInput) {
  const threadId = normalizeThreadId(threadInput);
  const node = { path: await realpath(process.execPath), version: process.version };
  const home = codexHome();
  shellArgument(node.path); shellArgument(home);
  const deployment = await prepareDeployment(home);
  const command = `${shellArgument(node.path)} ${shellArgument(path.join(deployment.directory, "bin/codexteer.mjs"))} --require-node-version ${shellArgument(node.version)}`;
  // Render with the saved distribution's implementation as well as its CLI.
  // An update to the source/cache after placement cannot mix prompt and code.
  const { supervisorPrompt } = await import(pathToFileURL(path.join(deployment.directory, "src/prompt.mjs")).href);
  return { ...supervisorPrompt(threadId, command), deployment, node };
}

function launchFailure(agent, error) {
  return Object.assign(new Error(`Could not start ${agent} (${error.code ?? "START_FAILED"}). Check that it is installed and executable on PATH.`), { code: error.code ?? "START_FAILED" });
}

export async function superviseAgent(threadInput, { agent, agentArgs = [] } = {}) {
  if (agent !== "claude") throw new Error("supervise requires --agent claude. See codexteer help supervise.");
  const { prompt } = await prepareSupervisorPrompt(threadInput);

  let child;
  try {
    // Keep forwarded argv intact. The agent's own terminator keeps its variadic
    // options from consuming the generated prompt as another option value.
    child = spawn(agent, [...agentArgs, "--", prompt], { shell: false, stdio: "inherit" });
  } catch (error) { throw launchFailure(agent, error); }

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map(signal => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    const [code, signal] = await once(child, "exit");
    return code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
  } catch (error) { throw launchFailure(agent, error); }
  finally { signals.forEach((signal, index) => process.off(signal, handlers[index])); }
}
