---
name: agent-profiles
description: Manage multi-profile isolation for AI coding agents
license: Apache-2.0
author: tamntlib
---

# Agent Profiles

Deterministic, cross-platform (Windows, macOS, Linux), zero-dependency profile manager for Antigravity, Claude Code, and Codex.

## When to Use

- The user wants to check which profile (`default`, `work`, custom client profiles, etc.) is active in the current workspace.
- The user wants to initialize, add, edit, remove, or set the default profile.
- The user wants to pin a repository or directory to a specific profile using a `.agent-profile` marker file.
- The user wants to diagnose profile resolution, path rules, missing context files, or multi-root workspace conflicts.
- The user wants to launch a CLI or shell command with a profile's environment variables applied.

## Locate the CLI

Resolve the CLI relative to this skill directory (no global install required):

```bash
# POSIX (Linux / macOS / Git Bash)
node "<skill_dir>/../../bin/agent-profiles.mjs" --help
```

```powershell
# Windows PowerShell
node "<skill_dir>\..\..\bin\agent-profiles.mjs" --help
```

If `agent-profiles` is also installed on `PATH`, you may invoke `agent-profiles` directly.

## Precedence Order

Profiles resolve deterministically from highest to lowest priority:

1. Explicit CLI flag (`--profile <name>`)
2. Configured environment variables (`envVars`, default `["AGENT_PROFILE"]`)
3. Marker file walking upward from `cwd` / `workspacePaths` (`markerFiles`, default `[".agent-profile"]`)
4. Longest-prefix directory match across `profiles.<name>.paths` (symlink-aware, case-insensitive on Windows)
5. `defaultProfile` (default `"default"`)

## Common Operations

### Initialize configuration

```bash
node "<skill_dir>/../../bin/agent-profiles.mjs" init
```

Default config location:
- Linux / macOS: `~/.config/agent-profiles/config.json` (or `$XDG_CONFIG_HOME/agent-profiles/config.json`)
- Windows: `%APPDATA%\agent-profiles\config.json` (or `%USERPROFILE%\.config\agent-profiles\config.json` if already present)
- Override anywhere with `AGENT_PROFILES_CONFIG` or `AGENT_PROFILES_HOME`.

### Inspect active profile or list all profiles

```bash
node "<skill_dir>/../../bin/agent-profiles.mjs" resolve --cwd "." --json
node "<skill_dir>/../../bin/agent-profiles.mjs" list
node "<skill_dir>/../../bin/agent-profiles.mjs" show
```

### Add or update a profile

```bash
node "<skill_dir>/../../bin/agent-profiles.mjs" add client-acme \
  --description "Acme Corp client projects" \
  --path "~/clients/acme" \
  --env "AGENT_PROFILE=client-acme" \
  --env "AWS_PROFILE=acme" \
  --context-file "~/.config/agent-profiles/profiles/client-acme/CONTEXT.md"
```

### Pin a repository with `.agent-profile`

```bash
node "<skill_dir>/../../bin/agent-profiles.mjs" mark work --dir "."
node "<skill_dir>/../../bin/agent-profiles.mjs" unmark --dir "."
```

### Export environment variables or run a command under a profile

```bash
# Inspect shell exports (sh, fish, powershell, cmd)
node "<skill_dir>/../../bin/agent-profiles.mjs" env --cwd "." --shell sh

# Run any command with resolved profile env vars applied
node "<skill_dir>/../../bin/agent-profiles.mjs" exec --cwd "." -- env
```

### Diagnose configuration issues

```bash
node "<skill_dir>/../../bin/agent-profiles.mjs" doctor --cwd "."
```

## Guardrails

- **Never put secrets in `config.json`** (no API keys, tokens, cookies, passwords). Store only non-secret routing metadata (`AGENT_PROFILE`, `AWS_PROFILE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, etc.).
- **Fail closed**: if resolution returns an unknown profile, invalid config, or multi-root workspace conflict, do not silently fall back to another profile.
- **No silent cross-profile fallback**: if credentials for the active profile are missing, report the missing setup for that profile rather than switching profiles.
