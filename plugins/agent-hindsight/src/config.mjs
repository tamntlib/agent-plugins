import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverTrustedRepoBankId,
  normalizeMinScores,
  normalizeObservationScopes,
  normalizeStringList,
  parseBooleanSetting,
  parseIntSetting,
  renderBankIdTemplate,
  resolveRepoContext,
} from "./banks.mjs";
import { expandHome, resolveConfigDir } from "./paths.mjs";

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_API_URL = "http://127.0.0.1:8888";
export const DEFAULT_BANK_ID = "default";
export const DEFAULT_RECALL_MAX_INPUT_CHARS = 800;
const MAX_EXTENDS_DEPTH = 5;
const VALID_BUDGETS = new Set(["low", "mid", "high"]);
const VALID_MEMORY_MODES = new Set(["hybrid", "context", "tools"]);
const VALID_PREFETCH_METHODS = new Set(["recall", "reflect"]);

const CONFIG_ALIAS_GROUPS = [
  ["apiUrl", "api_url"],
  ["apiKey", "api_key"],
  ["bankId", "bank_id"],
  ["bankIdTemplate", "bank_id_template"],
  ["mcpUrl", "mcp_url"],
  ["trustedProjectDirs", "trusted_project_dirs"],
  ["mirrorToOwnBank", "mirror_to_own_bank"],
  ["additionalBanks", "additional_banks"],
  ["recallAdditionalBanks", "recall_additional_banks"],
  ["recallTags", "recall_tags"],
  ["recallTagsMatch", "recall_tags_match"],
  ["retainTags", "retain_tags"],
  ["observationScopes", "observation_scopes"],
  ["recallTypes", "recall_types"],
  ["recallMinScores", "recall_min_scores"],
  ["budget", "recall_budget"],
  ["maxTokens", "max_tokens", "recall_max_tokens"],
  ["memoryMode", "memory_mode"],
  ["recallPrefetchMethod", "recall_prefetch_method", "prefetchMethod", "prefetch_method"],
  ["reflectTags", "reflect_tags"],
  ["reflectTagsMatch", "reflect_tags_match"],
  ["autoRecall", "auto_recall"],
  ["autoRetain", "auto_retain"],
  ["retainAsync", "retain_async"],
  ["retainEveryNTurns", "retain_every_n_turns"],
  ["recallMaxInputChars", "recall_max_input_chars"],
  ["recallPromptPreamble", "recall_prompt_preamble"],
  ["retainContext", "retain_context"],
  ["retainStrategy", "retain_strategy"],
  ["retainUserPrefix", "retain_user_prefix"],
  ["retainAssistantPrefix", "retain_assistant_prefix"],
  ["retainSource", "retain_source"],
  ["recallTimeoutMs", "recall_timeout_ms"],
  ["retainTimeoutMs", "retain_timeout_ms"],
];

const CONFIG_ALIAS_MAP = new Map();
for (const group of CONFIG_ALIAS_GROUPS) {
  for (const key of group) {
    CONFIG_ALIAS_MAP.set(key, group);
  }
}

export const ALLOWED_ENV_KEYS = new Set([
  "HINDSIGHT_API_KEY",
  "HINDSIGHT_API_URL",
  "HINDSIGHT_BANK_ID",
  "HINDSIGHT_BANK_ID_TEMPLATE",
  "HINDSIGHT_MCP_URL",
  "HINDSIGHT_RETAIN_STRATEGY",
  "HINDSIGHT_RETAIN_SOURCE",
  "HINDSIGHT_RETAIN_CONTEXT",
  "HINDSIGHT_RETAIN_USER_PREFIX",
  "HINDSIGHT_RETAIN_ASSISTANT_PREFIX",
  "HINDSIGHT_RETAIN_OBSERVATION_SCOPES",
  "HINDSIGHT_RETAIN_TAGS",
]);

