# tamntlib/agent-plugins

A public multi-plugin marketplace monorepo for **Antigravity**, **Claude Code**, **Codex**, and **Hermes**. Every plugin under `plugins/` is independently installable and loosely coupled through a single convention (`AGENT_PROFILE`, defaulting to `default`).

## Plugins

| Plugin Name | Directory | Purpose | Target Agents |
|---|---|---|---|
| `tamntlib-agent-profiles` | `plugins/agent-profiles/` | Cross-platform, zero-dep multi-profile isolation (`SessionStart` hooks, `CLAUDE_ENV_FILE`, rules, skill, CLI) | Antigravity, Claude Code, Codex |
| `tamntlib-agent-hindsight` | `plugins/agent-hindsight/` | Cross-platform, zero-dep Hindsight memory bridge (auto-recall, background auto-retain, MCP proxy, CLI) | Antigravity, Claude Code, Codex |
| `tamntlib-skills` | `plugins/skills/` | 18 reusable cross-agent engineering workflows and profile-isolated integration skills | Antigravity, Claude Code, Codex, Hermes |
| `tamntlib-hermes-builtin-skills` | `plugins/hermes-builtin-skills/` | Curated built-in skills synced from `NousResearch/hermes-agent` (MIT) for non-Hermes agents | Antigravity, Claude Code, Codex |
| `tamntlib-skills-hermes` | `plugins/skills-hermes/` | Public Hermes-oriented portability and adaptation skills | Hermes |

## Installation

### Claude Code

Add the marketplace once, then install only the plugins you need:

```bash
/plugin install tamntlib-agent-profiles --marketplace tamntlib/agent-plugins
/plugin install tamntlib-agent-hindsight --marketplace tamntlib/agent-plugins
/plugin install tamntlib-skills --marketplace tamntlib/agent-plugins
/plugin install tamntlib-hermes-builtin-skills --marketplace tamntlib/agent-plugins
```

### Antigravity

Install individual plugins by subfolder URL or local symlink under `~/.gemini/config/plugins/<plugin-name>`:

```bash
agy plugin install https://github.com/tamntlib/agent-plugins/tree/main/plugins/agent-profiles
agy plugin install https://github.com/tamntlib/agent-plugins/tree/main/plugins/agent-hindsight
agy plugin install https://github.com/tamntlib/agent-plugins/tree/main/plugins/skills
agy plugin install https://github.com/tamntlib/agent-plugins/tree/main/plugins/hermes-builtin-skills
```

### Codex

Use `.agents/plugins/marketplace.json` to install `tamntlib-agent-profiles`, `tamntlib-agent-hindsight`, `tamntlib-skills`, or `tamntlib-hermes-builtin-skills`.

### Hermes

To avoid loading non-Hermes plugin skills (or duplicating Hermes built-in skills), link or reference only `plugins/skills/skills` and `plugins/skills-hermes/skills` — do **not** link `plugins/hermes-builtin-skills/` or clone the whole monorepo inside `~/.hermes/skills/`.

## Profile & Configuration Convention

- Single environment variable: `AGENT_PROFILE` (defaults to `default` when unset).
- Skill integration credentials live under `~/.config/tamntlib-skills/{profile}/{skill}/` (`0700` dirs, `0600` files).
- `tamntlib-agent-profiles` config lives under `~/.config/agent-profiles/config.json` (Windows: `%APPDATA%\agent-profiles\config.json`).
- `tamntlib-agent-hindsight` config lives under `~/.config/agent-hindsight/{profile}/` (Windows: `%APPDATA%\agent-hindsight\{profile}\`).

## License

Apache-2.0 — see `LICENSE` and `NOTICE.md`.
