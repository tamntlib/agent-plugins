import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigLocation } from "./paths.mjs";

export const CONFIG_VERSION = 1;
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_KEY_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|AUTH_KEY|SESSION_KEY)(?:$|_)/i;

export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    defaultProfile: "default",
    envVars: ["AGENT_PROFILE"],
    markerFiles: [".agent-profile"],
    maxContextFileChars: 8000,
    strictUnknownProfile: true,
    profiles: {
      default: {
        description: "Default profile for workspaces outside explicit profile paths",
        paths: [],
        env: {
          AGENT_PROFILE: "default",
        },
        contextFiles: [],
        instructions: "",
      },
      work: {
        description: "Work repositories and corporate accounts",
        paths: ["~/work"],
        env: {
          AGENT_PROFILE: "work",
        },
        contextFiles: [],
        instructions: "",
      },
    },
  };
}

export function isValidProfileName(name) {
  return typeof name === "string" && PROFILE_NAME_RE.test(name);
}

export function isSuspiciousSecretEnvKey(key) {
  return typeof key === "string" && SECRET_KEY_RE.test(key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeMarkerFilename(name) {
  if (typeof name !== "string") {
    return false;
  }
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return false;
  }
  return !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes("\0");
}

/**
 * Validate and normalize a raw parsed config object.
 * Returns `{ ok: true, config, warnings }` or `{ ok: false, errors, warnings }`.
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["Config root must be a JSON object."], warnings };
  }

  const version = raw.version === undefined ? CONFIG_VERSION : raw.version;
  if (!Number.isInteger(version) || version < 1 || version > CONFIG_VERSION) {
    errors.push(`Unsupported config version "${String(raw.version)}". Expected ${CONFIG_VERSION}.`);
  }

  let envVars = ["AGENT_PROFILE"];
  if (raw.envVars !== undefined) {
    if (!Array.isArray(raw.envVars) || !raw.envVars.every((v) => typeof v === "string" && ENV_KEY_RE.test(v))) {
      errors.push("`envVars` must be an array of valid environment variable names.");
    } else {
      envVars = [...new Set(raw.envVars)];
    }
  }

  let markerFiles = [".agent-profile"];
  if (raw.markerFiles !== undefined) {
    if (!Array.isArray(raw.markerFiles) || !raw.markerFiles.every(isSafeMarkerFilename)) {
      errors.push("`markerFiles` must be an array of plain filenames without path separators.");
    } else {
      markerFiles = [...new Set(raw.markerFiles.map((m) => m.trim()))];
    }
  }

  let maxContextFileChars = 8000;
  if (raw.maxContextFileChars !== undefined) {
    if (!Number.isInteger(raw.maxContextFileChars) || raw.maxContextFileChars < 0) {
      errors.push("`maxContextFileChars` must be a non-negative integer.");
    } else {
      maxContextFileChars = raw.maxContextFileChars;
    }
  }

  const strictUnknownProfile =
    raw.strictUnknownProfile === undefined ? true : Boolean(raw.strictUnknownProfile);

  if (!isPlainObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    errors.push("`profiles` must be a non-empty object mapping profile names to profile definitions.");
    return { ok: false, errors, warnings };
  }

  const profiles = {};
  for (const [name, entry] of Object.entries(raw.profiles)) {
    if (!isValidProfileName(name)) {
      errors.push(
        `Invalid profile name "${name}". Use lowercase letters, digits, ".", "_", or "-" (1-64 chars).`
      );
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push(`Profile "${name}" must be an object.`);
      continue;
    }

    const description = entry.description === undefined ? "" : entry.description;
    if (typeof description !== "string") {
      errors.push(`Profile "${name}.description" must be a string.`);
    }

    const paths = entry.paths === undefined ? [] : entry.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.trim().length > 0)) {
      errors.push(`Profile "${name}.paths" must be an array of non-empty path strings.`);
    }

    const env = entry.env === undefined ? {} : entry.env;
    const cleanEnv = {};
    if (!isPlainObject(env)) {
      errors.push(`Profile "${name}.env" must be an object mapping variable names to strings.`);
    } else {
      for (const [k, v] of Object.entries(env)) {
        if (!ENV_KEY_RE.test(k)) {
          errors.push(`Profile "${name}.env" contains invalid variable name "${k}".`);
          continue;
        }
        if (typeof v !== "string") {
          errors.push(`Profile "${name}.env.${k}" must be a string.`);
          continue;
        }
        if (v.includes("\0") || v.includes("\n") || v.includes("\r")) {
          errors.push(`Profile "${name}.env.${k}" must not contain newlines or NUL bytes.`);
          continue;
        }
        if (isSuspiciousSecretEnvKey(k)) {
          warnings.push(
            `Profile "${name}.env.${k}" looks like a secret. Keep credentials in per-profile .env files or a keychain instead of agent-profiles config.json.`
          );
        }
        cleanEnv[k] = v;
      }
    }

    const contextFiles = entry.contextFiles === undefined ? [] : entry.contextFiles;
    if (
      !Array.isArray(contextFiles) ||
      !contextFiles.every((f) => typeof f === "string" && f.trim().length > 0)
    ) {
      errors.push(`Profile "${name}.contextFiles" must be an array of non-empty file path strings.`);
    }

    const instructions = entry.instructions === undefined ? "" : entry.instructions;
    if (typeof instructions !== "string") {
      errors.push(`Profile "${name}.instructions" must be a string.`);
    }

    profiles[name] = {
      description: typeof description === "string" ? description : "",
      paths: Array.isArray(paths) ? paths.map((p) => p.trim()) : [],
      env: cleanEnv,
      contextFiles: Array.isArray(contextFiles) ? contextFiles.map((f) => f.trim()) : [],
      instructions: typeof instructions === "string" ? instructions : "",
    };
  }

  const defaultProfile =
    typeof raw.defaultProfile === "string" ? raw.defaultProfile.trim() : "";
  if (!defaultProfile) {
    errors.push("`defaultProfile` is required and must be a non-empty string.");
  } else if (!profiles[defaultProfile]) {
    errors.push(`\`defaultProfile\` "${defaultProfile}" does not exist in \`profiles\`.`);
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    config: {
      version,
      defaultProfile,
      envVars,
      markerFiles,
      maxContextFileChars,
      strictUnknownProfile,
      profiles,
    },
    warnings,
  };
}

/**
 * Load user configuration from disk, or return built-in defaults if config.json does not exist yet.
 * Fails closed (`error !== null`) if config.json exists but is unreadable or invalid.
 */
export function loadConfigState(options = {}) {
  const location = resolveConfigLocation(options);
  const { configDir, configPath } = location;

  if (!fs.existsSync(configPath)) {
    return {
      loaded: false,
      exists: false,
      configDir,
      configPath,
      locationSource: location.source,
      config: createDefaultConfig(),
      warnings: [],
      error: null,
    };
  }

  let rawText;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    return {
      loaded: false,
      exists: true,
      configDir,
      configPath,
      locationSource: location.source,
      config: null,
      warnings: [],
      error: `Failed to read config at ${configPath}: ${err.message}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      loaded: false,
      exists: true,
      configDir,
      configPath,
      locationSource: location.source,
      config: null,
      warnings: [],
      error: `Invalid JSON in ${configPath}: ${err.message}`,
    };
  }

  const validated = validateConfig(parsed);
  if (!validated.ok) {
    return {
      loaded: false,
      exists: true,
      configDir,
      configPath,
      locationSource: location.source,
      config: null,
      warnings: validated.warnings,
      error: `Invalid config in ${configPath}: ${validated.errors.join(" ")}`,
    };
  }

  return {
    loaded: true,
    exists: true,
    configDir,
    configPath,
    locationSource: location.source,
    config: validated.config,
    warnings: validated.warnings,
    error: null,
  };
}

/**
 * Atomically write config.json with restrictive permissions (0700 dir, 0600 file on POSIX).
 */
export function writeConfigAtomic(configPath, config) {
  const validated = validateConfig(config);
  if (!validated.ok) {
    throw new Error(`Refusing to write invalid config: ${validated.errors.join(" ")}`);
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Ignore chmod failures on filesystems without POSIX modes.
    }
  }

  const payload = JSON.stringify(validated.config, null, 2) + "\n";
  const tmpPath = `${configPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
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
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Ignore chmod failures on filesystems without POSIX modes.
    }
  }

  return validated.config;
}