export function createStarterProfileConfig(profile = "default", overrides = {}) {
  const bankId = String(overrides.bankId || DEFAULT_BANK_ID).trim() || DEFAULT_BANK_ID;
  const bankIdTemplate = String(overrides.bankIdTemplate || "").trim();
  const isDedicatedBank = Boolean(bankIdTemplate) || bankId !== DEFAULT_BANK_ID;
  const starter = {};

  if (overrides.apiUrl && String(overrides.apiUrl).trim().replace(/\/+$/, "") !== DEFAULT_API_URL) {
    starter.apiUrl = String(overrides.apiUrl).trim().replace(/\/+$/, "");
  }
  starter.bankId = bankId;
  if (bankIdTemplate) {
    starter.bankIdTemplate = bankIdTemplate;
  }
  if (Array.isArray(overrides.recallAdditionalBanks) && overrides.recallAdditionalBanks.length > 0) {
    starter.recallAdditionalBanks = overrides.recallAdditionalBanks;
  }
  if (overrides.mirrorToOwnBank === true) {
    starter.mirrorToOwnBank = true;
  }
  if (Array.isArray(overrides.additionalBanks) && overrides.additionalBanks.length > 0) {
    starter.additionalBanks = overrides.additionalBanks;
  }
  if (Array.isArray(overrides.trustedProjectDirs) && overrides.trustedProjectDirs.length > 0) {
    starter.trustedProjectDirs = overrides.trustedProjectDirs;
  }
  if (overrides.memoryMode && overrides.memoryMode !== "hybrid") {
    starter.memoryMode = overrides.memoryMode;
  }
  if (overrides.autoRecall === false) {
    starter.autoRecall = false;
  }
  if (overrides.autoRetain === false) {
    starter.autoRetain = false;
  }
  if (overrides.budget && overrides.budget !== "mid") {
    starter.budget = overrides.budget;
  }
  if (overrides.maxTokens !== undefined && overrides.maxTokens !== 4096) {
    starter.maxTokens = overrides.maxTokens;
  }
  if (
    overrides.recallMaxInputChars !== undefined &&
    overrides.recallMaxInputChars !== DEFAULT_RECALL_MAX_INPUT_CHARS
  ) {
    starter.recallMaxInputChars = overrides.recallMaxInputChars;
  }
  if (overrides.recallPromptPreamble) {
    starter.recallPromptPreamble = overrides.recallPromptPreamble;
  }
  if (overrides.recallPrefetchMethod && overrides.recallPrefetchMethod !== "recall") {
    starter.recallPrefetchMethod = overrides.recallPrefetchMethod;
  }
  if (Array.isArray(overrides.reflectTags) && overrides.reflectTags.length > 0) {
    starter.reflectTags = overrides.reflectTags;
  }
  if (overrides.reflectTagsMatch && overrides.reflectTagsMatch !== "any") {
    starter.reflectTagsMatch = overrides.reflectTagsMatch;
  }
  if (overrides.recallMinScores) {
    starter.recallMinScores = overrides.recallMinScores;
  }
  if (overrides.retainAsync === false) {
    starter.retainAsync = false;
  }
  if (overrides.retainEveryNTurns !== undefined && overrides.retainEveryNTurns > 1) {
    starter.retainEveryNTurns = overrides.retainEveryNTurns;
  }
  if (overrides.retainContext) {
    starter.retainContext = overrides.retainContext;
  }
  if (overrides.retainStrategy) {
    starter.retainStrategy = overrides.retainStrategy;
  }
  if (overrides.retainUserPrefix && overrides.retainUserPrefix !== "User") {
    starter.retainUserPrefix = overrides.retainUserPrefix;
  }
  if (overrides.retainAssistantPrefix && overrides.retainAssistantPrefix !== "Assistant") {
    starter.retainAssistantPrefix = overrides.retainAssistantPrefix;
  }
  if (overrides.recallTags !== undefined) {
    starter.recallTags = overrides.recallTags;
  } else if (!isDedicatedBank) {
    starter.recallTags = [`profile:${profile}`];
  }
  if (overrides.recallTagsMatch !== undefined) {
    starter.recallTagsMatch = overrides.recallTagsMatch;
  } else if (!isDedicatedBank) {
    starter.recallTagsMatch = "any_strict";
  }
  if (overrides.recallTypes !== undefined) {
    starter.recallTypes = overrides.recallTypes;
  }
  if (overrides.retainTags !== undefined) {
    starter.retainTags = overrides.retainTags;
  } else if (!isDedicatedBank) {
    starter.retainTags = [`profile:${profile}`];
  }
  if (overrides.observationScopes !== undefined) {
    starter.observationScopes = overrides.observationScopes;
  } else if (!isDedicatedBank) {
    starter.observationScopes = [[`profile:${profile}`]];
  }
  if (overrides.recallTimeoutMs !== undefined && overrides.recallTimeoutMs !== 7000) {
    starter.recallTimeoutMs = overrides.recallTimeoutMs;
  }
  if (overrides.retainTimeoutMs !== undefined && overrides.retainTimeoutMs !== 15000) {
    starter.retainTimeoutMs = overrides.retainTimeoutMs;
  }
  return starter;
}

