import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-cli-"));
}

async function capture(args, opts = {}) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    ...opts,
    disableAgentProfiles: true,
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  return { code, out, err };
}

test("CLI init, status, doctor --no-network, recall, and retain work cleanly", async () => {
  const tmp = makeTempDir();
  try {
    const baseEnv = { AGENT_HINDSIGHT_HOME: tmp };

    let r = await capture(["init", "--profile", "work", "--url", "http://127.0.0.1:8888", "--bank", "default", "--json"], { env: baseEnv });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).initialized, true);

    r = await capture(["status", "--profile", "work", "--json"], { env: baseEnv });
    assert.equal(r.code, 0, r.err);
    const status = JSON.parse(r.out);
    assert.equal(status.profile, "work");
    assert.equal(status.configLoaded, true);
    assert.deepEqual(status.recallTags, ["profile:work"]);

    r = await capture(["doctor", "--profile", "work", "--no-network", "--json"], { env: baseEnv });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).ok, true);

    r = await capture(["recall", "docker", "--profile", "work"], {
      env: baseEnv,
      recallFn: async () => ({ results: [{ text: "Docker is rootless" }] }),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Docker is rootless/);

    r = await capture(["retain", "Remember this", "--profile", "work"], {
      env: baseEnv,
      retainNoteFn: async () => ({ ok: true }),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Retained memory into bank "default" under profile "work"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
