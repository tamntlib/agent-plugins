import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENV_KEY_RE,
  createDefaultConfig,
  isSuspiciousSecretEnvKey,
  isValidProfileName,
  loadConfigState,
  writeConfigAtomic,
} from "./config.mjs";
import { escapePosixSingleQuote } from "./hooks.mjs";
import { comparablePath, normalizePath, walkAncestors } from "./paths.mjs";
import { resolveProfile } from "./resolver.mjs";

const VERSION = "1.0.0";

function helpText() {
  return `agent-profiles v${VERSION} — Cross-platform, standalone profile manager for AI coding agents

Usage:
  agent-profiles <command> [options]

Commands:
  init [--force]                        Create starter config.json
  resolve [--cwd DIR] [--workspace DIR] [--profile NAME] [--json]
                                        Resolve active profile and show source
  list [--json]                         List all configured profiles
  show [NAME] [--cwd DIR] [--json]      Show details for one profile
  add <NAME> [options]                  Add or update a profile in config.json
    --description TEXT                  Human-readable profile description
    --path DIR                          Directory prefix (repeatable)
    --env KEY=VALUE                     Non-secret profile env var (repeatable)
    --context-file FILE                 Markdown/text context file (repeatable)
    --instructions TEXT                 Inline session instructions
    --default                           Set as defaultProfile
  remove <NAME>                         Remove a profile from config.json
  set-default <NAME>                    Set defaultProfile
  mark <NAME> [--dir DIR] [--force]     Write .agent-profile marker in a directory
  unmark [--dir DIR]                    Remove .agent-profile marker from a directory
  env [--cwd DIR] [--profile NAME] [--shell sh|fish|powershell|cmd]
                                        Print shell export commands for active profile
  exec [--cwd DIR] [--profile NAME] -- <CMD> [ARGS...]
                                        Run a command with active profile env vars
  doctor [--cwd DIR] [--json]           Validate config, paths, context files, and markers

Global options:
  --config PATH                         Override config.json path
  -h, --help                            Show help
  -v, --version                         Show version
`;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    path: [],
    env: [],
    contextFile: [],
    workspace: [],
  };
  let passthrough = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg === "-v" || arg === "--version") {
      flags.version = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--default") {
      flags.default = true;
    } else if (arg === "--config" && i + 1 < argv.length) {
      flags.config = argv[++i];
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      flags.cwd = argv[++i];
    } else if (arg === "--dir" && i + 1 < argv.length) {
      flags.dir = argv[++i];
    } else if (arg === "--profile" && i + 1 < argv.length) {
      flags.profile = argv[++i];
    } else if (arg === "--shell" && i + 1 < argv.length) {
      flags.shell = argv[++i];
    } else if (arg === "--description" && i + 1 < argv.length) {
      flags.description = argv[++i];
    } else if (arg === "--instructions" && i + 1 < argv.length) {
      flags.instructions = argv[++i];
    } else if (arg === "--path" && i + 1 < argv.length) {
      flags.path.push(argv[++i]);
    } else if (arg === "--env" && i + 1 < argv.length) {
      flags.env.push(argv[++i]);
    } else if (arg === "--context-file" && i + 1 < argv.length) {
      flags.contextFile.push(argv[++i]);
    } else if (arg === "--workspace" && i + 1 < argv.length) {
      flags.workspace.push(argv[++i]);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown or incomplete option: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags, passthrough };
}

function detectShell(explicitShell, env = process.env, platform = process.platform) {
  if (explicitShell) {
    const s = explicitShell.toLowerCase();
    if (["sh", "bash", "zsh"].includes(s)) return "sh";
    if (s === "fish") return "fish";
    if (["powershell", "pwsh", "ps1"].includes(s)) return "powershell";
    if (["cmd", "batch", "bat"].includes(s)) return "cmd";
    return null;
  }
  if (platform === "win32") {
    return env.PSModulePath ? "powershell" : "cmd";
  }
  const shellPath = (env.SHELL || "").toLowerCase();
  if (shellPath.endsWith("fish")) {
    return "fish";
  }
  return "sh";
}

