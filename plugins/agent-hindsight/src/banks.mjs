import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./paths.mjs";

/**
 * URL/filesystem-safe bank_id segment matching Hermes hindsight 1.2.4 `_sanitize_bank_segment`:
 * runs outside `[A-Za-z0-9_-]` (Unicode letters/digits + `_` + `-`) become one dash;
 * leading/trailing `-` and `_` are stripped.
 */
export function sanitizeBankSegment(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  return String(value)
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Render a bank_id template (`{profile}`, `{project}`, `{workspace}`, `{platform}`, `{user}`, `{session}`),
 * collapsing repeated `-`/`_` left by empty placeholders and stripping leading/trailing separators.
 * Matches Hermes hindsight 1.2.4 `_resolve_bank_id_template`.
 */
export function renderBankIdTemplate(template, fallback, placeholders = {}) {
  const tpl = typeof template === "string" ? template.trim() : "";
  if (!tpl) {
    return fallback;
  }

  let invalid = false;
  const rendered = tpl.replace(/\{([^{}]+)\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(placeholders, key)) {
      invalid = true;
      return "";
    }
    return sanitizeBankSegment(placeholders[key]);
  });

  if (invalid || rendered.includes("{") || rendered.includes("}")) {
    return fallback;
  }

  const collapsed = rendered
    .replace(/([-_])\1+/g, "$1")
    .replace(/^[-_]+|[-_]+$/g, "");
  return collapsed || fallback;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * Find the nearest folder at or above `startDir` containing `.git` (dir or worktree file).
 * Returns null outside a repository or for a repo rooted at homeDir or filesystem root.
 * Matches Hermes hindsight 1.2.4 `_repository_root`.
 */
export function findRepositoryRoot(startDir, options = {}) {
  if (!startDir || typeof startDir !== "string" || !startDir.trim()) {
    return null;
  }
  const homeDir = safeRealpath(options.homeDir ?? os.homedir());
  let current = safeRealpath(startDir.trim());
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    // Keep resolved path as-is.
  }

  while (true) {
    const fsRoot = path.parse(current).root;
    if (current === homeDir || current === fsRoot) {
      return null;
    }
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolve the main repository basename behind `repoRoot`, mapping linked git worktrees
 * via `.git` -> `gitdir:` -> `commondir` so every worktree shares one project name.
 * Matches Hermes hindsight 1.2.4 `_main_repository` + `_project_name`.
 */
export function resolveMainRepositoryName(repoRoot) {
  if (!repoRoot) {
    return "";
  }
  const gitMarker = path.join(repoRoot, ".git");
  try {
    const st = fs.lstatSync(gitMarker);
    if (st.isFile()) {
      const content = fs.readFileSync(gitMarker, "utf8").trim();
      if (content.startsWith("gitdir:")) {
        const rawGitDir = content.slice("gitdir:".length).trim();
        const gitDir = safeRealpath(path.resolve(repoRoot, rawGitDir));
        const commonDirFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonDirFile)) {
          const rawCommon = fs.readFileSync(commonDirFile, "utf8").trim();
          if (rawCommon) {
            const commonDir = safeRealpath(path.resolve(gitDir, rawCommon));
            if (path.basename(commonDir) === ".git") {
              return path.basename(path.dirname(commonDir));
            }
            return path.basename(commonDir).replace(/\.git$/i, "");
          }
        }
      }
    }
  } catch {
    // Fall back to repoRoot basename on unreadable .git marker.
  }
  return path.basename(repoRoot);
}

/**
 * Resolve the active project name from hook payload (`cwd` and `workspacePaths`) or a directory string.
 * Checks `cwd` first, then `workspacePaths` in order, returning the first git repository's main name.
 */
