---
name: agent-hindsight
description: Manage profile-isolated Hindsight memory bridge for agents
license: Apache-2.0
author: tamntlib
---

# Agent Hindsight

Cross-platform, zero-dependency Hindsight memory bridge (auto-recall, background auto-retain, MCP proxy, and CLI) for Antigravity, Claude Code, and Codex.

## When to Use

- The user wants to initialize or inspect Hindsight configuration for a profile (`default`, `personal`, `work`, etc.).
- The user wants to diagnose Hindsight API connectivity, tags, bank ID, or profile isolation (`doctor` / `status`).
- The user wants to manually query (`recall`), synthesize (`reflect`), or store (`retain`) a memory via CLI when MCP tools are unavailable.

## Locate the CLI

```bash
node "<skill_dir>/../../bin/agent-hindsight.mjs" --help
```

## Configuration Layout

Config lives outside the plugin repository:
- Linux / macOS: `~/.config/agent-hindsight/<profile>/config.json` and optional `0600` `.env`
- Windows: `%APPDATA%\agent-hindsight\<profile>\config.json` (or `%USERPROFILE%\.config\agent-hindsight\`)
- Override root with `AGENT_HINDSIGHT_HOME`.
- Optional `"extends": "<path>"` inside `config.json` inherits from another JSON config file (supporting `~/` and relative paths, with alias-aware overrides and fail-closed validation on missing/cyclic targets).

Keep `HINDSIGHT_API_KEY` in a private `0600` `.env` file or process environment — never commit tokens inside `config.json` or plugin manifests.

## Profile Isolation

- If `tamntlib-agent-profiles` (`agent-profiles`) is installed, `agent-hindsight` delegates profile resolution to it and fails closed if the profile is unresolved.
- Otherwise, `agent-hindsight` resolves `AGENT_PROFILE` from the environment and defaults to `default`.
- For shared `"default"` banks, default tags enforce strict separation: `recallTags: ["profile:<active>"]`, `recallTagsMatch: "any_strict"`, `reflectTags: ["profile:<active>"]`, `reflectTagsMatch: "any_strict"`, `retainTags: ["profile:<active>"]`, `observationScopes: [["profile:<active>"]]`.
- For dedicated per-profile/project banks (`bankIdTemplate` set or `bankId !== "default"`), `agent-hindsight` matches Hermes Hindsight `1.2.4` defaults (`recallTags: []`, `reflectTags: []`, `retainTags: []`, `observationScopes: "shared"`, `recallMaxInputChars: 800`, `memoryMode: "hybrid"`), supports `.hindsight/config.toml` discovery under `trustedProjectDirs`, multi-bank write/recall (`mirrorToOwnBank`, `additionalBanks`, `recallAdditionalBanks`), `reflect` prefetch, `retainEveryNTurns`, extra-bank cooldowns, and transient retain retries.

## Common Commands

```bash
# Create starter config for default or a named profile
node "<skill_dir>/../../bin/agent-hindsight.mjs" init --profile default --url http://127.0.0.1:8888 --bank default

# Inspect active profile, bank, tags, and URL (never prints API key)
node "<skill_dir>/../../bin/agent-hindsight.mjs" status --cwd "." --json

# Check config, profile resolution, and API health
node "<skill_dir>/../../bin/agent-hindsight.mjs" doctor --cwd "."

# Manual recall, reflect, or retain
node "<skill_dir>/../../bin/agent-hindsight.mjs" recall "deployment architecture"
node "<skill_dir>/../../bin/agent-hindsight.mjs" reflect "summarize deployment decisions"
node "<skill_dir>/../../bin/agent-hindsight.mjs" retain "Key decision: ..."
```