export function formatShellEnv(envMap, shell) {
  const lines = [];
  for (const [key, value] of Object.entries(envMap || {})) {
    if (!ENV_KEY_RE.test(key)) {
      continue;
    }
    const str = String(value);
    if (str.includes("\0") || str.includes("\n") || str.includes("\r")) {
      continue;
    }
    if (shell === "sh") {
      lines.push(`export ${key}=${escapePosixSingleQuote(str)}`);
    } else if (shell === "fish") {
      const escaped = str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      lines.push(`set -gx ${key} '${escaped}'`);
    } else if (shell === "powershell") {
      const escaped = str.replace(/'/g, "''");
      lines.push(`$env:${key} = '${escaped}'`);
    } else if (shell === "cmd") {
      const escaped = str.replace(/%/g, "%%").replace(/"/g, '""');
      lines.push(`set "${key}=${escaped}"`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function loadEditableConfig(configPath, env) {
  const state = loadConfigState({ configPath, env });
  if (state.error) {
    throw new Error(state.error);
  }
  const config = structuredClone(state.config);
  return { state, config };
}

function runDoctor(flags, env) {
  const cwd = flags.cwd || process.cwd();
  const state = loadConfigState({ configPath: flags.config, env });
  const issues = [];
  const warnings = [...(state.warnings || [])];
  const info = {
    nodeVersion: process.version,
    platform: process.platform,
    configPath: state.configPath,
    configExists: state.exists,
    configLoaded: state.loaded,
    cwd: normalizePath(cwd),
  };

  if (state.error) {
    issues.push(state.error);
  } else {
    const config = state.config;
    if (!state.exists) {
      warnings.push(`Config file does not exist yet at ${state.configPath}; using built-in defaults.`);
    }

    // Check duplicate normalized path rules across profiles
    const ruleOwners = new Map();
    for (const [name, def] of Object.entries(config.profiles)) {
      for (const rawPath of def.paths || []) {
        const norm = normalizePath(rawPath);
        const key = comparablePath(norm);
        if (!ruleOwners.has(key)) {
          ruleOwners.set(key, []);
        }
        ruleOwners.get(key).push({ name, rawPath });
        if (!fs.existsSync(norm)) {
          warnings.push(`Profile "${name}" path does not exist on disk: ${rawPath} (${norm})`);
        }
      }

      for (const rawFile of def.contextFiles || []) {
        const norm = normalizePath(rawFile);
        if (!fs.existsSync(norm)) {
          warnings.push(`Profile "${name}" contextFile missing: ${rawFile} (${norm})`);
        }
      }

      for (const key of Object.keys(def.env || {})) {
        if (isSuspiciousSecretEnvKey(key)) {
          warnings.push(`Profile "${name}" env key "${key}" looks like a secret.`);
        }
      }
    }

    for (const [, owners] of ruleOwners.entries()) {
      const uniqueNames = [...new Set(owners.map((o) => o.name))];
      if (uniqueNames.length > 1) {
        issues.push(
          `Duplicate path rule "${owners[0].rawPath}" shared by multiple profiles: ${uniqueNames.join(", ")}`
        );
      }
    }

    // Check markers along cwd
    const foundMarkers = [];
    for (const dir of walkAncestors(cwd)) {
      for (const markerName of config.markerFiles) {
        const full = path.join(dir, markerName);
        if (fs.existsSync(full)) {
          foundMarkers.push(full);
        }
      }
    }
    info.markers = foundMarkers;

    const resolution = resolveProfile({
      cwd,
      workspacePaths: flags.workspace,
      configState: state,
      env,
    });
    info.activeResolution = {
      profile: resolution.profile,
      valid: resolution.valid,
      source: resolution.source,
      conflict: resolution.conflict,
    };
    if (!resolution.valid) {
      issues.push(resolution.error || "Active profile resolution failed.");
    }
    if (resolution.conflict) {
      warnings.push("Workspace spans multiple profiles; see activeResolution.conflict.");
    }
  }

  return {
    ok: issues.length === 0,
    info,
    issues,
    warnings: [...new Set(warnings)],
  };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;

  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr(`Error: ${parsed.error}\n`);
    return 2;
  }

  const { positionals, flags, passthrough } = parsed;
  if (flags.version) {
    stdout(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || positionals.length === 0) {
    stdout(helpText());
    return 0;
  }

  const [cmd, ...rest] = positionals;

  try {
    if (cmd === "init") {
      const state = loadConfigState({ configPath: flags.config, env });
      if (state.exists && !flags.force) {
        stderr(
          `Config already exists at ${state.configPath}. Pass --force to overwrite.\n`
        );
        return 1;
      }
      const starter = createDefaultConfig();
      writeConfigAtomic(state.configPath, starter);
      if (flags.json) {
        stdout(`${JSON.stringify({ initialized: true, configPath: state.configPath, config: starter }, null, 2)}\n`);
      } else {
        stdout(`Initialized agent-profiles config at ${state.configPath}\n`);
      }
      return 0;
    }

    if (cmd === "resolve") {
      const resolution = resolveProfile({
        cwd: flags.cwd || process.cwd(),
        workspacePaths: flags.workspace,
        explicitProfile: flags.profile,
        configPath: flags.config,
        env,
      });
      if (flags.json) {
        stdout(`${JSON.stringify(resolution, null, 2)}\n`);
      } else if (!resolution.valid) {
        stderr(`Error: ${resolution.error}\n`);
      } else {
        stdout(`profile: ${resolution.profile}\n`);
        stdout(`source:  ${resolution.source}\n`);
        stdout(`config:  ${resolution.configPath}${resolution.configLoaded ? "" : " (built-in defaults)"}\n`);
        if (resolution.warnings.length > 0) {
          for (const w of resolution.warnings) {
            stdout(`warning: ${w}\n`);
          }
        }
      }
      return resolution.valid ? 0 : 1;
    }

    if (cmd === "list") {
      const state = loadConfigState({ configPath: flags.config, env });
      if (state.error) {
        stderr(`Error: ${state.error}\n`);
        return 1;
      }
      const config = state.config;
      if (flags.json) {
        stdout(
          `${JSON.stringify(
            {
              configPath: state.configPath,
              configLoaded: state.loaded,
              defaultProfile: config.defaultProfile,
              profiles: config.profiles,
            },
            null,
            2
          )}\n`
        );
      } else {
        for (const [name, def] of Object.entries(config.profiles)) {
          const marker = name === config.defaultProfile ? " (default)" : "";
          const pathsText = def.paths.length ? ` paths=[${def.paths.join(", ")}]` : "";
          stdout(`${name}${marker}${pathsText}${def.description ? ` — ${def.description}` : ""}\n`);
        }
      }
      return 0;
    }

    if (cmd === "show") {
      const state = loadConfigState({ configPath: flags.config, env });
      if (state.error) {
        stderr(`Error: ${state.error}\n`);
        return 1;
      }
      let targetName = rest[0]?.trim().toLowerCase();
      if (!targetName) {
        const res = resolveProfile({
          cwd: flags.cwd || process.cwd(),
          workspacePaths: flags.workspace,
          configState: state,
          env,
        });
        if (!res.valid) {
          stderr(`Error: ${res.error}\n`);
          return 1;
        }
        targetName = res.profile;
      }
      const def = state.config.profiles[targetName];
      if (!def) {
        stderr(`Error: Profile "${targetName}" not found.\n`);
        return 1;
      }
      if (flags.json) {
        stdout(
          `${JSON.stringify(
            {
              name: targetName,
              isDefault: targetName === state.config.defaultProfile,
              ...def,
            },
            null,
            2
          )}\n`
        );
      } else {
        stdout(`name:         ${targetName}${targetName === state.config.defaultProfile ? " (default)" : ""}\n`);
        stdout(`description:  ${def.description || "(none)"}\n`);
        stdout(`paths:        ${def.paths.length ? def.paths.join(", ") : "(none)"}\n`);
        stdout(
          `env:          ${
            Object.keys(def.env).length
              ? Object.entries(def.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")
              : "(none)"
          }\n`
        );
        stdout(`contextFiles: ${def.contextFiles.length ? def.contextFiles.join(", ") : "(none)"}\n`);
        if (def.instructions) {
          stdout(`instructions: ${def.instructions}\n`);
        }
      }
      return 0;
    }

    if (cmd === "add") {
      const name = rest[0]?.trim().toLowerCase();
      if (!name || !isValidProfileName(name)) {
        stderr(
          `Error: Provide a valid profile name (lowercase letters, digits, ".", "_", "-").\n`
        );
        return 2;
      }
      const { state, config } = loadEditableConfig(flags.config, env);
      const existing = config.profiles[name] || {
        description: "",
        paths: [],
        env: { AGENT_PROFILE: name },
        contextFiles: [],
        instructions: "",
      };

      if (flags.description !== undefined) {
        existing.description = flags.description;
      }
      if (flags.instructions !== undefined) {
        existing.instructions = flags.instructions;
      }
      for (const p of flags.path) {
        if (!existing.paths.includes(p)) {
          existing.paths.push(p);
        }
      }
      for (const cf of flags.contextFile) {
        if (!existing.contextFiles.includes(cf)) {
          existing.contextFiles.push(cf);
        }
      }
      for (const item of flags.env) {
        const eq = item.indexOf("=");
        if (eq <= 0) {
          stderr(`Error: Invalid --env entry "${item}". Expected KEY=VALUE.\n`);
          return 2;
        }
        const k = item.slice(0, eq).trim();
        const v = item.slice(eq + 1);
        if (!ENV_KEY_RE.test(k)) {
          stderr(`Error: Invalid environment variable name "${k}".\n`);
          return 2;
        }
        existing.env[k] = v;
      }

      config.profiles[name] = existing;
      if (flags.default) {
        config.defaultProfile = name;
      }
      writeConfigAtomic(state.configPath, config);

      if (flags.json) {
        stdout(`${JSON.stringify({ saved: true, profile: name, configPath: state.configPath }, null, 2)}\n`);
      } else {
        stdout(`Saved profile "${name}" to ${state.configPath}\n`);
      }
      return 0;
    }

    if (cmd === "remove") {
      const name = rest[0]?.trim().toLowerCase();
      if (!name) {
        stderr("Error: Profile name required.\n");
        return 2;
      }
      const { state, config } = loadEditableConfig(flags.config, env);
      if (!config.profiles[name]) {
        stderr(`Error: Profile "${name}" does not exist.\n`);
        return 1;
      }
      if (config.defaultProfile === name) {
        stderr(
          `Error: Cannot remove defaultProfile "${name}". Run \`agent-profiles set-default <other>\` first.\n`
        );
        return 1;
      }
      delete config.profiles[name];
      writeConfigAtomic(state.configPath, config);
      stdout(`Removed profile "${name}" from ${state.configPath}\n`);
      return 0;
    }

    if (cmd === "set-default") {
      const name = rest[0]?.trim().toLowerCase();
      if (!name) {
        stderr("Error: Profile name required.\n");
        return 2;
      }
      const { state, config } = loadEditableConfig(flags.config, env);
      if (!config.profiles[name]) {
        stderr(`Error: Profile "${name}" does not exist.\n`);
        return 1;
      }
      config.defaultProfile = name;
      writeConfigAtomic(state.configPath, config);
      stdout(`Set defaultProfile to "${name}" in ${state.configPath}\n`);
      return 0;
    }

    if (cmd === "mark") {
      const name = rest[0]?.trim().toLowerCase();
      if (!name || !isValidProfileName(name)) {
        stderr("Error: Provide a valid profile name to write into the marker file.\n");
        return 2;
      }
      const state = loadConfigState({ configPath: flags.config, env });
      if (state.error) {
        stderr(`Error: ${state.error}\n`);
        return 1;
      }
      if (!flags.force && !state.config.profiles[name]) {
        stderr(
          `Error: Profile "${name}" is not configured in ${state.configPath}. Pass --force to write anyway.\n`
        );
        return 1;
      }
      const targetDir = normalizePath(flags.dir || flags.cwd || process.cwd());
      const markerName = state.config.markerFiles[0] || ".agent-profile";
      const markerPath = path.join(targetDir, markerName);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(markerPath, `${name}\n`, "utf8");
      stdout(`Wrote "${name}" to ${markerPath}\n`);
      return 0;
    }

    if (cmd === "unmark") {
      const state = loadConfigState({ configPath: flags.config, env });
      const markerNames = state.config?.markerFiles || [".agent-profile"];
      const targetDir = normalizePath(flags.dir || flags.cwd || process.cwd());
      const removed = [];
      for (const m of markerNames) {
        const full = path.join(targetDir, m);
        if (fs.existsSync(full)) {
          fs.rmSync(full);
          removed.push(full);
        }
      }
      if (removed.length === 0) {
        stdout(`No marker file found in ${targetDir}\n`);
      } else {
        stdout(`Removed marker(s): ${removed.join(", ")}\n`);
      }
      return 0;
    }

    if (cmd === "env") {
      const shell = detectShell(flags.shell, env, process.platform);
      if (!shell) {
        stderr(`Error: Unsupported shell "${flags.shell}". Use sh, fish, powershell, or cmd.\n`);
        return 2;
      }
      const resolution = resolveProfile({
        cwd: flags.cwd || process.cwd(),
        workspacePaths: flags.workspace,
        explicitProfile: flags.profile,
        configPath: flags.config,
        env,
      });
      if (!resolution.valid) {
        stderr(`Error: ${resolution.error}\n`);
        return 1;
      }
      stdout(formatShellEnv(resolution.env, shell));
      return 0;
    }

    if (cmd === "exec") {
      const execArgs = passthrough ?? rest;
      if (!execArgs || execArgs.length === 0) {
        stderr("Error: Missing command to execute. Usage: agent-profiles exec -- <cmd> [args...]\n");
        return 2;
      }
      const resolution = resolveProfile({
        cwd: flags.cwd || process.cwd(),
        workspacePaths: flags.workspace,
        explicitProfile: flags.profile,
        configPath: flags.config,
        env,
      });
      if (!resolution.valid) {
        stderr(`Error: ${resolution.error}\n`);
        return 2;
      }
      const [bin, ...binArgs] = execArgs;
      const execOptions = {
        cwd: flags.cwd || process.cwd(),
        env: { ...env, ...resolution.env },
        stdio: "inherit",
        shell: false,
      };
      let child = spawnSync(bin, binArgs, execOptions);
      if (
        process.platform === "win32" &&
        child.error &&
        (child.error.code === "ENOENT" || child.error.code === "EINVAL")
      ) {
        // Fallback for Windows .cmd/.bat shims on PATH without DEP0190 args+shell warning.
        const cmdQuote = (arg) => `"${String(arg).replace(/"/g, '""')}"`;
        const cmdLine = [cmdQuote(bin), ...binArgs.map(cmdQuote)].join(" ");
        child = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine}"`], execOptions);
      }
      if (child.error) {
        stderr(`Error executing "${bin}": ${child.error.message}\n`);
        return 127;
      }
      return child.status ?? 1;
    }

    if (cmd === "doctor") {
      const report = runDoctor(flags, env);
      if (flags.json) {
        stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stdout(`agent-profiles doctor (${report.ok ? "OK" : "ISSUES FOUND"})\n`);
        stdout(`- Node:   ${report.info.nodeVersion} (${report.info.platform})\n`);
        stdout(`- Config: ${report.info.configPath} (${report.info.configLoaded ? "loaded" : report.info.configExists ? "error" : "defaults"})\n`);
        if (report.info.activeResolution) {
          const ar = report.info.activeResolution;
          stdout(`- Active: ${ar.profile || "UNRESOLVED"} via ${ar.source}\n`);
        }
        if (report.warnings.length > 0) {
          stdout("\nWarnings:\n");
          for (const w of report.warnings) {
            stdout(`  - ${w}\n`);
          }
        }
        if (report.issues.length > 0) {
          stdout("\nIssues:\n");
          for (const iss of report.issues) {
            stdout(`  - ${iss}\n`);
          }
        }
      }
      return report.ok ? 0 : 1;
    }

    stderr(`Error: Unknown command "${cmd}". Run \`agent-profiles --help\`.\n`);
    return 2;
  } catch (err) {
    stderr(`Error: ${err.message}\n`);
    return 1;
  }
}
