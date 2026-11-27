import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_NAME_RE } from "./config.mjs";
import { expandHome } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

/**
 * Locate an installed agent-profiles CLI entrypoint when available.
 */
export function findAgentProfilesCli(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;

  const explicit = (options.agentProfilesCli ?? env.AGENT_PROFILES_BIN ?? "").trim();
  if (explicit) {
    const resolved = expandHome(explicit, homeDir);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  const candidates = [
    path.resolve(pluginRoot, "..", "agent-profiles", "bin", "agent-profiles.mjs"),
    path.join(homeDir, ".gemini", "config", "plugins", "tamntlib-agent-profiles", "bin", "agent-profiles.mjs"),
    path.join(homeDir, ".gemini", "config", "plugins", "agent-profiles", "bin", "agent-profiles.mjs"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve active profile for Hindsight.
 *
 * - When `agent-profiles` is installed, delegates strictly to `agent-profiles resolve --json`
 *   and fails closed if `agent-profiles` reports an invalid/unresolved profile.
 * - Otherwise uses `AGENT_PROFILE` env var -> `"default"` (standalone mode).
 */
export function resolveHindsightProfile(payload = {}, options = {}) {
  const env = options.env ?? process.env;
  const explicitProfile = (options.explicitProfile || "").trim().toLowerCase();
  if (explicitProfile) {
    if (!PROFILE_NAME_RE.test(explicitProfile)) {
      return {
        profile: null,
        valid: false,
        managedByAgentProfiles: false,
        source: "cli",
        error: `Invalid profile name "${explicitProfile}".`,
      };
    }
    return {
      profile: explicitProfile,
      valid: true,
      managedByAgentProfiles: false,
      source: "cli",
      error: null,
    };
  }

  const disableDelegation = Boolean(options.disableAgentProfiles);
  const cliPath = disableDelegation ? null : findAgentProfilesCli(options);

  if (cliPath) {
    const args = [cliPath, "resolve", "--json"];
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (cwd) {
      args.push("--cwd", cwd);
    }
    if (Array.isArray(payload.workspacePaths)) {
      for (const ws of payload.workspacePaths) {
        if (typeof ws === "string" && ws.trim()) {
          args.push("--workspace", ws.trim());
        }
      }
    }

    const proc = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env,
      timeout: options.timeoutMs ?? 3000,
      windowsHide: true,
    });

    const raw = (proc.stdout || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.valid) {
          return {
            profile: null,
            valid: false,
            managedByAgentProfiles: true,
            source: parsed.source || "agent-profiles",
            error: parsed.error || "Profile unresolved by agent-profiles.",
          };
        }
        const resolved = String(parsed.profile || "").trim().toLowerCase();
        if (PROFILE_NAME_RE.test(resolved)) {
          return {
            profile: resolved,
            valid: true,
            managedByAgentProfiles: true,
            source: `agent-profiles:${parsed.source || "resolved"}`,
            error: null,
          };
        }
      } catch {
        // Handled fail-closed below.
      }
    }

    const detail = (proc.error?.message || proc.stderr || "").trim();
    return {
      profile: null,
      valid: false,
      managedByAgentProfiles: true,
      source: "agent-profiles:error",
      error: detail
        ? `agent-profiles failed (fail-closed): ${detail.slice(0, 200)}`
        : "agent-profiles returned an unreadable profile response (fail-closed).",
    };
  }

  const fromEnv = (env.AGENT_PROFILE || "").trim().toLowerCase();
  if (fromEnv) {
    if (!PROFILE_NAME_RE.test(fromEnv)) {
      return {
        profile: null,
        valid: false,
        managedByAgentProfiles: false,
        source: "env:AGENT_PROFILE",
        error: `Invalid AGENT_PROFILE value "${fromEnv}".`,
      };
    }
    return {
      profile: fromEnv,
      valid: true,
      managedByAgentProfiles: false,
      source: "env:AGENT_PROFILE",
      error: null,
    };
  }

  return {
    profile: "default",
    valid: true,
    managedByAgentProfiles: false,
    source: "default",
    error: null,
  };
}