/**
 * Literal UTF-8 .env reader (no shell sourcing, skips symlinks, caps size at 64 KiB).
 */
export function readAllowlistedEnvFile(envPath, allowlist = ALLOWED_ENV_KEYS) {
  const result = {};
  try {
    const lstat = fs.lstatSync(envPath);
    if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size > 65536) {
      return result;
    }
    const text = fs.readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const eq = line.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = line.slice(0, eq).trim();
      if (!allowlist.has(key)) {
        continue;
      }
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
      ) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch {
    // Missing or unreadable file returns empty map.
  }
  return result;
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, data: null, error: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { exists: true, data: null, error: `Config at ${filePath} must be a JSON object.` };
    }
    return { exists: true, data, error: null };
  } catch (err) {
    return { exists: true, data: null, error: `Invalid JSON in ${filePath}: ${err.message}` };
  }
}

function mergeConfigObjects(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "extends") {
      continue;
    }
    const aliases = CONFIG_ALIAS_MAP.get(key);
    if (aliases) {
      for (const alias of aliases) {
        delete merged[alias];
      }
    }
    merged[key] = value;
  }
  return merged;
}

function resolveCanonicalPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveConfigWithExtends(entryPath, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pApi = platform === "win32" ? path.win32 : path.posix;
  const loaded = readJsonSafe(entryPath);
  if (!loaded.exists || loaded.error) {
    return { ...loaded, extendsPaths: [] };
  }

  const chain = [{ filePath: entryPath, data: loaded.data }];
  const visited = new Set([resolveCanonicalPath(entryPath)]);
  const extendsPaths = [];
  let currentPath = entryPath;
  let currentData = loaded.data;

  while (
    Object.prototype.hasOwnProperty.call(currentData, "extends") &&
    currentData.extends !== undefined &&
    currentData.extends !== null
  ) {
    if (typeof currentData.extends !== "string" || !currentData.extends.trim()) {
      return {
        exists: true,
        data: null,
        error: `Invalid "extends" value in ${currentPath}: must be a non-empty file path string.`,
        extendsPaths,
      };
    }
    if (extendsPaths.length >= MAX_EXTENDS_DEPTH) {
      return {
        exists: true,
        data: null,
        error: `Config "extends" chain exceeds maximum depth (${MAX_EXTENDS_DEPTH}) at ${currentPath}.`,
        extendsPaths,
      };
    }
    const expanded = expandHome(currentData.extends.trim(), homeDir, platform);
    const parentPath = pApi.isAbsolute(expanded)
      ? expanded
      : pApi.resolve(pApi.dirname(currentPath), expanded);
    const canonicalParent = resolveCanonicalPath(parentPath);
    if (visited.has(canonicalParent)) {
      return {
        exists: true,
        data: null,
        error: `Circular "extends" reference detected: ${parentPath}`,
        extendsPaths,
      };
    }
    visited.add(canonicalParent);

    const parentLoaded = readJsonSafe(parentPath);
    if (!parentLoaded.exists) {
      return {
        exists: true,
        data: null,
        error: `Extended config not found: ${parentPath} (referenced from ${currentPath}).`,
        extendsPaths,
      };
    }
    if (parentLoaded.error) {
      return {
        exists: true,
        data: null,
        error: parentLoaded.error,
        extendsPaths,
      };
    }

    extendsPaths.push(parentPath);
    chain.push({ filePath: parentPath, data: parentLoaded.data });
    currentPath = parentPath;
    currentData = parentLoaded.data;
  }

  let merged = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    merged = mergeConfigObjects(merged, chain[i].data);
  }
  return { exists: true, data: merged, error: null, extendsPaths };
}

