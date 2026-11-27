#!/usr/bin/env node
import { runHookFromStdio } from "../src/hooks.mjs";

const exitCode = await runHookFromStdio(process.argv.slice(2));
process.exitCode = exitCode;
