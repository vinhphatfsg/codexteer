import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const directory of ["src", "bin", "scripts", "test"]) {
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".mjs")) continue;
    const result = spawnSync(process.execPath, ["--check", `${directory}/${name}`], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
