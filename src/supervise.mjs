import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareDeployment } from "./distribution.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { codexHome } from "./runtime.mjs";
import { validateSupervisionPolicy } from "./prompt.mjs";
import { registerSupervisor, controlSupervisor } from "./supervision.mjs";
import { connectionMode } from "./connection.mjs";

export const SUPERVISOR_AGENTS = ["claude", "codex"];

function shellArgument(value) {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw Object.assign(new Error("Cannot generate supervision commands from a path containing control characters. Use a path without them and generate the prompt again."), { code: "SUPERVISION_PATH_UNSAFE" });
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function prepareSupervisorPrompt(threadInput, policy, { agent = "claude", connection = "shared" } = {}) {
  const threadId = normalizeThreadId(threadInput);
  validateSupervisionPolicy(policy);
  connectionMode(connection);
  if (!SUPERVISOR_AGENTS.includes(agent)) throw new Error("--agent must be claude or codex.");
  const node = { path: await realpath(process.execPath), version: process.version };
  const home = codexHome();
  shellArgument(node.path); shellArgument(home);
  const deployment = await prepareDeployment(home);
  // Bind the validated canonical profile as well as the saved executable.
  const supervisor = { session_id: randomUUID(), owner: agent, connection };
  const command = `CODEX_HOME=${shellArgument(deployment.codex_home)} ${shellArgument(node.path)} ${shellArgument(path.join(deployment.directory, "bin/codexteer.mjs"))} --require-node-version ${shellArgument(node.version)} --supervisor ${shellArgument(supervisor.session_id)} --connection ${connection}`;
  // Render with the saved distribution's implementation as well as its CLI.
  // An update to the source/cache after placement cannot mix prompt and code.
  const { supervisorPrompt } = await import(pathToFileURL(path.join(deployment.directory, "src/prompt.mjs")).href);
  return { ...supervisorPrompt(threadId, command, policy, supervisor), deployment, node, supervisor };
}

function launchFailure(agent, error) {
  return Object.assign(new Error(`Could not start ${agent} (${error.code ?? "START_FAILED"}). Check that it is installed and executable on PATH.`), { code: error.code ?? "START_FAILED" });
}

export async function superviseAgent(threadInput, { agent = "claude", agentArgs = [], policy, connection = "shared" } = {}) {
  const { prompt, thread_id: threadId, supervisor, deployment } = await prepareSupervisorPrompt(threadInput, policy, { agent, connection });
  const storage = { home: deployment.codex_home };
  await registerSupervisor(threadId, supervisor.session_id, { ...storage, owner: agent, launcherPid: process.pid, connection });
  try { return await launchSupervisorAgent(agent, agentArgs, prompt); }
  finally {
    try { await controlSupervisor(threadId, "stop", { ...storage, expectedSession: supervisor.session_id }); }
    catch (error) {
      // A user may have explicitly stopped this session and started another.
      if (error.code !== "SUPERVISOR_MISMATCH") process.stderr.write("codexteer: Supervisor cleanup failed; inspect supervise status before restarting.\n");
    }
  }
}

async function launchSupervisorAgent(agent, agentArgs, prompt) {
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