export function resolveProjectName(payloadOrDir, options = {}) {
  const candidates = [];
  if (typeof payloadOrDir === "string") {
    if (payloadOrDir.trim()) candidates.push(payloadOrDir.trim());
  } else if (payloadOrDir && typeof payloadOrDir === "object") {
    if (typeof payloadOrDir.cwd === "string" && payloadOrDir.cwd.trim()) {
      candidates.push(payloadOrDir.cwd.trim());
    }
    if (Array.isArray(payloadOrDir.workspacePaths)) {
      for (const ws of payloadOrDir.workspacePaths) {
        if (typeof ws === "string" && ws.trim()) {
          candidates.push(ws.trim());
        }
      }
    }
  }

  for (const dir of candidates) {
    const repoRoot = findRepositoryRoot(dir, options);
    if (repoRoot) {
      return resolveMainRepositoryName(repoRoot);
    }
  }
  return "";
}

/**
 * Resolve both the starting directory and nearest git repository root from hook payload or path.
 */
export function resolveRepoContext(payloadOrDir, options = {}) {
  const candidates = [];
  if (typeof payloadOrDir === "string") {
    if (payloadOrDir.trim()) candidates.push(payloadOrDir.trim());
  } else if (payloadOrDir && typeof payloadOrDir === "object") {
    if (typeof payloadOrDir.cwd === "string" && payloadOrDir.cwd.trim()) {
      candidates.push(payloadOrDir.cwd.trim());
    }
    if (Array.isArray(payloadOrDir.workspacePaths)) {
      for (const ws of payloadOrDir.workspacePaths) {
        if (typeof ws === "string" && ws.trim()) {
          candidates.push(ws.trim());
        }
      }
    }
  }

  for (const dir of candidates) {
    const repoRoot = findRepositoryRoot(dir, options);
    if (repoRoot) {
      return {
        startDir: safeRealpath(dir),
        repoRoot,
        project: resolveMainRepositoryName(repoRoot),
      };
    }
  }
  return {
    startDir: candidates[0] ? safeRealpath(candidates[0]) : "",
    repoRoot: null,
    project: "",
  };
}

/**
 * Minimal zero-dependency TOML parser reading only top-level `bank_id = "..."` / `'...'`.
 * Stops at the first `[section]` header so table-scoped keys cannot spoof top-level `bank_id`.
 */
export function parseBankIdFromToml(text) {
  if (typeof text !== "string") {
    return null;
  }
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.trim()) {
    return null;
  }
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      break;
    }
    const m = line.match(/^bank_id\s*=\s*(.+)$/);
    if (!m) {
      continue;
    }
    const rhs = m[1].trim();
    let val = "";
    if (rhs.startsWith('"')) {
      const dq = rhs.match(/^"((?:[^"\\]|\\.)*)"(?:\s*(?:#.*)?)$/);
      if (!dq) return null;
      val = dq[1].replace(/\\(["\\])/g, "$1");
    } else if (rhs.startsWith("'")) {
      const sq = rhs.match(/^'([^']*)'(?:\s*(?:#.*)?)$/);
      if (!sq) return null;
      val = sq[1];
    } else {
      return null;
    }
    return val.trim() || null;
  }
  return null;
}

