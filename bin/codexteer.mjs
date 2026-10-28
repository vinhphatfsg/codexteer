#!/usr/bin/env node

import { main, fail } from "../src/cli.mjs";
import { cloudRoutingError } from "../src/cloud.mjs";
import { cloudInvocation, mainCloud } from "../src/cloud-cli.mjs";

const args = process.argv.slice(2), error = cloudRoutingError(args);
if (error) fail(error, args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--json"));
else if (cloudInvocation(args)) {
  try { await mainCloud(args); } catch (failure) { fail(failure, args.includes("--json")); }
} else await main(args);
