import { topics as supervision } from "./help-supervision.mjs";
import { topics as observation } from "./help-observation.mjs";
import { topics as intervention } from "./help-intervention.mjs";
import { topics as local } from "./help-local.mjs";
import { topics as cloudRemote } from "./help-cloud-remote.mjs";
import { VERSION } from "./version.mjs";

export { VERSION };

const byName = { ...supervision, ...observation, ...intervention, ...local, ...cloudRemote };
export const topics = Object.fromEntries([
  "overview",
  "orchestrate",
  "orchestrate prompt",
  "supervise",
  "supervise prompt",
  "monitor",
  "read",
  "status",
  "watch",
  "send",
  "findings",
  "history",
  "instructions",
  "checkpoint",
  "resource",
  "diff",
  "connection",
  "doctor",
  "desktop",
  "projects",
  "threads",
  "thread",
  "open",
  "debug-ui",
  "cloud",
  "desktop-cloud",
  "environments",
  "remote",
  "remote-control",
  "remote-device",
].map(name => [name, byName[name]]));

export function helpData(topic = "overview") {
  const data = topics[topic];
  if (!data) throw new Error(`Unknown help topic: ${topic}. Run codexteer help.`);
  return { version: VERSION, topic, ...data };
}

export function renderHelp(data) {
  const interactive = x => x.startsWith("supervise <") || x.startsWith("orchestrate --");
  const withJson = x => (interactive(x) ? x : x.includes(" -- ") ? x.replace(" -- ", " [--json] -- ") : `${x} [--json]`);
  const section = (label, lines) => (lines.length ? ["", `${label}:`, ...lines] : []);
  return [
    `codexteer ${data.version} — ${data.title}`,
    "",
    `使い所: ${data.when}`,
    ...section("目的から選ぶ", (data.use_cases ?? []).map(x => `  ${x.need} → codexteer ${x.command}`)),
    ...section("使い方", data.usage.map(x => `  codexteer ${withJson(x)}`)),
    ...section("オプション", (data.options ?? []).map(o => `  ${o.name}${o.default === undefined ? "" : `（既定: ${o.default}）`}\n      ${o.text}`)),
    "",
    `確認できること: ${data.returns}`,
    ...section("エラーと対処", (data.errors ?? []).map(e => `  ${e.code}: ${e.when}\n      → ${e.action}`)),
    ...section("手順", data.procedure ?? []),
    ...section("例", data.examples.map(x => `  ${x}`)),
    ...section("補足", data.notes.map(x => `• ${x}`)),
    ...section("関連", data.see?.length ? [`  ${data.see.map(t => `codexteer help ${t}`).join(" / ")}`] : []),
  ].join("\n");
}
