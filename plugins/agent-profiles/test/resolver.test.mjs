import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig, writeConfigAtomic } from "../src/config.mjs";
import { resolveProfile } from "../src/resolver.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-res-"));
}

test("precedence: cli > envVars > ancestor marker > longest-prefix path > default", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const personalDir = path.join(tmp, "personal");
    const workDir = path.join(tmp, "work");
    const clientDir = path.join(workDir, "clients", "acme");
    const subDir = path.join(clientDir, "packages", "web");
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });

    const cfg = createDefaultConfig();
    cfg.envVars = ["AGENT_PROFILE", "LEGACY_PROFILE"];
    cfg.profiles.default.paths = [personalDir];
    cfg.profiles.work.paths = [workDir];
    cfg.profiles.acme = {
      description: "Acme client",
      paths: [clientDir],
      env: { AGENT_PROFILE: "acme", AWS_PROFILE: "acme-prod" },
      contextFiles: [],
      instructions: "",
    };
    writeConfigAtomic(cfgPath, cfg);

    // 1. Longest-prefix path rule: clientDir beats workDir
    const byLongestPath = resolveProfile({ cwd: subDir, configPath: cfgPath, env: {} });
    assert.equal(byLongestPath.valid, true);
    assert.equal(byLongestPath.profile, "acme");
    assert.equal(byLongestPath.source, `path:${clientDir}`);
    assert.equal(byLongestPath.env.AWS_PROFILE, "acme-prod");

    // 2. Ancestor marker beats path rule (comments and blank lines ignored)
    const markerFile = path.join(clientDir, ".agent-profile");
    fs.writeFileSync(markerFile, "# pinned\n\n  work  \n", "utf8");
    const byMarker = resolveProfile({ cwd: subDir, configPath: cfgPath, env: {} });
    assert.equal(byMarker.valid, true);
    assert.equal(byMarker.profile, "work");
    assert.equal(byMarker.source, `marker:${markerFile}`);

    // 3. Env var beats marker, respecting configured envVars order
    const byLegacyEnv = resolveProfile({
      cwd: subDir,
      configPath: cfgPath,
      env: { LEGACY_PROFILE: "default" },
    });
    assert.equal(byLegacyEnv.profile, "default");
    assert.equal(byLegacyEnv.source, "env:LEGACY_PROFILE");

    const byPrimaryEnv = resolveProfile({
      cwd: subDir,
      configPath: cfgPath,
      env: { AGENT_PROFILE: "acme", LEGACY_PROFILE: "default" },
    });
    assert.equal(byPrimaryEnv.profile, "acme");
    assert.equal(byPrimaryEnv.source, "env:AGENT_PROFILE");

    // 4. Explicit CLI flag beats everything
    const byCli = resolveProfile({
      cwd: subDir,
      explicitProfile: "default",
      configPath: cfgPath,
      env: { AGENT_PROFILE: "acme" },
    });
    assert.equal(byCli.profile, "default");
    assert.equal(byCli.source, "cli");

    // 5. Default fallback when outside all paths
    const outsideDir = path.join(tmp, "other");
    fs.mkdirSync(outsideDir, { recursive: true });
    const byDefault = resolveProfile({ cwd: outsideDir, configPath: cfgPath, env: {} });
    assert.equal(byDefault.profile, "default");
    assert.equal(byDefault.source, "default");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolves symlinks pointing into a configured profile path", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const workDir = path.join(tmp, "work");
    const realRepo = path.join(workDir, "secret-repo");
    const linkRepo = path.join(tmp, "shortcut-repo");
    fs.mkdirSync(realRepo, { recursive: true });
    fs.symlinkSync(realRepo, linkRepo);

    const cfg = createDefaultConfig();
    cfg.profiles.work.paths = [workDir];
    writeConfigAtomic(cfgPath, cfg);

    const res = resolveProfile({ cwd: linkRepo, configPath: cfgPath, env: {} });
    assert.equal(res.valid, true);
    assert.equal(res.profile, "work");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fails closed on unknown profile when strictUnknownProfile is true", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    writeConfigAtomic(cfgPath, createDefaultConfig());

    const res = resolveProfile({
      cwd: tmp,
      configPath: cfgPath,
      env: { AGENT_PROFILE: "nonexistent" },
    });
    assert.equal(res.valid, false);
    assert.match(res.error, /Unknown profile "nonexistent"/);
    assert.deepEqual(res.env, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detects mixed-profile multi-root workspace conflict", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const personalRepo = path.join(tmp, "personal", "app");
    const workRepo = path.join(tmp, "work", "lib");
    fs.mkdirSync(personalRepo, { recursive: true });
    fs.mkdirSync(workRepo, { recursive: true });

    const cfg = createDefaultConfig();
    cfg.profiles.default.paths = [path.join(tmp, "personal")];
    cfg.profiles.work.paths = [path.join(tmp, "work")];
    writeConfigAtomic(cfgPath, cfg);

    const res = resolveProfile({
      cwd: workRepo,
      workspacePaths: [workRepo, personalRepo],
      configPath: cfgPath,
      env: {},
    });
    assert.equal(res.valid, true);
    assert.equal(res.profile, "work");
    assert.ok(res.conflict);
    assert.equal(res.conflict.reason, "mixed-workspace-profiles");
    assert.deepEqual(res.conflict.profiles, ["work", "default"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fails closed on duplicate identical path rules across two profiles", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const sharedDir = path.join(tmp, "shared");
    fs.mkdirSync(sharedDir, { recursive: true });

    const cfg = createDefaultConfig();
    cfg.profiles.default.paths = [sharedDir];
    cfg.profiles.work.paths = [sharedDir];
    writeConfigAtomic(cfgPath, cfg);

    const res = resolveProfile({ cwd: sharedDir, configPath: cfgPath, env: {} });
    assert.equal(res.valid, false);
    assert.equal(res.source, "ambiguous-path-rule");
    assert.match(res.error, /Ambiguous path rules/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolves Windows path rules and marker files cleanly", () => {
  const cfg = createDefaultConfig();
  cfg.profiles.work.paths = ["C:\\Users\\Alice\\Work"];
  const configState = {
    loaded: true,
    exists: true,
    configDir: "C:\\Users\\Alice\\AppData\\Roaming\\agent-profiles",
    configPath: "C:\\Users\\Alice\\AppData\\Roaming\\agent-profiles\\config.json",
    config: cfg,
    warnings: [],
    error: null,
  };

  const res = resolveProfile({
    cwd: "c:/users/alice/work/service-a",
    env: {},
    configState,
    platform: "win32",
    homeDir: "C:\\Users\\Alice",
    readFile: () => null,
  });
  assert.equal(res.valid, true);
  assert.equal(res.profile, "work");
});
