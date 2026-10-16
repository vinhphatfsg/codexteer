import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectionMode, desktopReadOnly } from "./connection.mjs";
import { preparePromptCommand } from "./prompt-command.mjs";
import { orchestrationPrompt, validateOrchestrationInput } from "./orchestrate-prompt.mjs";

export async function prepareOrchestrationPrompt(project, goal, { agent, connection = "shared", usePathCli = false } = {}) {
  validateOrchestrationInput(project, goal, agent);
  if (connectionMode(connection) === "desktop") throw desktopReadOnly();
  const { command: baseCommand, ...runtime } = await preparePromptCommand(usePathCli);
  const command = `${baseCommand} --connection ${connection}`;
  const render = usePathCli ? orchestrationPrompt
    : (await import(pathToFileURL(path.join(runtime.deployment.directory, "src/orchestrate-prompt.mjs")).href)).orchestrationPrompt;
  return { ...render(project, goal, command, { agent, usePathCli }), connection, ...runtime };
}
