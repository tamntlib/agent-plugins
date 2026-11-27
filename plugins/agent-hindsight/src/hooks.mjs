import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPermanentRetainError,
  recallMemories,
  reflectMemory,
  retainTurns,
} from "./client.mjs";
import { loadProfileConfig, resolveEffectiveBank } from "./config.mjs";
import { resolveStateDir } from "./paths.mjs";
import { resolveHindsightProfile } from "./profile.mjs";
import {
  appendHookLog,
  enqueueRetryJob,
  getConvState,
  listRetryJobs,
  removeRetryJob,
  setRecalledKey,
  setRetainedStep,
} from "./state.mjs";
import { extractNewTurns, latestUserStepIndex } from "./transcript.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, "..", "scripts", "hook.mjs");
const DEFAULT_MAX_RETAIN_ATTEMPTS = 5;

export function detectAgent(requestedAgent, payload = {}, env = process.env) {
  const norm = (requestedAgent || "auto").toLowerCase();
  if (norm === "agy" || norm === "antigravity") return "agy";
  if (norm === "claude" || norm === "claude-code") return "claude";
  if (norm === "codex") return "codex";

  if (
    Array.isArray(payload.workspacePaths) ||
    typeof payload.conversationId === "string" ||
    typeof payload.hookEventName === "string"
  ) {
    return "agy";
  }
  if (env.CLAUDE_ENV_FILE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) {
    return "claude";
  }
  return "codex";
}

function getConversationId(payload) {
  return String(payload.conversationId || payload.session_id || "").trim();
}

function getTranscriptPath(payload) {
  return String(payload.transcriptPath || payload.transcript_path || "").trim();
}

function getPromptText(payload) {
  return String(payload.lastUserInput || payload.prompt || payload.user_prompt || "").trim();
}

function formatHookOutput(agent, eventName, text) {
  if (!text) {
    return {};
  }
  if (agent === "agy") {
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: text,
          },
        },
      ],
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  };
}

export function handleSessionStart(requestedAgent, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const agent = detectAgent(requestedAgent, payload, env);
  const prof = resolveHindsightProfile(payload, options);
  if (!prof.valid || !prof.profile) {
    return {};
  }

  const cfg = loadProfileConfig(prof.profile, options);
  if (cfg.configError) {
    return {};
  }

  const hasTags = Array.isArray(cfg.recallTags) && cfg.recallTags.length > 0;
  const bankInfo = resolveEffectiveBank(cfg, payload, options);
  const readOnlyExtras = bankInfo.recallBanks.filter((b) => !bankInfo.writeBanks.includes(b));
  const extraParts = [];
  if (bankInfo.extraWriteBanks.length) {
    extraParts.push(`extra write+read: ${bankInfo.extraWriteBanks.map((b) => `\`${b}\``).join(", ")}`);
  }
  if (readOnlyExtras.length) {
    extraParts.push(`additional read-only: ${readOnlyExtras.map((b) => `\`${b}\``).join(", ")}`);
  }
  const extraSuffix = extraParts.length ? ` (${extraParts.join("; ")})` : "";
  const modeSuffix = cfg.memoryMode !== "hybrid" ? ` | mode: \`${cfg.memoryMode}\`` : "";

  const lines = [];
  if (!prof.managedByAgentProfiles) {
    lines.push(`# Active Profile: ${prof.profile}`, "");
  }
  if (hasTags) {
    const primaryTag = cfg.recallTags[0];
    lines.push(
      `# Hindsight Bank (${primaryTag})`,
      "",
      `Hindsight bank: \`${bankInfo.bankId}\`${extraSuffix} | Active tag: \`${primaryTag}\`${modeSuffix}.`,
      cfg.memoryMode === "context"
        ? "Memory mode is `context` (automatic injection only; MCP tools disabled)."
        : `When calling Hindsight MCP tools directly, prefer \`tags: ["${primaryTag}"]\` (and \`tags_match: "${cfg.recallTagsMatch}"\` for recall).`
    );
  } else {
    lines.push(
      `# Hindsight Bank (${bankInfo.bankId})`,
      "",
      `Hindsight bank: \`${bankInfo.bankId}\`${extraSuffix} (bank-isolated; no profile tags required)${modeSuffix}.`,
      cfg.memoryMode === "context"
        ? "Memory mode is `context` (automatic injection only; MCP tools disabled)."
        : "Hindsight MCP tools are already scoped to this bank; no profile `tags` parameter is needed."
    );
  }

  return formatHookOutput(agent, "SessionStart", lines.join("\n"));
}

