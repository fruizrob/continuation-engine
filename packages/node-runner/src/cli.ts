#!/usr/bin/env node

import { runNodeCli } from "./index.js";

const exitCode = await runNodeCli(process.argv.slice(2));
process.exitCode = exitCode;
