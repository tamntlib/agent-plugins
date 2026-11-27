import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatShellEnv, runCli } from "../src/cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(__dirname, "..", "bin", "agent-profiles.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-cli-"));
}

function captureCli(args, env = {}) {
  let out = "";
  let err = "";
  const code = runCli(args, {
    env,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

test("formatShellEnv renders sh, fish, powershell, and cmd exports safely", () => {
  const vars = { AGENT_PROFILE: "work", NOTE: "a'b" };
  assert.equal(formatShellEnv(vars, "sh"), "export AGENT_PROFILE='work'\nexport NOTE='a'\\''b'\n");
  assert.equal(formatShellEnv(vars, "fish"), "set -gx AGENT_PROFILE 'work'\nset -gx NOTE 'a\\'b'\n");
  assert.equal(formatShellEnv(vars, "powershell"), "$env:AGENT_PROFILE = 'work'\n$env:NOTE = 'a''b'\n");
  assert.equal(formatShellEnv({ AGENT_PROFILE: "work", PCT: "100%" }, "cmd"), 'set "AGENT_PROFILE=work"\nset "PCT=100%%"\n');
});

test("CLI lifecycle: init, add, list, show, mark, resolve, unmark, set-default, remove, doctor", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const repoDir = path.join(tmp, "repo-a");
    fs.mkdirSync(repoDir, { recursive: true });
    const baseEnv = { AGENT_PROFILES_CONFIG: cfgPath };

    // init
    let r = captureCli(["init", "--json"], baseEnv);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).initialized, true);

    // init again without --force fails
    r = captureCli(["init"], baseEnv);
    assert.equal(r.code, 1);

    // add new profile
    r = captureCli(
      [
        "add",
        "client-a",
        "--description",
        "Client A",
        "--path",
        repoDir,
        "--env",
        "AWS_PROFILE=client-a",
        "--json",
      ],
      baseEnv
    );
    assert.equal(r.code, 0, r.err);

    // list
    r = captureCli(["list", "--json"], baseEnv);
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).profiles["client-a"]);

    // resolve matches repoDir
    r = captureCli(["resolve", "--cwd", repoDir, "--json"], baseEnv);
    assert.equal(r.code, 0, r.err);
    const resolved = JSON.parse(r.out);
    assert.equal(resolved.profile, "client-a");
    assert.equal(resolved.env.AWS_PROFILE, "client-a");

    // mark overrides to work
    r = captureCli(["mark", "work", "--dir", repoDir], baseEnv);
    assert.equal(r.code, 0, r.err);
    r = captureCli(["resolve", "--cwd", repoDir, "--json"], baseEnv);
    assert.equal(JSON.parse(r.out).profile, "work");

    // unmark restores path rule
    r = captureCli(["unmark", "--dir", repoDir], baseEnv);
    assert.equal(r.code, 0, r.err);
    r = captureCli(["resolve", "--cwd", repoDir, "--json"], baseEnv);
    assert.equal(JSON.parse(r.out).profile, "client-a");

    // set-default & refuse removing default
    r = captureCli(["set-default", "client-a"], baseEnv);
    assert.equal(r.code, 0, r.err);
    r = captureCli(["remove", "client-a"], baseEnv);
    assert.equal(r.code, 1);

    // switch default back and remove client-a
    r = captureCli(["set-default", "default"], baseEnv);
    assert.equal(r.code, 0, r.err);
    r = captureCli(["remove", "client-a"], baseEnv);
    assert.equal(r.code, 0, r.err);

    // doctor
    r = captureCli(["doctor", "--cwd", repoDir, "--json"], baseEnv);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI exec passes resolved profile env vars and fails closed on unknown profile", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const workDir = path.join(tmp, "work", "demo");
    fs.mkdirSync(workDir, { recursive: true });

    const env = { ...process.env, AGENT_PROFILES_CONFIG: cfgPath, AGENT_PROFILE: "" };
    assert.equal(spawnSync(process.execPath, [CLI_BIN, "init"], { env }).status, 0);
    assert.equal(
      spawnSync(
        process.execPath,
        [CLI_BIN, "add", "work", "--path", path.join(tmp, "work"), "--env", "DEMO_TAG=from-work"],
        { env }
      ).status,
      0
    );

    const okRun = spawnSync(
      process.execPath,
      [
        CLI_BIN,
        "exec",
        "--cwd",
        workDir,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.env.AGENT_PROFILE + ':' + process.env.DEMO_TAG)",
      ],
      { env, encoding: "utf8" }
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(okRun.stdout, "work:from-work");

    const failClosed = spawnSync(
      process.execPath,
      [CLI_BIN, "exec", "--profile", "does-not-exist", "--", process.execPath, "-e", "process.exit(0)"],
      { env, encoding: "utf8" }
    );
    assert.equal(failClosed.status, 2);
    assert.match(failClosed.stderr, /Unknown profile/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
