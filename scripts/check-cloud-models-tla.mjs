import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const jar = process.env.TLA2TOOLS_JAR;
if (!jar || !path.isAbsolute(jar)) throw Error("Set TLA2TOOLS_JAR to the absolute path of an official tla2tools.jar.");
const root = fileURLToPath(new URL("..", import.meta.url));
const out = await realpath(await mkdtemp(path.join(tmpdir(), "codexteer-cloud-models-tla-")));
await writeFile(path.join(out, "CloudModelDefaults.tla"), await readFile(path.join(root, "formal/CloudModelDefaults.tla")));
const invariants = ["TypeOK", "AtomicDefaults", "PinnedChoice", "CreateAtMostOnce", "FirstTurnAtMostOnce", "CreateUsesChoice", "TurnUsesChoice", "ValidatedBeforeCreate", "NoTurnWithoutCreate"];
const cases = [
  { name: "safety-wide", attempts: "{a1}", pairs: "WidePairs", failures: true, changes: true },
  { name: "safety-two-orders", attempts: "{a1, a2}", pairs: "SmallPairs", failures: true, changes: true },
  { name: "progress", attempts: "{a1, a2}", pairs: "SmallPairs", failures: false, changes: false, progress: true },
  ...Object.entries({ "torn-write": "AtomicDefaults", "cached-default": "PinnedChoice", "unpin-retry": "PinnedChoice", "late-selection": "TurnUsesChoice",
    "retry-unknown": "CreateAtMostOnce", "resend-turn": "FirstTurnAtMostOnce", "skip-validation": "ValidatedBeforeCreate" })
    .map(([bug, expected]) => ({ name: `mutant-${bug}`, bug, expected, attempts: "{a1}", pairs: "WidePairs", failures: true, changes: true })),
];
const results = [];
console.log(`TLC evidence: ${out}`);
for (const c of cases) {
  const config = `SPECIFICATION Spec\nCONSTANTS\n AllowedPairs <- ${c.pairs}\n DefaultPair <- PairALow\n Attempts = ${c.attempts}\n Failures = ${c.failures ? "TRUE" : "FALSE"}\n CatalogChanges = ${c.changes ? "TRUE" : "FALSE"}\n Bug = "${c.bug ?? "none"}"\nINVARIANTS\n ${invariants.join("\n ")}\n${c.progress ? "PROPERTY EventuallyDone\n" : ""}`;
  const cfg = path.join(out, `${c.name}.cfg`); await writeFile(cfg, config);
  const meta = path.join(out, `${c.name}-states`); await mkdir(meta);
  const args = ["-Xmx2g", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "2", "-deadlock", "-metadir", meta, "-config", path.basename(cfg), "CloudModelDefaults.tla"];
  const execution = await new Promise((resolve, reject) => {
    const child = spawn(process.env.JAVA_BIN ?? "java", args, { cwd: out, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; const append = chunk => { output += chunk; };
    child.stdout.on("data", append); child.stderr.on("data", append); child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
  await writeFile(path.join(out, `${c.name}.log`), execution.output);
  const violated = execution.output.match(/Invariant (\w+) is violated/)?.[1] ?? null;
  const passed = c.expected ? execution.code === 12 && violated === c.expected : execution.code === 0 && execution.output.includes("Model checking completed. No error has been found.");
  const states = execution.output.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
  results.push({ name: c.name, passed, code: execution.code, violated, expected: c.expected ?? null, generated: states?.[1] ?? null, distinct: states?.[2] ?? null });
  console.log(JSON.stringify(results.at(-1)));
  if (!passed) { console.error(execution.output.slice(-5000)); break; }
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { model_sha256: sha(await readFile(path.join(out, "CloudModelDefaults.tla"))), jar_sha256: sha(await readFile(jar)), results,
  passed: results.length === cases.length && results.every(row => row.passed) };
await writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`Report: ${path.join(out, "result.json")}`);
if (!report.passed) process.exitCode = 1;
