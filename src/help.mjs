import { topics as supervision } from "./help-supervision.mjs";
import { topics as observation } from "./help-observation.mjs";
import { topics as intervention } from "./help-intervention.mjs";
import { topics as local } from "./help-local.mjs";
import { topics as cloudRemote } from "./help-cloud-remote.mjs";
import * as shared from "./help-errors.mjs";
import { isCloudTask } from "./cloud-id.mjs";
import { isDesktopCloudTask } from "./desktop-cloud-id.mjs";
import { selectedCloudInvocation } from "./task-id.mjs";
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

const sharedErrors = new Map(Object.values(shared).map(entry => [entry.code, entry]));
const valueOptions = new Set(["--supervisor", "--connection", "--require-node-version", "--host", "--remote-transport", "--context-thread", "--thread"]);
const threadLike = word => /^(codex:\/\/|[0-9a-f]{8}-)/i.test(word) || isCloudTask(word) || isDesktopCloudTask(word);

const literal = token => /^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(token);

function invocation(argv) {
  const words = [], options = new Map();
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    if (valueOptions.has(argv[i])) options.set(argv[i], argv[++i]);
    else if (!argv[i].startsWith("--")) words.push(argv[i]);
  }
  return { words, options };
}

function usageLine(text) {
  const tokens = text.split(" "), options = new Map();
  let i = 0;
  for (; valueOptions.has(tokens[i]); i += 2) options.set(tokens[i], tokens[i + 1]);
  const literals = [];
  for (; i < tokens.length && literal(tokens[i]); i++) literals.push(tokens[i]);
  return { text, options, literals };
}

export function topicFor(argv) {
  const [first, second] = invocation(argv).words;
  if (first === undefined) return null;
  const name = ["supervise", "orchestrate"].includes(first) && second === "prompt" ? `${first} prompt` : threadLike(first) ? "send" : first;
  return Object.hasOwn(topics, name) ? name : null;
}

function failingUsage(topic, argv) {
  const { words, options } = invocation(argv), connection = options.get("--connection") ?? (selectedCloudInvocation(argv) || "shared");
  const accepts = (option, spec) => {
    const value = option === "--connection" ? connection : options.get(option);
    return value === undefined || !literal(spec) || spec.split("|").includes(value);
  };
  const lines = topics[topic].usage.map(usageLine);
  const fitting = lines.filter(line => [...line.options].every(([option, spec]) => accepts(option, spec)));
  const routed = fitting.filter(line => line.options.has("--connection"));
  const pool = connection !== "shared" && routed.length ? routed : fitting.length ? fitting : lines;
  const best = (list, score) => {
    const scores = list.map(score), max = Math.max(...scores);
    return { max, list: list.filter((_, i) => scores[i] === max) };
  };
  const named = best(pool, line => (line.literals.every((token, i) => token.split("|").includes(words[i])) ? line.literals.length : -1));
  if (named.max < 0) return pool.map(line => line.text);
  return best(named.list, line => [...line.options.keys()].reduce((sum, option) => sum + (options.has(option) ? 1 : -1), 0)).list.map(line => line.text);
}

export function errorRemedy(argv, code) {
  const topic = topicFor(argv);
  if (!topic) return null;
  const entry = topics[topic].errors?.find(e => e.code === code) ?? sharedErrors.get(code);
  return { help: topic, ...(/OPTIONS_INVALID$/.test(code) ? { usage: failingUsage(topic, argv) } : {}), ...(entry ? { action: entry.action } : {}) };
}

export function helpData(topic = "overview", { errors = false } = {}) {
  const data = topics[topic];
  if (!data) throw new Error(`Unknown help topic: ${topic}. Run codexteer help.`);
  const { errors: list = [], ...page } = data;
  if (errors) return { version: VERSION, topic, errors: list };
  return { version: VERSION, topic, ...page, ...(list.length ? { errors_command: `codexteer help ${topic} --errors` } : {}) };
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
    ...section("エラーと対処", data.errors_command ? [`  失敗時の対処はerror.action（テキスト出力では「対処:」の行）に返ります。一覧: ${data.errors_command}`] : []),
    ...section("手順", data.procedure ?? []),
    ...section("例", data.examples.map(x => `  ${x}`)),
    ...section("補足", data.notes.map(x => `• ${x}`)),
    ...section("関連", data.see?.length ? [`  ${data.see.map(t => `codexteer help ${t}`).join(" / ")}`] : []),
  ].join("\n");
}

export function renderErrors(data) {
  const lines = data.errors.length ? data.errors.map(e => `  ${e.code}: ${e.when}\n      → ${e.action}`) : ["  このトピックに記載したエラーはありません。"];
  return [`codexteer ${data.version} — help ${data.topic} のエラーと対処`, "", ...lines].join("\n");
}
