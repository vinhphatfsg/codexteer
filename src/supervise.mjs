import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareCodexHome } from "./distribution.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { codexHome } from "./runtime.mjs";
import { supervisorPrompt as pathSupervisorPrompt, validateSupervisionPolicy } from "./prompt.mjs";
import { registerSupervisor, controlSupervisor } from "./supervision.mjs";
import { connectionMode } from "./connection.mjs";
import { preparePromptCommand, shellArgument, SUPERVISOR_AGENTS } from "./prompt-command.mjs";

export { SUPERVISOR_AGENTS };

export async function prepareSupervisorPrompt(threadInput, policy, { agent = "claude", connection = "shared", usePathCli = false } = {}) {
  const threadId = normalizeThreadId(threadInput);
  validateSupervisionPolicy(policy);
  connectionMode(connection);
  if (!SUPERVISOR_AGENTS.includes(agent)) throw new Error("--agent must be claude or codex.");
  const supervisor = { session_id: randomUUID(), owner: agent, connection };
  const sessionOptions = `--supervisor ${shellArgument(supervisor.session_id)} --connection ${connection}`;
  const { command: baseCommand, ...runtime } = await preparePromptCommand(usePathCli);
  const command = `${baseCommand} ${sessionOptions}`;
  if (usePathCli) {
    return { ...pathSupervisorPrompt(threadId, command, policy, supervisor, { usePathCli: true }), ...runtime, supervisor };
  }
  // Render with the saved distribution's implementation as well as its CLI.
  // An update to the source/cache after placement cannot mix prompt and code.
  const { supervisorPrompt } = await import(pathToFileURL(path.join(runtime.deployment.directory, "src/prompt.mjs")).href);
  return { ...supervisorPrompt(threadId, command, policy, supervisor), ...runtime, supervisor };
}

function launchFailure(agent, error) {
  return Object.assign(new Error(`Could not start ${agent} (${error.code ?? "START_FAILED"}). Check that it is installed and executable on PATH.`), { code: error.code ?? "START_FAILED" });
}

export async function superviseAgent(threadInput, { agent = "claude", agentArgs = [], policy, connection = "shared", usePathCli = false } = {}) {
  const { prompt, thread_id: threadId, supervisor, deployment } = await prepareSupervisorPrompt(threadInput, policy, { agent, connection, usePathCli });
  const storage = { home: deployment?.codex_home ?? await prepareCodexHome(codexHome()) };
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
