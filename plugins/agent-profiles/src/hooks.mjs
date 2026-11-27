import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENV_KEY_RE, loadConfigState } from "./config.mjs";
import { buildSessionContext } from "./context.mjs";
import { expandHome, resolveConfigLocation } from "./paths.mjs";
import { resolveProfile } from "./resolver.mjs";

const MAX_COMPACTION_STATE_ENTRIES = 200;

/**
 * Scan an Antigravity JSONL transcript and return the highest step index of a
 * `type === "CHECKPOINT"` compaction marker, or `-1` when none exists.
 */
export function latestCheckpointStepIndex(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    return -1;
  }
  let text;
  try {
    if (!fs.existsSync(transcriptPath)) {
      return -1;
    }
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return -1;
  }

  let latest = -1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes('"CHECKPOINT"')) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.type === "CHECKPOINT") {
      const step = Number.isInteger(obj.step_index) ? obj.step_index : i;
      if (step > latest) {
        latest = step;
      }
    }
  }
  return latest;
}

function resolveCompactionStateDir(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir;
  const platform = options.platform ?? process.platform;
  const explicit = (options.stateDir ?? env.AGENT_PROFILES_STATE_DIR ?? env.PLUGIN_DATA ?? "").trim();
  if (explicit) {
    return expandHome(explicit, homeDir, platform);
  }
  const loc = resolveConfigLocation(options);
  return path.join(loc.configDir, "state");
}

function readCompactionState(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCompactionStateAtomic(stateDir, statePath, data) {
  const entries = Object.entries(data);
  const trimmed =
    entries.length > MAX_COMPACTION_STATE_ENTRIES
      ? Object.fromEntries(entries.slice(entries.length - MAX_COMPACTION_STATE_ENTRIES))
      : data;

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(trimmed, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, statePath);
    return true;
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup failure.
    }
    return false;
  }
}

export function escapePosixSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Format safe POSIX export lines suitable for `CLAUDE_ENV_FILE`.
 */
export function formatPosixExports(envMap) {
  const lines = [];
  for (const [key, value] of Object.entries(envMap || {})) {
    if (!ENV_KEY_RE.test(key)) {
      continue;
    }
    const str = String(value);
    if (str.includes("\0") || str.includes("\n") || str.includes("\r")) {
      continue;
    }
    lines.push(`export ${key}=${escapePosixSingleQuote(str)}`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/**
 * Infer target agent runtime when hook is invoked with `auto`.
 */
export function detectAgent(requestedAgent, payload, env = process.env) {
  const normalized = (requestedAgent || "auto").toLowerCase();
  if (normalized === "agy" || normalized === "antigravity") {
    return "agy";
  }
  if (normalized === "claude" || normalized === "claude-code") {
    return "claude";
  }
  if (normalized === "codex") {
    return "codex";
  }

  // Auto-detect based on payload fields and host env vars
  if (
    payload &&
    (Array.isArray(payload.workspacePaths) ||
      typeof payload.conversationId === "string" ||
      typeof payload.hookEventName === "string")
  ) {
    return "agy";
  }
  if (env.CLAUDE_ENV_FILE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) {
    return "claude";
  }
  return "codex";
}

/**
 * Pure hook handler for SessionStart across Antigravity, Claude Code, and Codex.
 */
export function handleSessionStart(requestedAgent, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const agent = detectAgent(requestedAgent, payload, env);

  const cwd =
    (typeof payload.cwd === "string" && payload.cwd.trim()) ||
    (typeof env.CLAUDE_PROJECT_DIR === "string" && env.CLAUDE_PROJECT_DIR.trim()) ||
    options.fallbackCwd ||
    process.cwd();

  const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];

  const configState =
    options.configState ??
    loadConfigState({
      configPath: options.configPath,
      env,
      platform: options.platform,
      homeDir: options.homeDir,
    });

  const resolution = resolveProfile({
    cwd,
    workspacePaths,
    env,
    configState,
    platform: options.platform,
    homeDir: options.homeDir,
    readFile: options.readFile,
  });

  // In Claude Code, persist profile env vars into CLAUDE_ENV_FILE when unambiguously resolved.
  const claudeEnvFile = (env.CLAUDE_ENV_FILE || "").trim();
  if (agent === "claude" && claudeEnvFile && resolution.valid && !resolution.conflict) {
    const exportsText = formatPosixExports(resolution.env);
    if (exportsText) {
      const appendFile = options.appendFile ?? ((filePath, data) => fs.appendFileSync(filePath, data, "utf8"));
      try {
        appendFile(claudeEnvFile, exportsText);
      } catch {
        // Non-fatal: still inject context message to the model.
      }
    }
  }

  const maxContextFileChars = configState.config?.maxContextFileChars ?? 8000;
  const markdown = buildSessionContext(resolution, {
    maxContextFileChars,
    readFile: options.readFile,
  });

  if (agent === "agy") {
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: markdown,
          },
        },
      ],
    };
  }

  // Claude Code & Codex share the same hookSpecificOutput schema for SessionStart.
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: markdown,
    },
  };
}

/**
 * Pure hook handler for PreInvocation (Antigravity compaction recovery).
 * Returns `{}` on normal turns; once a new `CHECKPOINT` appears in `transcriptPath`,
 * persists the checkpoint cursor and re-injects Active Profile + contextFiles once.
 */
export function handlePreInvocation(requestedAgent, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const agent = detectAgent(requestedAgent, payload, env);
  if (agent !== "agy") {
    return {};
  }

  const convId = String(payload.conversationId || "").trim();
  const transcriptPath = String(payload.transcriptPath || "").trim();
  if (!convId || !transcriptPath) {
    return {};
  }

  const checkpointStep = latestCheckpointStepIndex(transcriptPath);
  if (checkpointStep < 0) {
    return {};
  }

  const stateDir = resolveCompactionStateDir(options);
  const statePath = path.join(stateDir, "compaction-state.json");
  const state = readCompactionState(statePath);
  const prevStep = Number.isInteger(state[convId]) ? state[convId] : -1;
  if (checkpointStep <= prevStep) {
    return {};
  }

  // Persist cursor before re-injecting; if persistence fails, skip to avoid repeating every turn.
  const nextState = { ...state };
  delete nextState[convId];
  nextState[convId] = checkpointStep;
  if (!writeCompactionStateAtomic(stateDir, statePath, nextState)) {
    return {};
  }

  return handleSessionStart(agent, payload, options);
}

/**
 * Read stdin, dispatch hook event, and write JSON response to stdout.
 */
export async function runHookFromStdio(argv = process.argv.slice(2)) {
  const [agentArg = "auto", eventArg = "session-start"] = argv;

  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  let payload = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        payload = parsed;
      }
    } catch {
      payload = {};
    }
  }

  let output = {};
  try {
    const event = eventArg.toLowerCase();
    if (event === "session-start" || event === "sessionstart") {
      output = handleSessionStart(agentArg, payload);
    } else if (event === "pre-invocation" || event === "preinvocation") {
      output = handlePreInvocation(agentArg, payload);
    } else {
      output = {};
    }
  } catch (err) {
    if (process.env.AGENT_PROFILES_DEBUG) {
      process.stderr.write(`[agent-profiles] hook error: ${err.message}\n`);
    }
    output = {};
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}
