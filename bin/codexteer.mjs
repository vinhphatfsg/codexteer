#!/usr/bin/env node

import { main, fail } from "../src/cli.mjs";
import { cloudInvocation, mainCloud } from "../src/cloud-cli.mjs";

const args = process.argv.slice(2);
if (cloudInvocation(args)) {
  try { await mainCloud(args); } catch (failure) { fail(failure, args.includes("--json")); }
} else await main(args);