/**
 * Load effective Hindsight configuration for a resolved profile.
 * Lookup order for config.json: `<configDir>/<profile>/config.json` -> `<configDir>/config.json` -> defaults.
 * Optional `"extends"` in config.json inherits from another JSON config file with alias-aware overrides.
 * Lookup order for secrets/overrides: process env -> `<configDir>/<profile>/.env` -> `<configDir>/.env`.
 */
export function loadProfileConfig(profile, options = {}) {
  const env = options.env ?? process.env;
  const configDir = resolveConfigDir(options);
  const safeProfile = PROFILE_NAME_RE.test(profile || "") ? profile : "default";

  const profileDir = path.join(configDir, safeProfile);
  const profileCfgPath = path.join(profileDir, "config.json");
  const rootCfgPath = path.join(configDir, "config.json");

  let selectedCfgPath = profileCfgPath;
  let loaded = resolveConfigWithExtends(profileCfgPath, options);
  if (!loaded.exists) {
    const rootLoaded = resolveConfigWithExtends(rootCfgPath, options);
    if (rootLoaded.exists) {
      selectedCfgPath = rootCfgPath;
      loaded = rootLoaded;
    }
  }

  const raw = loaded.data || {};
  const profileEnv = readAllowlistedEnvFile(path.join(profileDir, ".env"));
  const sharedEnv = readAllowlistedEnvFile(path.join(configDir, ".env"));

  const pickEnv = (key) => {
    if (typeof env[key] === "string" && env[key].trim() !== "") {
      return env[key].trim();
    }
    if (typeof profileEnv[key] === "string" && profileEnv[key].trim() !== "") {
      return profileEnv[key].trim();
    }
    if (typeof sharedEnv[key] === "string" && sharedEnv[key].trim() !== "") {
      return sharedEnv[key].trim();
    }
    return "";
  };

  const defaultTag = `profile:${safeProfile}`;
  const rawApiUrl =
    pickEnv("HINDSIGHT_API_URL") || raw.apiUrl || raw.api_url || DEFAULT_API_URL;
  const apiUrl = String(rawApiUrl).trim().replace(/\/+$/, "");
  const bankId = String(
    pickEnv("HINDSIGHT_BANK_ID") || raw.bankId || raw.bank_id || DEFAULT_BANK_ID
  ).trim();
  const bankIdTemplate = String(
    pickEnv("HINDSIGHT_BANK_ID_TEMPLATE") || raw.bankIdTemplate || raw.bank_id_template || ""
  ).trim();
  const apiKey =
    pickEnv("HINDSIGHT_API_KEY") || String(raw.apiKey || raw.api_key || "").trim();
  const explicitMcpUrl = String(
    pickEnv("HINDSIGHT_MCP_URL") || raw.mcpUrl || raw.mcp_url || ""
  ).trim();
  const mcpUrl = explicitMcpUrl || `${apiUrl}/mcp/${encodeURIComponent(bankId)}/`;

  const trustedProjectDirs = normalizeStringList(
    raw.trustedProjectDirs ?? raw.trusted_project_dirs
  );
  const mirrorToOwnBank = parseBooleanSetting(
    raw.mirrorToOwnBank ?? raw.mirror_to_own_bank,
    false
  );
  const additionalBanks = normalizeStringList(
    raw.additionalBanks ?? raw.additional_banks
  );
  const recallAdditionalBanks = normalizeStringList(
    raw.recallAdditionalBanks ?? raw.recall_additional_banks
  );
  const isDedicatedBank = Boolean(bankIdTemplate) || bankId !== DEFAULT_BANK_ID;

  const rawRecallTags = raw.recallTags ?? raw.recall_tags;
  const rawRetainTags =
    raw.retainTags ?? raw.retain_tags ?? (pickEnv("HINDSIGHT_RETAIN_TAGS") || undefined);
  const recallTags =
    rawRecallTags !== undefined
      ? normalizeStringList(rawRecallTags)
      : isDedicatedBank
        ? []
        : [defaultTag];
  const retainTags =
    rawRetainTags !== undefined
      ? normalizeStringList(rawRetainTags)
      : isDedicatedBank
        ? []
        : [defaultTag];
  const rawScopes =
    raw.observationScopes ??
    raw.observation_scopes ??
    (pickEnv("HINDSIGHT_RETAIN_OBSERVATION_SCOPES") || undefined);
  const observationScopes =
    rawScopes !== undefined
      ? normalizeObservationScopes(rawScopes)
      : recallTags.length === 0 && retainTags.length === 0
        ? "shared"
        : [[defaultTag]];
  const rawRecallTypes = raw.recallTypes ?? raw.recall_types;
  const recallTypes =
    rawRecallTypes !== undefined
      ? normalizeStringList(rawRecallTypes)
      : ["observation"];
  const recallMinScores = normalizeMinScores(
    raw.recallMinScores ?? raw.recall_min_scores
  );

  const rawBudget = String(raw.budget || raw.recall_budget || "mid").trim().toLowerCase();
  const budget = VALID_BUDGETS.has(rawBudget) ? rawBudget : "mid";
  const rawMemoryMode = String(raw.memoryMode || raw.memory_mode || "hybrid").trim().toLowerCase();
  const memoryMode = VALID_MEMORY_MODES.has(rawMemoryMode) ? rawMemoryMode : "hybrid";
  const rawPrefetch = String(
    raw.recallPrefetchMethod ||
      raw.recall_prefetch_method ||
      raw.prefetchMethod ||
      raw.prefetch_method ||
      "recall"
  )
    .trim()
    .toLowerCase();
  const recallPrefetchMethod = VALID_PREFETCH_METHODS.has(rawPrefetch) ? rawPrefetch : "recall";

  const rawReflectTags = raw.reflectTags ?? raw.reflect_tags;
  const reflectTags =
    rawReflectTags !== undefined
      ? normalizeStringList(rawReflectTags)
      : isDedicatedBank
        ? []
        : [defaultTag];
  const reflectTagsMatch = String(
    raw.reflectTagsMatch ||
      raw.reflect_tags_match ||
      (rawReflectTags === undefined && !isDedicatedBank ? "any_strict" : "any")
  ).trim();

  const autoRecall = parseBooleanSetting(raw.autoRecall ?? raw.auto_recall, true);
  const autoRetain = parseBooleanSetting(raw.autoRetain ?? raw.auto_retain, true);
  const retainAsync = parseBooleanSetting(raw.retainAsync ?? raw.retain_async, true);
  const retainEveryNTurns = parseIntSetting(
    raw.retainEveryNTurns ?? raw.retain_every_n_turns,
    1,
    { min: 1 }
  );
  const recallMaxInputChars = parseIntSetting(
    raw.recallMaxInputChars ?? raw.recall_max_input_chars,
    DEFAULT_RECALL_MAX_INPUT_CHARS,
    { min: 0 }
  );
  const recallPromptPreamble = String(
    raw.recallPromptPreamble ?? raw.recall_prompt_preamble ?? ""
  ).trim();
  const retainContext = String(
    raw.retainContext ?? raw.retain_context ?? pickEnv("HINDSIGHT_RETAIN_CONTEXT") ?? ""
  ).trim();
  const retainStrategy = String(
    raw.retainStrategy ?? raw.retain_strategy ?? pickEnv("HINDSIGHT_RETAIN_STRATEGY") ?? ""
  ).trim();
  const retainUserPrefix =
    String(
      raw.retainUserPrefix ?? raw.retain_user_prefix ?? pickEnv("HINDSIGHT_RETAIN_USER_PREFIX") ?? ""
    ).trim() || "User";
  const retainAssistantPrefix =
    String(
      raw.retainAssistantPrefix ??
        raw.retain_assistant_prefix ??
        pickEnv("HINDSIGHT_RETAIN_ASSISTANT_PREFIX") ??
        ""
    ).trim() || "Assistant";
  const retainSource = String(
    raw.retainSource ?? raw.retain_source ?? pickEnv("HINDSIGHT_RETAIN_SOURCE") ?? ""
  ).trim();

  const warnings = [];
  if (raw.apiKey || raw.api_key) {
    warnings.push(
      `API key found inside ${selectedCfgPath}; store HINDSIGHT_API_KEY in a 0600 .env file or process env instead.`
    );
  }
  if (loaded.error) {
    warnings.push(loaded.error);
  }

  return {
    profile: safeProfile,
    configDir,
    configPath: selectedCfgPath,
    extendsPaths: loaded.extendsPaths || [],
    configLoaded: Boolean(loaded.exists && !loaded.error),
    configError: loaded.error,
    apiUrl,
    mcpUrl,
    explicitMcpUrl,
    apiKey,
    bankId,
    bankIdTemplate,
    trustedProjectDirs,
    mirrorToOwnBank,
    additionalBanks,
    recallAdditionalBanks,
    recallMinScores,
    memoryMode,
    autoRecall,
    autoRetain,
    budget,
    maxTokens: parseIntSetting(
      raw.maxTokens ?? raw.max_tokens ?? raw.recall_max_tokens,
      4096,
      { min: 1 }
    ),
    recallMaxInputChars,
    recallPromptPreamble,
    recallPrefetchMethod,
    reflectTags,
    reflectTagsMatch,
    recallTags,
    recallTagsMatch: String(raw.recallTagsMatch || raw.recall_tags_match || "any_strict"),
    recallTypes,
    retainTags,
    observationScopes,
    retainAsync,
    retainEveryNTurns,
    retainContext,
    retainStrategy,
    retainUserPrefix,
    retainAssistantPrefix,
    retainSource,
    recallTimeoutMs: parseIntSetting(raw.recallTimeoutMs ?? raw.recall_timeout_ms, 7000, { min: 100 }),
    retainTimeoutMs: parseIntSetting(raw.retainTimeoutMs ?? raw.retain_timeout_ms, 15000, { min: 100 }),
    warnings,
  };
}

