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
import { launchAgent } from "./agent-launch.mjs";

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

export async function superviseAgent(threadInput, { agent = "claude", agentArgs = [], policy, connection = "shared", usePathCli = false } = {}) {
  const { prompt, thread_id: threadId, supervisor, deployment } = await prepareSupervisorPrompt(threadInput, policy, { agent, connection, usePathCli });
  const storage = { home: deployment?.codex_home ?? await prepareCodexHome(codexHome()) };
  await registerSupervisor(threadId, supervisor.session_id, { ...storage, owner: agent, launcherPid: process.pid, connection });
  try { return await launchAgent(agent, agentArgs, prompt); }
  finally {
    try { await controlSupervisor(threadId, "stop", { ...storage, expectedSession: supervisor.session_id }); }
    catch (error) {
      // A user may have explicitly stopped this session and started another.
      if (error.code !== "SUPERVISOR_MISMATCH") process.stderr.write("codexteer: Supervisor cleanup failed; inspect supervise status before restarting.\n");
    }
  }
}
