#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") {
    process.exit(0);
  }
  throw err;
});

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