/**
 * Resolve effective primary bank, write bank set, recall bank set, and MCP URL for a
 * concrete working directory / hook payload. Matches Hermes hindsight 1.2.4 precedence:
 * 1. Nearest `.hindsight/config.toml` inside a repo under `trustedProjectDirs`
 * 2. `bankIdTemplate`
 * 3. Static `bankId`
 */
export function resolveEffectiveBank(cfg, payloadOrDir, options = {}) {
  const { startDir, repoRoot, project } = resolveRepoContext(payloadOrDir, options);
  const workspace = startDir ? path.basename(startDir) : "";

  const repoConfigBank =
    repoRoot && cfg.trustedProjectDirs?.length
      ? discoverTrustedRepoBankId(startDir, repoRoot, cfg.trustedProjectDirs, options)
      : null;

  let bankId;
  let bankSource;
  if (repoConfigBank) {
    bankId = repoConfigBank;
    bankSource = "repository config";
  } else if (cfg.bankIdTemplate) {
    bankId = renderBankIdTemplate(cfg.bankIdTemplate, cfg.bankId, {
      profile: cfg.profile,
      project,
      workspace,
      platform: options.platformName || "",
      user: options.user || "",
      session: options.sessionId || "",
    });
    bankSource = "template";
  } else {
    bankId = cfg.bankId;
    bankSource = "bank_id";
  }

  // Write set: primary -> static own bank (when mirrorToOwnBank) -> additionalBanks (deduped)
  const writeBanks = [bankId];
  if (cfg.mirrorToOwnBank && cfg.bankId && !writeBanks.includes(cfg.bankId)) {
    writeBanks.push(cfg.bankId);
  }
  for (const b of cfg.additionalBanks || []) {
    if (b && !writeBanks.includes(b)) {
      writeBanks.push(b);
    }
  }

  // Recall set: write set first, then recall-only additional banks (deduped)
  const recallBanks = [...writeBanks];
  for (const b of cfg.recallAdditionalBanks || []) {
    if (b && !recallBanks.includes(b)) {
      recallBanks.push(b);
    }
  }

  const extraWriteBanks = writeBanks.slice(1);
  const additionalBanks = recallBanks.slice(1);
  const mcpUrl = cfg.explicitMcpUrl || `${cfg.apiUrl}/mcp/${encodeURIComponent(bankId)}/`;

  return {
    bankId,
    bankSource,
    project,
    writeBanks,
    extraWriteBanks,
    additionalBanks,
    recallBanks,
    mcpUrl,
  };
}

export function writeProfileConfigAtomic(configDir, profile, config) {
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }
  const dir = path.join(configDir, profile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(dir, 0o700);
    } catch {
      // Ignore on filesystems without POSIX modes.
    }
  }
  const targetPath = path.join(dir, "config.json");
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error.
    }
    throw err;
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // Ignore.
    }
  }
  return targetPath;
}
