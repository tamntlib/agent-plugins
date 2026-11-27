import fs from "node:fs";
import path from "node:path";
import { checkHealth, recallMemories, reflectMemory, retainNote } from "./client.mjs";
import {
  DEFAULT_API_URL,
  DEFAULT_BANK_ID,
  PROFILE_NAME_RE,
  createStarterProfileConfig,
  loadProfileConfig,
  resolveEffectiveBank,
  writeProfileConfigAtomic,
} from "./config.mjs";
import { resolveConfigDir, resolveStateDir } from "./paths.mjs";
import { resolveHindsightProfile } from "./profile.mjs";

const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

function helpText() {
  return `agent-hindsight v${VERSION} — Cross-platform, zero-dep Hindsight memory plugin CLI

Usage:
  agent-hindsight <command> [options]

Commands:
  init [--profile NAME] [--url URL] [--bank ID] [--force]
                                        Create profile config.json under ~/.config/agent-hindsight/<profile>/
  status [--cwd DIR] [--profile NAME] [--json]
                                        Show resolved profile, config path, bank, tags, and URL
  doctor [--cwd DIR] [--profile NAME] [--no-network] [--json]
                                        Validate profile resolution, config files, permissions, and API health
  recall <QUERY> [--cwd DIR] [--profile NAME] [--json]
                                        Query Hindsight memories for the active profile
  reflect <QUERY> [--cwd DIR] [--profile NAME] [--json]
                                        Synthesize cross-memory answer via Hindsight /reflect
  retain <TEXT> [--cwd DIR] [--profile NAME] [--context TEXT]
                                        Retain a note into Hindsight under the active profile

Global options:
  --config-dir DIR                      Override ~/.config/agent-hindsight directory
  -h, --help                            Show help
  -v, --version                         Show version
`;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-v" || arg === "--version") flags.version = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--no-network") flags.noNetwork = true;
    else if (arg === "--profile" && i + 1 < argv.length) flags.profile = argv[++i];
    else if (arg === "--cwd" && i + 1 < argv.length) flags.cwd = argv[++i];
    else if (arg === "--url" && i + 1 < argv.length) flags.url = argv[++i];
    else if (arg === "--bank" && i + 1 < argv.length) flags.bank = argv[++i];
    else if (arg === "--context" && i + 1 < argv.length) flags.context = argv[++i];
    else if (arg === "--config-dir" && i + 1 < argv.length) flags.configDir = argv[++i];
    else if (arg.startsWith("-")) return { error: `Unknown or incomplete option: ${arg}` };
    else positionals.push(arg);
  }
  return { positionals, flags };
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;

  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr(`Error: ${parsed.error}\n`);
    return 2;
  }

  const { positionals, flags } = parsed;
  if (flags.version) {
    stdout(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || positionals.length === 0) {
    stdout(helpText());
    return 0;
  }

  const [cmd, ...rest] = positionals;
  const opts = {
    env,
    configDir: flags.configDir,
    explicitProfile: flags.profile,
    disableAgentProfiles: io.disableAgentProfiles,
    agentProfilesCli: io.agentProfilesCli,
  };

  try {
    if (cmd === "init") {
      const profile = (flags.profile || "default").trim().toLowerCase();
      if (!PROFILE_NAME_RE.test(profile)) {
        stderr(`Error: Invalid profile name "${profile}".\n`);
        return 2;
      }
      const configDir = resolveConfigDir(opts);
      const targetPath = path.join(configDir, profile, "config.json");
      if (fs.existsSync(targetPath) && !flags.force) {
        stderr(`Config already exists at ${targetPath}. Pass --force to overwrite.\n`);
        return 1;
      }
      const starter = createStarterProfileConfig(profile, {
        apiUrl: flags.url || DEFAULT_API_URL,
        bankId: flags.bank || DEFAULT_BANK_ID,
      });
      writeProfileConfigAtomic(configDir, profile, starter);
      if (flags.json) {
        stdout(`${JSON.stringify({ initialized: true, profile, configPath: targetPath, config: starter }, null, 2)}\n`);
      } else {
        stdout(`Initialized Hindsight config for profile "${profile}" at ${targetPath}\n`);
      }
      return 0;
    }

    if (cmd === "status") {
      const targetCwd = flags.cwd || process.cwd();
      const prof = resolveHindsightProfile({ cwd: targetCwd }, opts);
      if (!prof.valid || !prof.profile) {
        stderr(`Error: ${prof.error || "Profile unresolved"}\n`);
        return 1;
      }
      const cfg = loadProfileConfig(prof.profile, opts);
      const bankInfo = resolveEffectiveBank(cfg, { cwd: targetCwd }, opts);
      const summary = {
        profile: prof.profile,
        profileSource: prof.source,
        managedByAgentProfiles: prof.managedByAgentProfiles,
        configPath: cfg.configPath,
        configLoaded: cfg.configLoaded,
        extends: cfg.extendsPaths,
        stateDir: resolveStateDir(opts),
        apiUrl: cfg.apiUrl,
        mcpUrl: bankInfo.mcpUrl,
        bankId: bankInfo.bankId,
        bankSource: bankInfo.bankSource,
        bankIdTemplate: cfg.bankIdTemplate || null,
        project: bankInfo.project || null,
        writeBanks: bankInfo.writeBanks,
        recallAdditionalBanks: bankInfo.additionalBanks,
        recallBanks: bankInfo.recallBanks,
        memoryMode: cfg.memoryMode,
        autoRecall: cfg.autoRecall,
        autoRetain: cfg.autoRetain,
        recallPrefetchMethod: cfg.recallPrefetchMethod,
        budget: cfg.budget,
        maxTokens: cfg.maxTokens,
        recallMaxInputChars: cfg.recallMaxInputChars,
        recallMinScores: cfg.recallMinScores,
        retainAsync: cfg.retainAsync,
        retainEveryNTurns: cfg.retainEveryNTurns,
        retainStrategy: cfg.retainStrategy || null,
        trustedProjectDirs: cfg.trustedProjectDirs,
        apiKeyConfigured: Boolean(cfg.apiKey),
        recallTags: cfg.recallTags,
        recallTagsMatch: cfg.recallTags.length > 0 ? cfg.recallTagsMatch : null,
        reflectTags: cfg.reflectTags,
        retainTags: cfg.retainTags,
        observationScopes: cfg.observationScopes,
        warnings: cfg.warnings,
      };
      if (flags.json) {
        stdout(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        stdout(`profile:    ${summary.profile} (${summary.profileSource})\n`);
        stdout(`config:     ${summary.configPath}${summary.configLoaded ? "" : " (defaults)"}\n`);
        if (summary.extends.length) {
          stdout(`extends:    ${summary.extends.join(" -> ")}\n`);
        }
        stdout(`apiUrl:     ${summary.apiUrl}\n`);
        stdout(`mcpUrl:     ${summary.mcpUrl}\n`);
        stdout(`bankId:     ${summary.bankId} (source: ${summary.bankSource}${summary.bankIdTemplate ? `, template: ${summary.bankIdTemplate}` : ""})\n`);
        if (summary.writeBanks.length > 1) {
          stdout(`writeBanks: ${summary.writeBanks.join(", ")}\n`);
        }
        if (summary.recallAdditionalBanks.length) {
          stdout(`extraBanks: ${summary.recallAdditionalBanks.join(", ")}\n`);
        }
        stdout(`mode:       ${summary.memoryMode} (autoRecall=${summary.autoRecall}, autoRetain=${summary.autoRetain}, method=${summary.recallPrefetchMethod})\n`);
        stdout(`recall:     budget=${summary.budget}, maxTokens=${summary.maxTokens}, maxInputChars=${summary.recallMaxInputChars}${summary.recallMinScores ? `, minScores=${JSON.stringify(summary.recallMinScores)}` : ""}\n`);
        stdout(`apiKey:     ${summary.apiKeyConfigured ? "configured" : "not set"}\n`);
        stdout(
          summary.recallTags.length
            ? `recallTags: ${summary.recallTags.join(", ")} (${summary.recallTagsMatch})\n`
            : `recallTags: (none — bank-isolated, scope=${JSON.stringify(summary.observationScopes)})\n`
        );
      }
      return 0;
    }

    if (cmd === "doctor") {
      const issues = [];
      const warnings = [];
      const targetCwd = flags.cwd || process.cwd();
      const prof = resolveHindsightProfile({ cwd: targetCwd }, opts);
      if (!prof.valid || !prof.profile) {
        issues.push(prof.error || "Failed to resolve profile.");
      }
      let cfg = null;
      let bankInfo = null;
      let health = { checked: false, ok: null, error: null };
      if (prof.valid && prof.profile) {
        cfg = loadProfileConfig(prof.profile, opts);
        bankInfo = resolveEffectiveBank(cfg, { cwd: targetCwd }, opts);
        warnings.push(...cfg.warnings);
        if (cfg.configError) {
          issues.push(cfg.configError);
        }
        if (!flags.noNetwork) {
          health.checked = true;
          try {
            const doHealth = io.healthFn ?? checkHealth;
            await doHealth(cfg);
            health.ok = true;
          } catch (err) {
            health.ok = false;
            health.error = err.message;
            warnings.push(`Hindsight API health check failed at ${cfg.apiUrl}: ${err.message}`);
          }
        }
      }

      const report = {
        ok: issues.length === 0,
        nodeVersion: process.version,
        platform: process.platform,
        profile: prof,
        config: cfg
          ? {
              configPath: cfg.configPath,
              extendsPaths: cfg.extendsPaths,
              configLoaded: cfg.configLoaded,
              apiUrl: cfg.apiUrl,
              bankId: bankInfo.bankId,
              bankIdTemplate: cfg.bankIdTemplate || null,
              recallBanks: bankInfo.recallBanks,
              budget: cfg.budget,
              maxTokens: cfg.maxTokens,
              recallMinScores: cfg.recallMinScores,
              apiKeyConfigured: Boolean(cfg.apiKey),
              recallTags: cfg.recallTags,
            }
          : null,
        health,
        issues,
        warnings,
      };
      if (flags.json) {
        stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stdout(`agent-hindsight doctor (${report.ok ? "OK" : "ISSUES FOUND"})\n`);
        stdout(`- Node:    ${report.nodeVersion} (${report.platform})\n`);
        stdout(`- Profile: ${prof.profile || "UNRESOLVED"} (${prof.source})\n`);
        if (cfg) {
          const extNote = cfg.extendsPaths.length ? `, extends ${cfg.extendsPaths.join(" -> ")}` : "";
          stdout(`- Config:  ${cfg.configPath} (${cfg.configLoaded ? "loaded" : "defaults"}${extNote})\n`);
          stdout(`- API:     ${cfg.apiUrl} | bank=${bankInfo.bankId}${bankInfo.additionalBanks.length ? ` (+${bankInfo.additionalBanks.join(",")})` : ""} | key=${cfg.apiKey ? "set" : "unset"}\n`);
          stdout(`- Recall:  budget=${cfg.budget} | maxTokens=${cfg.maxTokens}${cfg.recallMinScores ? ` | minScores=${JSON.stringify(cfg.recallMinScores)}` : ""}\n`);
        }
        if (health.checked) {
          stdout(`- Health:  ${health.ok ? "reachable" : `unreachable (${health.error})`}\n`);
        }
        if (warnings.length) {
          stdout("\nWarnings:\n");
          for (const w of warnings) stdout(`  - ${w}\n`);
        }
        if (issues.length) {
          stdout("\nIssues:\n");
          for (const iss of issues) stdout(`  - ${iss}\n`);
        }
      }
      return report.ok ? 0 : 1;
    }

    if (cmd === "recall") {
      const query = rest.join(" ").trim();
      if (!query) {
        stderr("Error: Query string required.\n");
        return 2;
      }
      const targetCwd = flags.cwd || process.cwd();
      const prof = resolveHindsightProfile({ cwd: targetCwd }, opts);
      if (!prof.valid || !prof.profile) {
        stderr(`Error: ${prof.error || "Profile unresolved"}\n`);
        return 1;
      }
      const cfg = loadProfileConfig(prof.profile, opts);
      const bankInfo = resolveEffectiveBank(cfg, { cwd: targetCwd }, opts);
      const doRecall = io.recallFn ?? recallMemories;
      const resp = await doRecall(cfg, query, {
        bankId: bankInfo.bankId,
        recallBanks: bankInfo.recallBanks,
        stateDir: resolveStateDir(opts),
      });
      if (flags.json) {
        stdout(`${JSON.stringify(resp, null, 2)}\n`);
      } else {
        const results = Array.isArray(resp?.results) ? resp.results : [];
        if (results.length === 0) {
          stdout("(no memories found)\n");
        } else {
          for (const r of results) {
            if (r?.text) stdout(`- ${r.text.trim()}\n`);
          }
        }
      }
      return 0;
    }

    if (cmd === "reflect") {
      const query = rest.join(" ").trim();
      if (!query) {
        stderr("Error: Query string required.\n");
        return 2;
      }
      const targetCwd = flags.cwd || process.cwd();
      const prof = resolveHindsightProfile({ cwd: targetCwd }, opts);
      if (!prof.valid || !prof.profile) {
        stderr(`Error: ${prof.error || "Profile unresolved"}\n`);
        return 1;
      }
      const cfg = loadProfileConfig(prof.profile, opts);
      const bankInfo = resolveEffectiveBank(cfg, { cwd: targetCwd }, opts);
      const doReflect = io.reflectFn ?? reflectMemory;
      const resp = await doReflect(cfg, query, { bankId: bankInfo.bankId });
      if (flags.json) {
        stdout(`${JSON.stringify(resp, null, 2)}\n`);
      } else {
        stdout(resp?.text ? `${resp.text.trim()}\n` : "(no synthesis returned)\n");
      }
      return 0;
    }

    if (cmd === "retain") {
      const note = rest.join(" ").trim();
      if (!note) {
        stderr("Error: Text to retain is required.\n");
        return 2;
      }
      const targetCwd = flags.cwd || process.cwd();
      const prof = resolveHindsightProfile({ cwd: targetCwd }, opts);
      if (!prof.valid || !prof.profile) {
        stderr(`Error: ${prof.error || "Profile unresolved"}\n`);
        return 1;
      }
      const cfg = loadProfileConfig(prof.profile, opts);
      const bankInfo = resolveEffectiveBank(cfg, { cwd: targetCwd }, opts);
      const doRetain = io.retainNoteFn ?? retainNote;
      const resp = await doRetain(cfg, note, flags.context || cfg.retainContext || "manual retain", {
        bankId: bankInfo.bankId,
        writeBanks: bankInfo.writeBanks,
        stateDir: resolveStateDir(opts),
      });
      if (flags.json) {
        stdout(`${JSON.stringify(resp, null, 2)}\n`);
      } else {
        const tagNote = cfg.retainTags.length
          ? `(tags: ${cfg.retainTags.join(", ")})`
          : "(bank-isolated)";
        const extraNote = bankInfo.extraWriteBanks.length
          ? ` (+${bankInfo.extraWriteBanks.join(", ")})`
          : "";
        stdout(
          `Retained memory into bank "${bankInfo.bankId}"${extraNote} under profile "${prof.profile}" ${tagNote}\n`
        );
      }
      return 0;
    }

    stderr(`Error: Unknown command "${cmd}". Run \`agent-hindsight --help\`.\n`);
    return 2;
  } catch (err) {
    stderr(`Error: ${err.message}\n`);
    return 1;
  }
}
