import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Expand a leading `~`, `~/`, or `~\` to the user's home directory.
 * Plain strings and `~otheruser` paths are returned unchanged.
 */
export function expandHome(inputPath, homeDir = os.homedir(), platform = process.platform) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return "";
  }
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    const rest = inputPath.slice(2);
    const pApi = pathApiFor(platform);
    const normalizedRest = platform === "win32" ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
    return normalizedRest ? pApi.join(homeDir, normalizedRest) : homeDir;
  }
  return inputPath;
}

/**
 * Expand leading `~/` or `~\` inside an environment variable value when it looks
 * like a home-relative path. Non-path strings (e.g. "work", "profile:work") stay literal.
 */
export function expandEnvValue(value, homeDir = os.homedir(), platform = process.platform) {
  if (typeof value !== "string") {
    return String(value ?? "");
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return expandHome(value, homeDir, platform);
  }
  return value;
}

function stripTrailingSeparators(resolvedPath, pApi) {
  const parsed = pApi.parse(resolvedPath);
  if (resolvedPath === parsed.root) {
    return resolvedPath;
  }
  let out = resolvedPath;
  while (out.length > parsed.root.length && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Normalize a path into a canonical comparable string for prefix matching.
 * Supports injectable `platform` and `homeDir` for deterministic cross-platform tests.
 */
export function normalizePath(inputPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const baseDir = options.baseDir ?? (platform === process.platform ? process.cwd() : homeDir);
  const pApi = pathApiFor(platform);

  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return "";
  }

  let raw = inputPath.trim();
  if (raw === "~") {
    raw = homeDir;
  } else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    raw = pApi.join(homeDir, raw.slice(2));
  }

  if (platform === "win32") {
    raw = raw.replace(/\//g, "\\");
  }

  const resolved = pApi.isAbsolute(raw) ? pApi.normalize(raw) : pApi.resolve(baseDir, raw);
  return stripTrailingSeparators(resolved, pApi);
}

/**
 * Resolve symlinks on the local filesystem when possible; fall back to normalized lexical path.
 */
export function tryRealpath(inputPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const normalized = normalizePath(inputPath, options);
  if (!normalized || platform !== process.platform) {
    return null;
  }
  try {
    const real = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(normalized)
      : fs.realpathSync(normalized);
    return normalizePath(real, options);
  } catch {
    return null;
  }
}

/**
 * Prepare a normalized path for prefix comparison (case-insensitive on Windows).
 */
export function comparablePath(normalizedPath, platform = process.platform) {
  if (!normalizedPath) {
    return "";
  }
  return platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

/**
 * True iff `targetPath` is equal to `rootPath` or strictly inside `rootPath`
 * along a real directory boundary (so `/home/u/workspace` never matches `/home/u/work`).
 */
export function isPathWithin(targetPath, rootPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const pApi = pathApiFor(platform);

  const target = comparablePath(normalizePath(targetPath, options), platform);
  const root = comparablePath(normalizePath(rootPath, options), platform);
  if (!target || !root) {
    return false;
  }
  if (target === root) {
    return true;
  }
  const sep = pApi.sep;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Walk from `startPath` upward to the filesystem root (inclusive).
 * If `startPath` points to an existing regular file on the current OS, starts at its parent dir.
 */
export function walkAncestors(startPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const pApi = pathApiFor(platform);

  let current = normalizePath(startPath, options);
  if (!current) {
    return [];
  }

  if (platform === process.platform) {
    try {
      const stat = fs.statSync(current);
      if (stat.isFile()) {
        current = stripTrailingSeparators(pApi.dirname(current), pApi);
      }
    } catch {
      // Directory may not exist yet; still walk lexical ancestors.
    }
  }

  const result = [];
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    const parent = stripTrailingSeparators(pApi.dirname(current), pApi);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }
  return result;
}

/**
 * Determine the default configuration directory and file path across Linux, macOS, and Windows.
 */
export function resolveConfigLocation(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const fileExists = options.fileExists ?? ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const pApi = pathApiFor(platform);

  const explicitConfig = (options.configPath ?? env.AGENT_PROFILES_CONFIG ?? "").trim();
  if (explicitConfig) {
    const configPath = normalizePath(explicitConfig, { platform, homeDir });
    return {
      configDir: stripTrailingSeparators(pApi.dirname(configPath), pApi),
      configPath,
      source: options.configPath ? "flag" : "env:AGENT_PROFILES_CONFIG",
    };
  }

  const explicitHome = (env.AGENT_PROFILES_HOME ?? "").trim();
  if (explicitHome) {
    const configDir = normalizePath(explicitHome, { platform, homeDir });
    return {
      configDir,
      configPath: pApi.join(configDir, "config.json"),
      source: "env:AGENT_PROFILES_HOME",
    };
  }

  const xdgConfigHome = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdgConfigHome) {
    const configDir = pApi.join(normalizePath(xdgConfigHome, { platform, homeDir }), "agent-profiles");
    return {
      configDir,
      configPath: pApi.join(configDir, "config.json"),
      source: "env:XDG_CONFIG_HOME",
    };
  }

  const dotConfigDir = pApi.join(normalizePath(homeDir, { platform, homeDir }), ".config", "agent-profiles");
  const dotConfigPath = pApi.join(dotConfigDir, "config.json");

  if (platform === "win32") {
    if (fileExists(dotConfigPath)) {
      return {
        configDir: dotConfigDir,
        configPath: dotConfigPath,
        source: "dotconfig",
      };
    }
    const appData = (env.APPDATA ?? "").trim();
    if (appData) {
      const configDir = pApi.join(normalizePath(appData, { platform, homeDir }), "agent-profiles");
      return {
        configDir,
        configPath: pApi.join(configDir, "config.json"),
        source: "env:APPDATA",
      };
    }
  }

  return {
    configDir: dotConfigDir,
    configPath: dotConfigPath,
    source: "default",
  };
}
