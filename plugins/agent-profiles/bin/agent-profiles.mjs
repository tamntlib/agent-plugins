#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

const exitCode = runCli(process.argv.slice(2));
process.exitCode = exitCode;
