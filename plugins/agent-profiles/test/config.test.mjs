import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultConfig,
  loadConfigState,
  validateConfig,
  writeConfigAtomic,
} from "../src/config.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-cfg-"));
}

test("validateConfig accepts default config with no warnings", () => {
  const res = validateConfig(createDefaultConfig());
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.config.defaultProfile, "default");
  assert.deepEqual(res.config.profiles.default.paths, []);
});

test("validateConfig rejects invalid profile names, path-traversal markers, and missing defaults", () => {
  const bad = validateConfig({
    version: 1,
    defaultProfile: "missing",
    markerFiles: ["../evil"],
    profiles: {
      "../escape": { paths: ["~/x"] },
      work: { env: { BAD_VAL: "line1\nline2" } },
    },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("markerFiles")));
  assert.ok(bad.errors.some((e) => e.includes("Invalid profile name")));
  assert.ok(bad.errors.some((e) => e.includes("newlines")));
  assert.ok(bad.errors.some((e) => e.includes("defaultProfile")));
});

test("validateConfig warns when profile.env contains secret-like key names", () => {
  const cfg = createDefaultConfig();
  cfg.profiles.work.env.SLACK_API_TOKEN = "placeholder";
  const res = validateConfig(cfg);
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /looks like a secret/i);
});

test("loadConfigState returns built-in defaults when config file is absent", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const state = loadConfigState({ configPath: cfgPath });
    assert.equal(state.exists, false);
    assert.equal(state.loaded, false);
    assert.equal(state.error, null);
    assert.equal(state.config.defaultProfile, "default");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfigState fails closed on corrupt JSON", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    fs.writeFileSync(cfgPath, "{ broken json", "utf8");
    const state = loadConfigState({ configPath: cfgPath });
    assert.equal(state.exists, true);
    assert.equal(state.loaded, false);
    assert.equal(state.config, null);
    assert.match(state.error, /Invalid JSON/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeConfigAtomic creates 0700 dir and 0600 file on POSIX and round-trips", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "nested", "config.json");
    const cfg = createDefaultConfig();
    cfg.profiles.work.description = "Corporate";
    writeConfigAtomic(cfgPath, cfg);

    const state = loadConfigState({ configPath: cfgPath });
    assert.equal(state.loaded, true);
    assert.equal(state.config.profiles.work.description, "Corporate");

    if (process.platform !== "win32") {
      const fileMode = fs.statSync(cfgPath).mode & 0o777;
      const dirMode = fs.statSync(path.dirname(cfgPath)).mode & 0o777;
      assert.equal(fileMode, 0o600);
      assert.equal(dirMode, 0o700);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