function isSubpathOrEqual(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Discover `bank_id` from the nearest `.hindsight/config.toml` inside a trusted repository.
 * Mirrors Hermes hindsight 1.2.4 `_discover_cwd_bank_id`:
 * - Only absolute entries in `trustedDirs` are accepted.
 * - Trust is evaluated on `repoRoot` physically (a linked worktree is judged by its own path).
 * - Walks upward from `startDir` up to `repoRoot` and never above it.
 */
export function discoverTrustedRepoBankId(startDir, repoRoot, trustedDirs = [], options = {}) {
  if (!repoRoot || !Array.isArray(trustedDirs) || trustedDirs.length === 0) {
    return null;
  }
  const homeDir = options.homeDir ?? os.homedir();
  const realRoot = safeRealpath(repoRoot);
  const trustedResolved = [];
  for (const rawEntry of trustedDirs) {
    const expanded = expandHome(String(rawEntry || "").trim(), homeDir);
    if (expanded && path.isAbsolute(expanded)) {
      trustedResolved.push(safeRealpath(expanded));
    }
  }
  if (trustedResolved.length === 0) {
    return null;
  }
  if (!trustedResolved.some((t) => isSubpathOrEqual(realRoot, t))) {
    return null;
  }

  let current = safeRealpath(startDir || realRoot);
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    // Keep resolved path.
  }
  if (!isSubpathOrEqual(current, realRoot)) {
    current = realRoot;
  }

  while (true) {
    const candidate = path.join(current, ".hindsight", "config.toml");
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const bank = parseBankIdFromToml(fs.readFileSync(candidate, "utf8"));
        if (bank) {
          return bank;
        }
      }
    } catch {
      // Unreadable file -> continue walking up.
    }
    if (current === realRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function parseBooleanSetting(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return defaultValue;
}

export function parseIntSetting(value, defaultValue, { min = 0 } = {}) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    return defaultValue;
  }
  return n;
}

/**
 * Normalize a string list (JSON array, JS array, or comma-separated string).
 */
export function normalizeStringList(value) {
  if (!value) {
    return [];
  }
  let items = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          items = parsed;
        }
      } catch {
        items = trimmed.split(",");
      }
    } else {
      items = trimmed.split(",");
    }
  }

  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const s = String(raw ?? "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

const OBSERVATION_SCOPE_KEYWORDS = new Set([
  "per_tag",
  "combined",
  "all_combinations",
  "shared",
]);

/**
 * Normalize `observationScopes` to a keyword string (`"shared"`, `"combined"`, `"per_tag"`,
 * `"all_combinations"`), a `string[][]` scope list, or `null`.
 * Matches Hermes hindsight 1.2.4 `_normalize_observation_scopes`.
 */
export function normalizeObservationScopes(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (OBSERVATION_SCOPE_KEYWORDS.has(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("[")) {
      try {
        return normalizeObservationScopes(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  const nested = value.every((entry) => typeof entry === "string") ? [value] : value;
  const scopes = nested
    .map((entry) => {
      if (Array.isArray(entry)) {
        return entry.map((tag) => String(tag ?? "").trim()).filter(Boolean);
      }
      if (typeof entry === "string" && entry.trim()) {
        return [entry.trim()];
      }
      return [];
    })
    .filter((s) => s.length > 0);
  return scopes.length > 0 ? scopes : null;
}

/**
 * Normalize `recallMinScores` to `{ [stage]: finiteNumber }` or `null`.
 * Matches Hermes hindsight 1.2.4 `_normalize_min_scores`.
 */
export function normalizeMinScores(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const floors = {};
  for (const [name, raw] of Object.entries(obj)) {
    if (typeof raw === "boolean" || typeof raw !== "number" || !Number.isFinite(raw)) {
      continue;
    }
    const key = String(name).trim();
    if (key) {
      floors[key] = raw;
    }
  }
  return Object.keys(floors).length > 0 ? floors : null;
}

/**
 * Client-side per-result score floor verification matching Hermes hindsight 1.2.4 `_clears_min_scores`.
 * Because Hindsight fuses 4 arms, a `semantic`/`keyword` floor only prunes its own SQL arm server-side;
 * rejecting results missing the floored stage lets `{"semantic": 0.70}` abstain cleanly on off-topic queries.
 * Results carrying no `scores` object at all (older servers) are kept.
 */
export function clearsMinScores(result, floors) {
  if (!floors || typeof floors !== "object") {
    return true;
  }
  const entries = Object.entries(floors);
  if (entries.length === 0) {
    return true;
  }
  const scores = result && typeof result === "object" ? result.scores : null;
  if (scores === null || scores === undefined || typeof scores !== "object") {
    return true;
  }
  return entries.every(([stage, floor]) => {
    const val = scores[stage];
    return typeof val === "number" && Number.isFinite(val) && val >= floor;
  });
}