export async function handleRecallHook(requestedAgent, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const agent = detectAgent(requestedAgent, payload, env);
  const rawQuery = getPromptText(payload);
  if (rawQuery.length < 3) {
    return {};
  }

  const prof = resolveHindsightProfile(payload, options);
  if (!prof.valid || !prof.profile) {
    return {};
  }

  const stateDir = resolveStateDir(options);
  const cfg = loadProfileConfig(prof.profile, options);
  if (cfg.configError) {
    appendHookLog(stateDir, `Config error (${prof.profile}): ${cfg.configError}`);
    return {};
  }

  if (!cfg.autoRecall || cfg.memoryMode === "tools") {
    return {};
  }

  const query =
    cfg.recallMaxInputChars > 0 ? rawQuery.slice(0, cfg.recallMaxInputChars) : rawQuery;

  const convId = getConversationId(payload);
  const transcriptPath = getTranscriptPath(payload);
  const latestStep = latestUserStepIndex(transcriptPath);
  const qhash = crypto.createHash("sha256").update(query).digest("hex").slice(0, 16);
  const dedupKey = `${latestStep}:${qhash}`;

  const prev = getConvState(stateDir, convId);
  if (convId && prev.lastRecalledKey === dedupKey) {
    return {};
  }

  // Record before HTTP call so timeouts never stall subsequent tool steps in the same turn.
  setRecalledKey(stateDir, convId, dedupKey);

  const bankInfo = resolveEffectiveBank(cfg, payload, options);
  let bodyText = "";

  if (cfg.recallPrefetchMethod === "reflect") {
    const doReflect = options.reflectFn ?? reflectMemory;
    try {
      const resp = await doReflect(cfg, query, { bankId: bankInfo.bankId });
      bodyText = typeof resp?.text === "string" ? resp.text.trim() : "";
    } catch (err) {
      appendHookLog(
        stateDir,
        `Reflect prefetch failed (profile=${prof.profile}, bank=${bankInfo.bankId}): ${err.message}`
      );
      return {};
    }
  } else {
    const doRecall = options.recallFn ?? recallMemories;
    let resp;
    try {
      resp = await doRecall(cfg, query, {
        bankId: bankInfo.bankId,
        recallBanks: bankInfo.recallBanks,
        stateDir,
        nowMs: options.nowMs,
        cooldownMs: options.cooldownMs,
      });
    } catch (err) {
      appendHookLog(
        stateDir,
        `Recall failed (profile=${prof.profile}, bank=${bankInfo.bankId}): ${err.message}`
      );
      return {};
    }
    const results = Array.isArray(resp?.results) ? resp.results : [];
    const bullets = results
      .filter((r) => r && typeof r === "object" && typeof r.text === "string" && r.text.trim())
      .map((r) => `- ${r.text.trim()}`);
    bodyText = bullets.join("\n");
  }

  if (!bodyText) {
    return {};
  }

  const hasTags = Array.isArray(cfg.recallTags) && cfg.recallTags.length > 0;
  const activeBanksLabel =
    cfg.recallPrefetchMethod === "reflect"
      ? bankInfo.bankId
      : bankInfo.recallBanks.join(", ");
  const scopeLabel = hasTags
    ? `${cfg.recallTags[0]} | bank:${activeBanksLabel}`
    : `bank:${activeBanksLabel}`;
  const header =
    cfg.recallPromptPreamble ||
    [
      `# Hindsight Memory (${scopeLabel} — persistent cross-session context)`,
      "Use this to answer questions about the user and prior sessions. Do not call tools to look up information that is already present here.",
    ].join("\n");

  const eventName = agent === "agy" ? "PreInvocation" : "UserPromptSubmit";
  return formatHookOutput(agent, eventName, `${header}\n\n${bodyText}`);
}

