#!/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
import { runWrapper } from "../src/wrapper.mjs";

try {
  process.exitCode = await runWrapper(process.argv.slice(2));
} catch (error) {
  // Protocol stdout is reserved exclusively for Desktop. Never print argv/env.
  console.error(`codex-steer wrapper: ${error.message}`);
  process.exitCode = 1;
}
