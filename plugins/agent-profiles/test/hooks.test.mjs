import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDefaultConfig, writeConfigAtomic } from "../src/config.mjs";
import {
  detectAgent,
  formatPosixExports,
  handlePreInvocation,
  handleSessionStart,
  latestCheckpointStepIndex,
} from "../src/hooks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, "..", "scripts", "hook.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-hook-"));
}

test("formatPosixExports escapes single quotes and skips invalid keys/newlines", () => {
  const out = formatPosixExports({
    AGENT_PROFILE: "work",
    GREETING: "it's safe",
    "BAD-KEY": "nope",
    MULTILINE: "a\nb",
  });
  assert.equal(out, "export AGENT_PROFILE='work'\nexport GREETING='it'\\''s safe'\n");
});

test("detectAgent identifies agy, claude, and codex payloads accurately", () => {
  assert.equal(detectAgent("auto", { workspacePaths: ["/tmp"] }, {}), "agy");
  assert.equal(detectAgent("auto", { conversationId: "abc" }, {}), "agy");
  assert.equal(detectAgent("auto", { cwd: "/tmp" }, { CLAUDE_ENV_FILE: "/tmp/env" }), "claude");
  assert.equal(detectAgent("auto", { session_id: "s1", cwd: "/tmp" }, {}), "codex");
});