export function handleStopHook(requestedAgent, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const agent = detectAgent(requestedAgent, payload, env);

  if (agent === "agy") {
    if (String(payload.terminationReason || "") !== "NO_TOOL_CALL") {
      return {};
    }
    if (payload.fullyIdle === false) {
      return {};
    }
  } else if (payload.stop_hook_active === true) {
    return {};
  }

  const convId = getConversationId(payload);
  const transcriptPath = getTranscriptPath(payload);
  if (!convId || !transcriptPath) {
    return {};
  }

  const prof = resolveHindsightProfile(payload, options);
  if (!prof.valid || !prof.profile) {
    return {};
  }

  const cfgForRetain = loadProfileConfig(prof.profile, options);
  if (cfgForRetain.configError || !cfgForRetain.autoRetain) {
    return {};
  }

  const stateDir = resolveStateDir(options);
  const prev = getConvState(stateDir, convId);
  const turns = extractNewTurns(transcriptPath, prev.lastRetainedStep);
  if (turns.length === 0) {
    return {};
  }

  // Match Hermes 1.2.4 retain_every_n_turns: buffer until N new turns accumulate.
  const cadence = cfgForRetain.retainEveryNTurns || 1;
  if (cadence > 1 && turns.length < cadence) {
    return {};
  }

  const maxStep = Math.max(...turns.map((t) => t.step));
  setRetainedStep(stateDir, convId, maxStep);

  const bankInfo = resolveEffectiveBank(cfgForRetain, payload, options);

  const operationIds = Object.fromEntries(
    bankInfo.writeBanks.map((b) => [b, crypto.randomUUID()])
  );
  const job = {
    agent,
    profile: prof.profile,
    bankId: bankInfo.bankId,
    writeBanks: bankInfo.writeBanks,
    conversationId: convId,
    configDir: options.configDir,
    stateDir,
    turns,
    operationId: operationIds[bankInfo.bankId],
    operationIds,
    fallbackDocumentId: `${agent}-${convId}-${crypto.randomBytes(6).toString("hex")}`,
    attempts: 0,
    maxAttempts: DEFAULT_MAX_RETAIN_ATTEMPTS,
    createdAt: new Date().toISOString(),
  };

  if (typeof options.dispatchWorker === "function") {
    options.dispatchWorker(job);
    return {};
  }

  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const jobPath = path.join(
      stateDir,
      `retain-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`
    );
    fs.writeFileSync(jobPath, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });

    const child = spawn(process.execPath, [HOOK_SCRIPT, "_retain-worker", jobPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.unref();
  } catch (err) {
    appendHookLog(stateDir, `Failed spawning retain worker: ${err.message}`);
  }

  return {};
}

