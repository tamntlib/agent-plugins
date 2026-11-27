import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStarterProfileConfig,
  loadProfileConfig,
  readAllowlistedEnvFile,
  writeProfileConfigAtomic,
} from "../src/config.mjs";
import { resolveConfigDir, resolveStateDir } from "../src/paths.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-cfg-"));
}

test("resolveConfigDir and resolveStateDir handle POSIX, Windows, and env overrides", () => {
  assert.equal(
    resolveConfigDir({ env: { AGENT_HINDSIGHT_HOME: "~/hs" }, platform: "linux", homeDir: "/home/u" }),
    "/home/u/hs"
  );
  assert.equal(
    resolveConfigDir({
      env: { APPDATA: "C:\\Users\\U\\AppData\\Roaming" },
      platform: "win32",
      homeDir: "C:\\Users\\U",
      fileExists: () => false,
    }),
    "C:\\Users\\U\\AppData\\Roaming\\agent-hindsight"
  );
  assert.equal(
    resolveStateDir({ env: { PLUGIN_DATA: "/var/data/hs" }, platform: "linux", homeDir: "/home/u" }),
    "/var/data/hs"
  );
});

test("readAllowlistedEnvFile parses literal KEY=value, ignores non-allowlisted keys and symlinks", () => {
  const tmp = makeTempDir();
  try {
    const envFile = path.join(tmp, ".env");
    fs.writeFileSync(
      envFile,
      "# comment\nHINDSIGHT_API_KEY='secret-123'\nHINDSIGHT_API_URL=http://127.0.0.1:9999\nUNRELATED=ignored\n",
      "utf8"
    );
    const parsed = readAllowlistedEnvFile(envFile);
    assert.deepEqual(parsed, {
      HINDSIGHT_API_KEY: "secret-123",
      HINDSIGHT_API_URL: "http://127.0.0.1:9999",
    });

    const linkFile = path.join(tmp, "link.env");
    fs.symlinkSync(envFile, linkFile);
    assert.deepEqual(readAllowlistedEnvFile(linkFile), {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadProfileConfig merges per-profile config.json, .env, and process env cleanly", () => {
  const tmp = makeTempDir();
  try {
    const starter = createStarterProfileConfig("work", {
      apiUrl: "http://127.0.0.1:8888",
      bankId: "corp",
    });
    // Dedicated bank starter stays minimal (omits default apiUrl, budget, maxTokens, tags)
    assert.deepEqual(starter, { bankId: "corp" });
    const cfgPath = writeProfileConfigAtomic(tmp, "work", starter);
    fs.writeFileSync(
      path.join(tmp, "work", ".env"),
      "HINDSIGHT_API_KEY=from-profile-env\n",
      "utf8"
    );

    const cfg = loadProfileConfig("work", { configDir: tmp, env: {} });
    assert.equal(cfg.configLoaded, true);
    assert.equal(cfg.configPath, cfgPath);
    assert.equal(cfg.bankId, "corp");
    assert.equal(cfg.apiKey, "from-profile-env");
    assert.deepEqual(cfg.recallTags, []);
    assert.deepEqual(cfg.retainTags, []);
    assert.equal(cfg.observationScopes, "shared");
    assert.equal(cfg.mcpUrl, "http://127.0.0.1:8888/mcp/corp/");
    assert.deepEqual(cfg.warnings, []);

    // Shared default bank preserves profile-tag isolation automatically
    const sharedStarter = createStarterProfileConfig("sharedprof", { bankId: "default" });
    writeProfileConfigAtomic(tmp, "sharedprof", sharedStarter);
    const sharedCfg = loadProfileConfig("sharedprof", { configDir: tmp, env: {} });
    assert.deepEqual(sharedCfg.recallTags, ["profile:sharedprof"]);
    assert.deepEqual(sharedCfg.retainTags, ["profile:sharedprof"]);
    assert.deepEqual(sharedCfg.observationScopes, [["profile:sharedprof"]]);

    // Process env wins over .env
    const overridden = loadProfileConfig("work", {
      configDir: tmp,
      env: { HINDSIGHT_API_KEY: "from-proc-env", HINDSIGHT_API_URL: "http://127.0.0.1:7777/" },
    });
    assert.equal(overridden.apiKey, "from-proc-env");
    assert.equal(overridden.apiUrl, "http://127.0.0.1:7777");

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadProfileConfig warns if apiKey is embedded inside config.json", () => {
  const tmp = makeTempDir();
  try {
    const cfg = createStarterProfileConfig("default");
    cfg.apiKey = "should-not-be-here";
    writeProfileConfigAtomic(tmp, "default", cfg);

    const loaded = loadProfileConfig("default", { configDir: tmp, env: {} });
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /API key found inside/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadProfileConfig resolves extends chains with alias-aware overrides and fail-closed errors", () => {
  const tmp = makeTempDir();
  try {
    const fakeHome = path.join(tmp, "home");
    const sharedDir = path.join(fakeHome, "shared-hs");
    fs.mkdirSync(sharedDir, { recursive: true });
    const grandBasePath = path.join(sharedDir, "base.json");
    const basePath = path.join(sharedDir, "profile.json");
    fs.writeFileSync(
      grandBasePath,
      JSON.stringify({
        recall_budget: "high",
        recall_max_tokens: 2048,
      }),
      "utf8"
    );
    fs.writeFileSync(
      basePath,
      JSON.stringify({
        extends: "./base.json",
        mode: "local_external",
        bank_id: "personal",
        bank_id_template: "personal-{project}",
        mirror_to_own_bank: true,
        recall_min_scores: { semantic: 0.69 },
        retain_source: "upstream-client",
        recall_sync: true,
      }),
      "utf8"
    );

    writeProfileConfigAtomic(tmp, "personal", {
      extends: "~/shared-hs/profile.json",
      retainSource: "",
      budget: "low",
    });

    const loaded = loadProfileConfig("personal", {
      configDir: tmp,
      homeDir: fakeHome,
      env: {},
    });
    assert.equal(loaded.configLoaded, true);
    assert.equal(loaded.configError, null);
    assert.deepEqual(loaded.extendsPaths, [basePath, grandBasePath]);
    assert.equal(loaded.bankId, "personal");
    assert.equal(loaded.bankIdTemplate, "personal-{project}");
    assert.equal(loaded.mirrorToOwnBank, true);
    assert.equal(loaded.maxTokens, 2048);
    assert.deepEqual(loaded.recallMinScores, { semantic: 0.69 });
    assert.equal(loaded.retainSource, "");
    assert.equal(loaded.budget, "low");
    assert.deepEqual(loaded.warnings, []);

    // Child snake_case overrides parent camelCase and null clears inherited setting
    const camelBase = path.join(sharedDir, "camel.json");
    fs.writeFileSync(
      camelBase,
      JSON.stringify({
        bankId: "corp",
        budget: "high",
        recallMinScores: { semantic: 0.72 },
      }),
      "utf8"
    );
    writeProfileConfigAtomic(tmp, "work", {
      extends: camelBase,
      recall_budget: "mid",
      recallMinScores: null,
    });
    const workLoaded = loadProfileConfig("work", { configDir: tmp, env: {} });
    assert.equal(workLoaded.configLoaded, true);
    assert.equal(workLoaded.bankId, "corp");
    assert.equal(workLoaded.budget, "mid");
    assert.equal(workLoaded.recallMinScores, null);

    // Missing extends target fails closed
    writeProfileConfigAtomic(tmp, "missing", {
      extends: path.join(sharedDir, "does-not-exist.json"),
    });
    const missingLoaded = loadProfileConfig("missing", { configDir: tmp, env: {} });
    assert.equal(missingLoaded.configLoaded, false);
    assert.match(missingLoaded.configError, /Extended config not found/);

    // Circular extends fails closed
    const cycA = path.join(sharedDir, "cyc-a.json");
    const cycB = path.join(sharedDir, "cyc-b.json");
    fs.writeFileSync(cycA, JSON.stringify({ extends: "./cyc-b.json", bank_id: "a" }), "utf8");
    fs.writeFileSync(cycB, JSON.stringify({ extends: "./cyc-a.json", bank_id: "b" }), "utf8");
    writeProfileConfigAtomic(tmp, "cyclic", { extends: cycA });
    const cyclicLoaded = loadProfileConfig("cyclic", { configDir: tmp, env: {} });
    assert.equal(cyclicLoaded.configLoaded, false);
    assert.match(cyclicLoaded.configError, /Circular "extends" reference/);

    // Non-string extends fails closed
    writeProfileConfigAtomic(tmp, "badext", { extends: 123 });
    const badLoaded = loadProfileConfig("badext", { configDir: tmp, env: {} });
    assert.equal(badLoaded.configLoaded, false);
    assert.match(badLoaded.configError, /Invalid "extends" value/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
