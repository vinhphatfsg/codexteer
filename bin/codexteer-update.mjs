#!/usr/bin/env node
import { updateWorker } from "../src/update.mjs";
await updateWorker(JSON.parse(process.argv[2]));