async function executeRetainJob(job, options = {}) {
  const turns = Array.isArray(job?.turns) ? job.turns : [];
  if (turns.length === 0) {
    return { ok: true };
  }

  const profile = String(job.profile || "default");
  const convId = String(job.conversationId || "");
  const agent = String(job.agent || "agent");
  const stateDir = job.stateDir || resolveStateDir(options);
  const cfg = loadProfileConfig(profile, {
    ...options,
    configDir: job.configDir ?? options.configDir,
  });

  if (cfg.configError) {
    appendHookLog(stateDir, `Retain skipped due to config error (${profile}): ${cfg.configError}`);
    return { ok: true };
  }

  const writeBanks =
    Array.isArray(job.writeBanks) && job.writeBanks.length > 0
      ? job.writeBanks
      : [job.bankId || cfg.bankId];

  const doRetain = options.retainFn ?? retainTurns;
  try {
    await doRetain(cfg, {
      conversationId: convId,
      turns,
      agent,
      bankId: writeBanks[0],
      writeBanks,
      operationId: job.operationId,
      operationIds: job.operationIds,
      fallbackDocumentId: job.fallbackDocumentId,
      stateDir,
      nowMs: options.nowMs,
      cooldownMs: options.cooldownMs,
    });
    return { ok: true };
  } catch (err) {
    const attempts = (Number.isInteger(job.attempts) ? job.attempts : 0) + 1;
    const maxAttempts = Number.isInteger(job.maxAttempts)
      ? job.maxAttempts
      : DEFAULT_MAX_RETAIN_ATTEMPTS;

    if (!isPermanentRetainError(err) && attempts < maxAttempts) {
      enqueueRetryJob(stateDir, {
        ...job,
        attempts,
        maxAttempts,
        lastError: err.message,
      });
      appendHookLog(
        stateDir,
        `Retain transient failure (${attempts}/${maxAttempts}, profile=${profile}, bank=${writeBanks[0]}, conv=${convId}); queued for retry: ${err.message}`
      );
      return { ok: false, requeued: true };
    }

    appendHookLog(
      stateDir,
      `Retain POST failed permanently (attempts=${attempts}, profile=${profile}, bank=${writeBanks[0]}, conv=${convId}): ${err.message}`
    );
    return { ok: false, requeued: false };
  }
}

export async function handleRetainWorker(jobPath, options = {}) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch {
    return;
  } finally {
    try {
      fs.rmSync(jobPath, { force: true });
    } catch {
      // Ignore cleanup error.
    }
  }

  const stateDir = job?.stateDir || resolveStateDir(options);

  // Drain any previously failed transient retain jobs first (FIFO) so turn order is preserved.
  const pendingPaths = listRetryJobs(stateDir);
  for (const retryPath of pendingPaths) {
    let retryJob;
    try {
      retryJob = JSON.parse(fs.readFileSync(retryPath, "utf8"));
    } catch {
      removeRetryJob(retryPath);
      continue;
    }
    removeRetryJob(retryPath);
    const res = await executeRetainJob(retryJob, options);
    if (!res.ok && res.requeued) {
      // Server still unreachable; defer current unattempted job behind the retry queue without burning an attempt.
      const attempts = Number.isInteger(job.attempts) ? job.attempts : 0;
      const maxAttempts = Number.isInteger(job.maxAttempts)
        ? job.maxAttempts
        : DEFAULT_MAX_RETAIN_ATTEMPTS;
      if (attempts < maxAttempts) {
        enqueueRetryJob(stateDir, { ...job, attempts, maxAttempts });
      }
      return;
    }
  }

  await executeRetainJob(job, options);
}

export async function runHookFromStdio(argv = process.argv.slice(2)) {
  const [first = "auto", second = "session-start"] = argv;

  if (first === "_retain-worker") {
    if (second) {
      await handleRetainWorker(second);
    }
    return 0;
  }

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
    const event = second.toLowerCase();
    if (event === "session-start" || event === "sessionstart") {
      output = handleSessionStart(first, payload);
    } else if (
      event === "pre-invocation" ||
      event === "preinvocation" ||
      event === "user-prompt-submit" ||
      event === "userpromptsubmit"
    ) {
      output = await handleRecallHook(first, payload);
    } else if (event === "stop") {
      output = handleStopHook(first, payload);
    }
  } catch (err) {
    if (process.env.AGENT_HINDSIGHT_DEBUG) {
      process.stderr.write(`[agent-hindsight] hook error: ${err.message}\n`);
    }
    output = {};
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}
