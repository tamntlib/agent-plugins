import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function convStateFile(stateDir, convId) {
  const hash = crypto.createHash("sha256").update(String(convId)).digest("hex").slice(0, 24);
  return path.join(stateDir, `conv-${hash}.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function getConvState(stateDir, convId) {
  if (!convId) {
    return { lastRecalledKey: "", lastRetainedStep: -1 };
  }
  const filePath = convStateFile(stateDir, convId);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      lastRecalledKey: typeof raw.lastRecalledKey === "string" ? raw.lastRecalledKey : "",
      lastRetainedStep: Number.isInteger(raw.lastRetainedStep) ? raw.lastRetainedStep : -1,
    };
  } catch {
    return { lastRecalledKey: "", lastRetainedStep: -1 };
  }
}

function writeConvStateAtomic(stateDir, convId, nextState) {
  ensureDir(stateDir);
  const filePath = convStateFile(stateDir, convId);
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(nextState) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error.
    }
    throw err;
  }
}

export function setRecalledKey(stateDir, convId, key) {
  if (!convId) {
    return;
  }
  const current = getConvState(stateDir, convId);
  writeConvStateAtomic(stateDir, convId, {
    conversationId: convId,
    lastRecalledKey: key,
    lastRetainedStep: current.lastRetainedStep,
    updatedAt: new Date().toISOString(),
  });
}

export function setRetainedStep(stateDir, convId, stepIdx) {
  if (!convId) {
    return;
  }
  const current = getConvState(stateDir, convId);
  writeConvStateAtomic(stateDir, convId, {
    conversationId: convId,
    lastRecalledKey: current.lastRecalledKey,
    lastRetainedStep: Math.max(current.lastRetainedStep, stepIdx),
    updatedAt: new Date().toISOString(),
  });
}

export function appendHookLog(stateDir, message) {
  try {
    ensureDir(stateDir);
    const logPath = path.join(stateDir, "hooks.log");
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${message}\n`, "utf8");
  } catch {
    // Non-fatal logging failure.
  }
}

export const EXTRA_BANK_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RETRY_QUEUE_FILES = 50;

function cooldownsFile(stateDir) {
  return path.join(stateDir, "cooldowns.json");
}

function readCooldowns(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cooldownsFile(stateDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCooldownsAtomic(stateDir, data) {
  try {
    ensureDir(stateDir);
    const target = cooldownsFile(stateDir);
    const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // Non-fatal state write error.
  }
}

function cooldownKey(operation, bankId) {
  return `${operation}:${bankId}`;
}

export function isExtraBankAvailable(stateDir, operation, bankId, nowMs = Date.now()) {
  if (!stateDir || !bankId) {
    return true;
  }
  const map = readCooldowns(stateDir);
  const until = map[cooldownKey(operation, bankId)];
  return typeof until !== "number" || nowMs >= until;
}

export function markExtraBankFailed(
  stateDir,
  operation,
  bankId,
  cooldownMs = EXTRA_BANK_COOLDOWN_MS,
  nowMs = Date.now()
) {
  if (!stateDir || !bankId) {
    return { newlyDown: true };
  }
  const map = readCooldowns(stateDir);
  const key = cooldownKey(operation, bankId);
  const newlyDown = typeof map[key] !== "number" || nowMs >= map[key];
  map[key] = nowMs + cooldownMs;
  writeCooldownsAtomic(stateDir, map);
  return { newlyDown };
}

export function markExtraBankOk(stateDir, operation, bankId) {
  if (!stateDir || !bankId) {
    return { recovered: false };
  }
  const map = readCooldowns(stateDir);
  const key = cooldownKey(operation, bankId);
  if (!(key in map)) {
    return { recovered: false };
  }
  delete map[key];
  writeCooldownsAtomic(stateDir, map);
  return { recovered: true };
}

function retryQueueDir(stateDir) {
  return path.join(stateDir, "retry-queue");
}

export function enqueueRetryJob(stateDir, job) {
  if (!stateDir || !job) {
    return null;
  }
  try {
    const dir = retryQueueDir(stateDir);
    ensureDir(dir);
    const existing = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    while (existing.length >= MAX_RETRY_QUEUE_FILES) {
      const oldest = existing.shift();
      try {
        fs.rmSync(path.join(dir, oldest), { force: true });
      } catch {
        // Ignore prune error.
      }
    }
    const createdAt = job.createdAt || new Date().toISOString();
    const stamped = { ...job, createdAt };
    const safeTs = createdAt.replace(/[^0-9]/g, "").slice(0, 17);
    const filename = `retry-${safeTs}-${crypto.randomBytes(6).toString("hex")}.json`;
    const target = path.join(dir, filename);
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(stamped), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
    return target;
  } catch {
    return null;
  }
}

export function listRetryJobs(stateDir) {
  if (!stateDir) {
    return [];
  }
  try {
    const dir = retryQueueDir(stateDir);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function removeRetryJob(jobPath) {
  try {
    fs.rmSync(jobPath, { force: true });
  } catch {
    // Ignore cleanup error.
  }
}
