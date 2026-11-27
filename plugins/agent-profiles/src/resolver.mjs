import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigState } from "./config.mjs";
import {
  comparablePath,
  expandEnvValue,
  isPathWithin,
  normalizePath,
  tryRealpath,
  walkAncestors,
} from "./paths.mjs";

function parseMarkerContent(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    return trimmed.toLowerCase();
  }
  return "";
}

function findMarkerInAncestors(candidatePath, markerFiles, options) {
  const platform = options.platform ?? process.platform;
  const pApi = platform === "win32" ? path.win32 : path.posix;
  const readMarker = options.readFile ?? ((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return null;
      }
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  });

  const ancestors = walkAncestors(candidatePath, options);
  for (const dir of ancestors) {
    for (const markerName of markerFiles) {
      const markerPath = pApi.join(dir, markerName);
      const raw = readMarker(markerPath);
      if (raw === null || raw === undefined) {
        continue;
      }
      const value = parseMarkerContent(raw);
      if (value) {
        return { profile: value, markerPath, candidatePath };
      }
    }
  }
  return null;
}

function findBestPathMatch(candidatePath, config, options) {
  const platform = options.platform ?? process.platform;
  const variants = [normalizePath(candidatePath, options)];
  const realCandidate = tryRealpath(candidatePath, options);
  if (realCandidate && !variants.includes(realCandidate)) {
    variants.push(realCandidate);
  }

  const matches = [];
  for (const [profileName, profileDef] of Object.entries(config.profiles)) {
    for (const rulePath of profileDef.paths || []) {
      const normRule = normalizePath(rulePath, options);
      if (!normRule) {
        continue;
      }
      const ruleVariants = [normRule];
      const realRule = tryRealpath(normRule, options);
      if (realRule && !ruleVariants.includes(realRule)) {
        ruleVariants.push(realRule);
      }

      let bestLen = -1;
      for (const candidateVar of variants) {
        for (const ruleVar of ruleVariants) {
          if (isPathWithin(candidateVar, ruleVar, options)) {
            const score = comparablePath(ruleVar, platform).length;
            if (score > bestLen) {
              bestLen = score;
            }
          }
        }
      }

      if (bestLen >= 0) {
        matches.push({
          profile: profileName,
          rule: rulePath,
          normalizedRule: normRule,
          score: bestLen,
          candidatePath,
        });
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.score - a.score);
  const topScore = matches[0].score;
  const topMatches = matches.filter((m) => m.score === topScore);
  const uniqueProfiles = [...new Set(topMatches.map((m) => m.profile))];

  if (uniqueProfiles.length > 1) {
    return {
      ambiguous: true,
      matches: topMatches,
    };
  }

  return {
    ambiguous: false,
    match: topMatches[0],
  };
}

function buildEffectiveEnv(profileName, profileDef, homeDir, platform = process.platform) {
  const env = { AGENT_PROFILE: profileName };
  for (const [k, v] of Object.entries(profileDef.env || {})) {
    env[k] = expandEnvValue(v, homeDir, platform);
  }
  return env;
}

function dedupeCandidates(cwd, workspacePaths, options) {
  const platform = options.platform ?? process.platform;
  const raw = [];
  if (typeof cwd === "string" && cwd.trim()) {
    raw.push(cwd.trim());
  }
  if (Array.isArray(workspacePaths)) {
    for (const p of workspacePaths) {
      if (typeof p === "string" && p.trim()) {
        raw.push(p.trim());
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const normalized = normalizePath(item, options);
    const key = comparablePath(normalized, platform);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Deterministically resolve the active profile for a session or command invocation.
 *
 * Precedence:
 *   1. `explicitProfile` (CLI `--profile`)
 *   2. Configured `envVars` in order (default: `AGENT_PROFILE`)
 *   3. Configured `markerFiles` walking up from `cwd` / `workspacePaths` (default: `.agent-profile`)
 *   4. Longest-prefix `paths` rule across configured profiles
 *   5. `defaultProfile`
 */
export function resolveProfile(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const configState = options.configState ?? loadConfigState({
    configPath: options.configPath,
    env,
    platform,
    homeDir,
  });

  const pathOptions = {
    platform,
    homeDir,
    baseDir: options.baseDir ?? (platform === process.platform ? process.cwd() : homeDir),
    readFile: options.readFile,
  };

  if (configState.error || !configState.config) {
    return {
      profile: null,
      valid: false,
      source: "config-error",
      matchedPath: null,
      configPath: configState.configPath,
      configLoaded: false,
      env: {},
      description: "",
      contextFiles: [],
      instructions: "",
      warnings: [...(configState.warnings || [])],
      conflict: null,
      error: configState.error || "Unable to load agent-profiles configuration.",
    };
  }

  const config = configState.config;
  const warnings = [...(configState.warnings || [])];
  const candidates = dedupeCandidates(options.cwd, options.workspacePaths, pathOptions);

  const finalize = (profileName, source, matchedPath = null, conflict = null) => {
    const profileDef = config.profiles[profileName];
    if (!profileDef) {
      const configured = Object.keys(config.profiles).join(", ");
      const msg = `Unknown profile "${profileName}" resolved from ${source}. Configured profiles: ${configured}.`;
      if (config.strictUnknownProfile) {
        return {
          profile: profileName,
          valid: false,
          source,
          matchedPath,
          configPath: configState.configPath,
          configLoaded: configState.loaded,
          env: {},
          description: "",
          contextFiles: [],
          instructions: "",
          warnings,
          conflict,
          error: msg,
        };
      }
      warnings.push(msg);
      return {
        profile: profileName,
        valid: true,
        source,
        matchedPath,
        configPath: configState.configPath,
        configLoaded: configState.loaded,
        env: { AGENT_PROFILE: profileName },
        description: "",
        contextFiles: [],
        instructions: "",
        warnings,
        conflict,
        error: null,
      };
    }

    return {
      profile: profileName,
      valid: true,
      source,
      matchedPath,
      configPath: configState.configPath,
      configLoaded: configState.loaded,
      env: buildEffectiveEnv(profileName, profileDef, homeDir, platform),
      description: profileDef.description,
      contextFiles: profileDef.contextFiles.map((f) => normalizePath(f, pathOptions)),
      instructions: profileDef.instructions,
      warnings,
      conflict,
      error: null,
    };
  };

  // 1. Explicit CLI flag
  if (typeof options.explicitProfile === "string" && options.explicitProfile.trim()) {
    return finalize(options.explicitProfile.trim().toLowerCase(), "cli");
  }

  // 2. Environment variables in configured order
  for (const varName of config.envVars) {
    const rawVal = env[varName];
    if (typeof rawVal === "string" && rawVal.trim()) {
      return finalize(rawVal.trim().toLowerCase(), `env:${varName}`);
    }
  }

  // 3 & 4. Evaluate each candidate path (marker > path rule) and detect multi-root conflicts
  const candidateResolutions = [];
  for (const candidate of candidates) {
    const markerHit = findMarkerInAncestors(candidate, config.markerFiles, pathOptions);
    if (markerHit) {
      candidateResolutions.push({
        candidate,
        kind: "marker",
        profile: markerHit.profile,
        source: `marker:${markerHit.markerPath}`,
      });
      continue;
    }

    const pathHit = findBestPathMatch(candidate, config, pathOptions);
    if (pathHit?.ambiguous) {
      const names = [...new Set(pathHit.matches.map((m) => m.profile))].join(", ");
      return {
        profile: null,
        valid: false,
        source: "ambiguous-path-rule",
        matchedPath: candidate,
        configPath: configState.configPath,
        configLoaded: configState.loaded,
        env: {},
        description: "",
        contextFiles: [],
        instructions: "",
        warnings,
        conflict: {
          reason: "duplicate-path-rule",
          matches: pathHit.matches.map((m) => ({
            profile: m.profile,
            rule: m.rule,
            candidatePath: m.candidatePath,
          })),
        },
        error: `Ambiguous path rules for "${candidate}": profiles [${names}] match with equal specificity.`,
      };
    }

    if (pathHit?.match) {
      candidateResolutions.push({
        candidate,
        kind: "path",
        profile: pathHit.match.profile,
        source: `path:${pathHit.match.rule}`,
      });
    }
  }

  if (candidateResolutions.length > 0) {
    // Markers take precedence over path rules across candidates; otherwise first candidate (cwd) wins.
    const markerResolutions = candidateResolutions.filter((r) => r.kind === "marker");
    const primary = markerResolutions.length > 0 ? markerResolutions[0] : candidateResolutions[0];

    const distinctProfiles = [...new Set(candidateResolutions.map((r) => r.profile))];
    let conflict = null;
    if (distinctProfiles.length > 1) {
      conflict = {
        reason: "mixed-workspace-profiles",
        profiles: distinctProfiles,
        matches: candidateResolutions.map((r) => ({
          profile: r.profile,
          source: r.source,
          candidatePath: r.candidate,
        })),
      };
      warnings.push(
        `Multiple workspace paths map to different profiles (${distinctProfiles.join(", ")}). Selected "${primary.profile}" from ${primary.source}; confirm before using profile-scoped accounts.`
      );
    }

    return finalize(primary.profile, primary.source, primary.candidate, conflict);
  }

  // 5. Fallback default profile
  return finalize(config.defaultProfile, "default", candidates[0] ?? null);
}
