#!/usr/bin/env node
// Prints the sha256 of each function the StoreLock model covers, extracted
// from the working tree. check.sh compares them with ../coverage.json.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const covered = JSON.parse(readFileSync(path.join(repo, ".claude/skills/verify-store-lock/coverage.json"), "utf8")).covered;
const result = {};
for (const { file, function: name } of covered) {
  const text = readFileSync(path.join(repo, file), "utf8");
  const start = text.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  if (start < 0) { result[`${file}#${name}`] = "MISSING"; continue; }
  // The function ends at the first line that is exactly "}" after its start.
  const end = text.indexOf("\n}\n", start);
  result[`${file}#${name}`] = createHash("sha256").update(text.slice(start, end + 2)).digest("hex");
}
console.log(JSON.stringify(result, null, 2));
