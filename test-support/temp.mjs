import os from "node:os";
import path from "node:path";
import process from "node:process";

// Keep Darwin socket fixtures below its short Unix-domain path limit while
// allowing the suite to run on systems where /private/tmp does not exist.
const root = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();

export function tempPrefix(name) {
  return path.join(root, name);
}
