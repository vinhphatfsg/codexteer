import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectionMode, desktopReadOnly } from "./connection.mjs";
import { prepareBoundCommand } from "./prompt-command.mjs";
import { orchestrationPrompt, validateOrchestrationInput } from "./orchestrate-prompt.mjs";
import { prepareCodexHome } from "./distribution.mjs";
import { codexHome } from "./runtime.mjs";
import { launchAgent } from "./agent-launch.mjs";
import { targetContext, targetHost, hostFields } from "./target.mjs";
import { shellArgument } from "./prompt-command.mjs";
import { readFile } from "node:fs/promises";

export async function claudeGuardArguments(agentArgs, command, project) {
  const args = [...agentArgs], settingsArgs = args.map((arg, i) => arg === "--settings" || arg.startsWith("--settings=") ? i : -1).filter(i => i >= 0);
  if (settingsArgs.length > 1) throw Object.assign(new Error("Specify Claude --settings only once."), { code: "OPTIONS_INVALID" });
  let settings = {};
  if (settingsArgs.length) {
    const index = settingsArgs[0], inline = args[index].startsWith("--settings="), value = inline ? args[index].slice("--settings=".length) : args[index + 1];
    if (!value || value.startsWith("--")) throw Object.assign(new Error("Claude --settings requires JSON or a file path."), { code: "OPTIONS_INVALID" });
    settings = JSON.parse(value.trimStart().startsWith("{") ? value : await readFile(value, "utf8"));
    args.splice(index, inline ? 1 : 2);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || settings.disableAllHooks === true
    || (settings.hooks != null && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)))
    || (settings.hooks?.Stop !== undefined && !Array.isArray(settings.hooks.Stop))) {
    throw Object.assign(new Error("Claude settings must allow the project Stop hook and contain an object with a Stop array."), { code: "OPTIONS_INVALID" });
  }
  const hooks = { ...settings.hooks, Stop: [...settings.hooks?.Stop ?? [], { hooks: [{ type: "command", command: `${command} project guard --project ${shellArgument(project)}`, timeout: 10 }] }] };
  return [...args, "--settings", JSON.stringify({ ...settings, hooks })];
}

export async function prepareOrchestrationPrompt(project, goal, { agent, connection = "shared", usePathCli = false } = {}) {
  validateOrchestrationInput(project, goal, agent);
  if (connectionMode(connection) === "desktop") throw desktopReadOnly();
  const { command, ...runtime } = await prepareBoundCommand({ session: null, connection, context: targetContext() ?? process.env.CODEX_THREAD_ID }, usePathCli);
  // Cloud has no Desktop host route. Keep paired orchestration on its selected
  // host; local orchestration gets a separate, unbound Desktop Cloud command.
  const cloudCommand = targetHost() === "local"
    ? (await prepareBoundCommand({ session: null, connection: "desktop-cloud" }, usePathCli)).command : null;
  const render = usePathCli ? orchestrationPrompt
    : (await import(pathToFileURL(path.join(runtime.deployment.directory, "src/orchestrate-prompt.mjs")).href)).orchestrationPrompt;
  return { ...render(project, goal, command, { agent, usePathCli, cloudCommand, canStart: targetHost() === "local" }), command, cloud_command: cloudCommand, connection, ...runtime, ...hostFields() };
}

export async function orchestrateAgent(project, goal, { agent = "claude", agentArgs = [], connection = "shared", usePathCli = false } = {}) {
  const { prompt, deployment, command } = await prepareOrchestrationPrompt(project, goal, { agent, connection, usePathCli });
  // PATH prompt generation is side-effect free; direct launch still verifies
  // its Desktop profile before letting the agent start project work.
  if (!deployment) await prepareCodexHome(codexHome());
  // Session settings add this hook without editing the checkout's .claude files.
  const args = agent === "claude" ? await claudeGuardArguments(agentArgs, command, project) : agentArgs;
  return launchAgent(agent, args, prompt);
}
