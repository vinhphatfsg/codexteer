import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { supervisorPrompt } from "./prompt.mjs";

function launchFailure(agent, error) {
  return Object.assign(new Error(`Could not start ${agent} (${error.code ?? "START_FAILED"}). Check that it is installed and executable on PATH.`), { code: error.code ?? "START_FAILED" });
}

export async function superviseAgent(threadInput, { agent, agentArgs = [] } = {}) {
  const { prompt } = supervisorPrompt(threadInput);
  if (agent !== "claude") throw new Error("supervise requires --agent claude. See codex-steer help supervise.");

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
