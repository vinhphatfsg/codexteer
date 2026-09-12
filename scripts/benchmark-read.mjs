// Read-only benchmark. Never starts/resumes a task or sends a message.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizeThreadId } from "../src/thread-id.mjs";
import { VERSION } from "../src/help.mjs";

const args = process.argv.slice(2), input = args.shift();
if (!input || ["--help", "-h"].includes(input)) {
  console.log("Usage: node scripts/benchmark-read.mjs <THREAD> [--samples 20] [--max-ms 1000] [--output FILE]\nMeasures fresh CLI processes, including startup. Saves timings and counts only.");
} else {
  const options = { samples: 20, maxMs: 1000 };
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!value) throw new Error(`${name} requires a value.`);
    if (name === "--samples") options.samples = Number(value);
    else if (name === "--max-ms") options.maxMs = Number(value);
    else if (name === "--output") options.output = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 1000 || !Number.isFinite(options.maxMs) || options.maxMs <= 0) throw new Error("Invalid sample count or threshold.");
  const threadId = normalizeThreadId(input), run = promisify(execFile), cli = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
  const measure = async extra => {
    const started = performance.now();
    const { stdout } = await run(process.execPath, [cli, "read", threadId, "--json", ...extra], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    const ms = performance.now() - started, result = JSON.parse(stdout);
    if (!result.ok || result.data.history_scope !== "tail-and-tracked-items") throw new Error("Benchmark requires the fast paged reader.");
    return { data: result.data, metrics: { ms: Math.round(ms * 100) / 100, below_threshold: ms < options.maxMs, output_bytes: Buffer.byteLength(stdout), events: result.data.events.length, changed: result.data.changed, has_more: result.data.has_more } };
  };
  const initial = await measure([]); let cursor = initial.data.cursor;
  const samples = [];
  for (let i = 0; i < options.samples; i++) {
    const sample = await measure(["--since", cursor]); cursor = sample.data.cursor; samples.push(sample.metrics);
    console.log(JSON.stringify({ sample: i + 1, ...sample.metrics }));
  }
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b), max = sorted.at(-1);
  const median = Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) * 50) / 100;
  const report = { date: new Date().toISOString(), thread_id: threadId, version: VERSION, node: process.version, initial: initial.metrics, samples,
    summary: { count: samples.length, min_ms: sorted[0], median_ms: median, p95_ms: sorted[Math.ceil(sorted.length * .95) - 1], max_ms: max, threshold_ms: options.maxMs, passed: samples.every(s => s.below_threshold) } };
  if (options.output) await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report.summary));
  if (!report.summary.passed) process.exitCode = 1;
}
