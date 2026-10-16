import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectionMode, desktopReadOnly } from "./connection.mjs";
import { preparePromptCommand } from "./prompt-command.mjs";
import { orchestrationPrompt, validateOrchestrationInput } from "./orchestrate-prompt.mjs";
import { prepareCodexHome } from "./distribution.mjs";
import { codexHome } from "./runtime.mjs";
import { launchAgent } from "./agent-launch.mjs";

export async function prepareOrchestrationPrompt(project, goal, { agent, connection = "shared", usePathCli = false } = {}) {
  validateOrchestrationInput(project, goal, agent);
  if (connectionMode(connection) === "desktop") throw desktopReadOnly();
  const { command: baseCommand, ...runtime } = await preparePromptCommand(usePathCli);
  const command = `${baseCommand} --connection ${connection}`;
  const render = usePathCli ? orchestrationPrompt
    : (await import(pathToFileURL(path.join(runtime.deployment.directory, "src/orchestrate-prompt.mjs")).href)).orchestrationPrompt;
  return { ...render(project, goal, command, { agent, usePathCli }), connection, ...runtime };
}

export async function orchestrateAgent(project, goal, { agent = "claude", agentArgs = [], connection = "shared", usePathCli = false } = {}) {
  const { prompt, deployment } = await prepareOrchestrationPrompt(project, goal, { agent, connection, usePathCli });
  // PATH prompt generation is side-effect free; direct launch still verifies
  // its Desktop profile before letting the agent start project work.
  if (!deployment) await prepareCodexHome(codexHome());
  return launchAgent(agent, agentArgs, prompt);
}
