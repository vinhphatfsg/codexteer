import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectionMode, desktopReadOnly } from "./connection.mjs";
import { prepareBoundCommand } from "./prompt-command.mjs";
import { orchestrationPrompt, validateOrchestrationInput } from "./orchestrate-prompt.mjs";
import { prepareCodexHome } from "./distribution.mjs";
import { codexHome } from "./runtime.mjs";
import { launchAgent } from "./agent-launch.mjs";
import { targetContext, targetHost, hostFields } from "./target.mjs";

export async function prepareOrchestrationPrompt(project, goal, { agent, connection = "shared", usePathCli = false } = {}) {
  validateOrchestrationInput(project, goal, agent);
  if (connectionMode(connection) === "desktop") throw desktopReadOnly();
  const { command, ...runtime } = await prepareBoundCommand({ session: null, connection, context: targetContext() ?? process.env.CODEX_THREAD_ID }, usePathCli);
  // Cloud has no Desktop host route. Keep paired orchestration on its selected
  // host; local orchestration gets a separate, unbound Web Cloud command.
  const cloudCommand = targetHost() === "local"
    ? (await prepareBoundCommand({ session: null, connection: "cloud" }, usePathCli)).command : null;
  const render = usePathCli ? orchestrationPrompt
    : (await import(pathToFileURL(path.join(runtime.deployment.directory, "src/orchestrate-prompt.mjs")).href)).orchestrationPrompt;
  return { ...render(project, goal, command, { agent, usePathCli, cloudCommand }), command, cloud_command: cloudCommand, connection, ...runtime, ...hostFields() };
}

export async function orchestrateAgent(project, goal, { agent = "claude", agentArgs = [], connection = "shared", usePathCli = false } = {}) {
  const { prompt, deployment } = await prepareOrchestrationPrompt(project, goal, { agent, connection, usePathCli });
  // PATH prompt generation is side-effect free; direct launch still verifies
  // its Desktop profile before letting the agent start project work.
  if (!deployment) await prepareCodexHome(codexHome());
  return launchAgent(agent, agentArgs, prompt);
}
