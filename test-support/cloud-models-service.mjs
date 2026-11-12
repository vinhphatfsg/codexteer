// Test-only service, injected with Node's module loader in an isolated CODEX_HOME.
// Production exposes no endpoint or credential override for this fixture.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DesktopCloudClient, liveTurnEnabled } from "../src/desktop-cloud-api.mjs?actual";
export { DesktopCloudClient, liveTurnEnabled };
const file = () => `${process.env.CODEX_HOME}/fixture.json`;
export async function desktopCloudEnvironments() { return { environments: [{ id: "test-config", name: "Fixture" }] }; }
export async function connectDesktopCloud() {
  return new DesktopCloudClient({ close() {}, async request(method, params) {
    const state = JSON.parse(await readFile(file(), "utf8")); state.calls.push({ method, params });
    let result;
    if (method === "model/list") result = { data: state.models };
    else if (method === "thread/start") {
      const id = randomUUID(); state.threads[id] = { id, name: "fixture", model: params.model, reasoningEffort: params.config.model_reasoning_effort,
        status: { type: "idle", activeFlags: [] }, turns: [], environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: "test-config" }] };
      result = { thread: state.threads[id] };
    } else {
      const thread = state.threads[params.threadId]; if (!thread) throw Error("Unknown fixture task");
      if (method === "thread/name/set") { thread.name = params.name; result = {}; }
      else if (method === "thread/read") result = { thread };
      else if (method === "thread/turns/list") result = { data: thread.turns.map(turn => ({ ...turn, itemsView: "full" })), nextCursor: null };
      else if (method === "turn/start") {
        const turn = { id: randomUUID(), status: "completed", items: [{ type: "userMessage", id: randomUUID(), clientId: params.clientUserMessageId, content: params.input }] };
        thread.turns.push(turn); result = { turn };
      } else throw Error(`Unexpected fixture RPC: ${method}`);
    }
    await writeFile(file(), JSON.stringify(state)); return result;
  } });
}
export function desktopCloudConnection() {
  return { discover: async () => ({ paths: { socket: "fixture" }, state: { codex_steer_protocol: 1, codex_steer_capabilities: { thread_read: [1], history_pagination: [1], turn_steer: [], turn_start: [], desktop_subscribe: [] } } }), connect: connectDesktopCloud };
}