test("handleSessionStart formats Antigravity payload with context files and truncation", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const workDir = path.join(tmp, "work", "repo");
    const ctxFile = path.join(tmp, "WORK_CONTEXT.md");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(ctxFile, "A".repeat(200), "utf8");

    const cfg = createDefaultConfig();
    cfg.maxContextFileChars = 50;
    cfg.profiles.work.paths = [path.join(tmp, "work")];
    cfg.profiles.work.contextFiles = [ctxFile, path.join(tmp, "missing.md")];
    cfg.profiles.work.instructions = "Always run unit tests.";
    writeConfigAtomic(cfgPath, cfg);

    const out = handleSessionStart(
      "agy",
      { conversationId: "c1", cwd: workDir, workspacePaths: [workDir] },
      { configPath: cfgPath, env: {} }
    );

    assert.ok(Array.isArray(out.injectSteps));
    const text = out.injectSteps[0].systemMessage.systemMessage;
    assert.match(text, /# Active Profile: work/);
    assert.match(text, /Always run unit tests\./);
    assert.match(text, /## Profile Context: WORK_CONTEXT\.md \(work\)/);
    assert.match(text, /\.\.\.\[truncated\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("handleSessionStart for Claude Code writes CLAUDE_ENV_FILE and returns hookSpecificOutput", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const workDir = path.join(tmp, "work", "api");
    const envFile = path.join(tmp, "claude.env");
    fs.mkdirSync(workDir, { recursive: true });

    const cfg = createDefaultConfig();
    cfg.profiles.work.paths = [path.join(tmp, "work")];
    cfg.profiles.work.env.TAMNTLIB_SKILLS_PROFILE = "work";
    writeConfigAtomic(cfgPath, cfg);

    const out = handleSessionStart(
      "claude",
      { session_id: "s1", cwd: workDir },
      { configPath: cfgPath, env: { CLAUDE_ENV_FILE: envFile } }
    );

    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /# Active Profile: work/);

    const envContents = fs.readFileSync(envFile, "utf8");
    assert.match(envContents, /export AGENT_PROFILE='work'/);
    assert.match(envContents, /export TAMNTLIB_SKILLS_PROFILE='work'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("handleSessionStart does NOT write CLAUDE_ENV_FILE when profile is unresolved", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const envFile = path.join(tmp, "claude.env");
    writeConfigAtomic(cfgPath, createDefaultConfig());

    const out = handleSessionStart(
      "claude",
      { session_id: "s2", cwd: tmp },
      { configPath: cfgPath, env: { AGENT_PROFILE: "unknown-one", CLAUDE_ENV_FILE: envFile } }
    );

    assert.equal(fs.existsSync(envFile), false);
    assert.match(out.hookSpecificOutput.additionalContext, /UNRESOLVED \(Fail-Closed\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scripts/hook.mjs runs cleanly end-to-end for agy, claude, and codex", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const workDir = path.join(tmp, "work", "svc");
    fs.mkdirSync(workDir, { recursive: true });

    const cfg = createDefaultConfig();
    cfg.profiles.work.paths = [path.join(tmp, "work")];
    writeConfigAtomic(cfgPath, cfg);

    for (const [agent, payload, check] of [
      [
        "agy",
        { conversationId: "c1", cwd: workDir, workspacePaths: [workDir] },
        (json) => assert.match(json.injectSteps[0].systemMessage.systemMessage, /# Active Profile: work/),
      ],
      [
        "claude",
        { session_id: "s1", cwd: workDir },
        (json) => {
          assert.equal(json.hookSpecificOutput.hookEventName, "SessionStart");
          assert.match(json.hookSpecificOutput.additionalContext, /# Active Profile: work/);
        },
      ],
      [
        "codex",
        { session_id: "s2", cwd: workDir },
        (json) => {
          assert.equal(json.hookSpecificOutput.hookEventName, "SessionStart");
          assert.match(json.hookSpecificOutput.additionalContext, /# Active Profile: work/);
        },
      ],
    ]) {
      const proc = spawnSync(process.execPath, [HOOK_SCRIPT, agent, "session-start"], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, AGENT_PROFILES_CONFIG: cfgPath, AGENT_PROFILE: "" },
      });
      assert.equal(proc.status, 0, proc.stderr);
      const parsed = JSON.parse(proc.stdout);
      check(parsed);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("handlePreInvocation re-injects profile context once per Antigravity CHECKPOINT compaction", () => {
  const tmp = makeTempDir();
  try {
    const cfgPath = path.join(tmp, "config.json");
    const stateDir = path.join(tmp, "state");
    const workDir = path.join(tmp, "work", "repo");
    const userMd = path.join(tmp, "USER.md");
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(userMd, "# COMMON\n- Always verify live.\n", "utf8");

    const cfg = createDefaultConfig();
    cfg.profiles.work.paths = [path.join(tmp, "work")];
    cfg.profiles.work.contextFiles = [userMd];
    writeConfigAtomic(cfgPath, cfg);

    // 1. Before any compaction: returns {}
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 1, source: "USER", type: "USER_INPUT", content: "hi" }) + "\n",
      "utf8"
    );
    assert.equal(latestCheckpointStepIndex(transcriptPath), -1);
    const before = handlePreInvocation(
      "agy",
      { conversationId: "conv-1", cwd: workDir, workspacePaths: [workDir], transcriptPath },
      { configPath: cfgPath, stateDir, env: {} }
    );
    assert.deepEqual(before, {});

    // 2. After first CHECKPOINT at step 10: re-injects Active Profile + USER.md once
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 10, source: "SYSTEM", type: "CHECKPOINT", content: "compacted" }) + "\n",
      "utf8"
    );
    assert.equal(latestCheckpointStepIndex(transcriptPath), 10);
    const firstCompact = handlePreInvocation(
      "agy",
      { conversationId: "conv-1", cwd: workDir, workspacePaths: [workDir], transcriptPath },
      { configPath: cfgPath, stateDir, env: {} }
    );
    assert.ok(Array.isArray(firstCompact.injectSteps));
    const text1 = firstCompact.injectSteps[0].systemMessage.systemMessage;
    assert.match(text1, /# Active Profile: work/);
    assert.match(text1, /Always verify live\./);

    // 3. Subsequent turn at same checkpoint: returns {} (no duplicate injection)
    const repeatTurn = handlePreInvocation(
      "agy",
      { conversationId: "conv-1", cwd: workDir, workspacePaths: [workDir], transcriptPath },
      { configPath: cfgPath, stateDir, env: {} }
    );
    assert.deepEqual(repeatTurn, {});

    // 4. Second CHECKPOINT at step 50 via scripts/hook.mjs CLI: re-injects once again
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 50, source: "SYSTEM", type: "CHECKPOINT", content: "compacted 2" }) + "\n",
      "utf8"
    );
    const proc = spawnSync(process.execPath, [HOOK_SCRIPT, "agy", "pre-invocation"], {
      input: JSON.stringify({ conversationId: "conv-1", cwd: workDir, workspacePaths: [workDir], transcriptPath }),
      encoding: "utf8",
      env: { ...process.env, AGENT_PROFILES_CONFIG: cfgPath, AGENT_PROFILES_STATE_DIR: stateDir, AGENT_PROFILE: "" },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const parsed = JSON.parse(proc.stdout);
    assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /# Active Profile: work/);
    assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /Always verify live\./);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
