# agent-profiles

Cross-platform, **zero-dependency** Node.js plugin and CLI that brings deterministic multi-profile isolation (`default`, `work`, custom client profiles, etc.) to **Antigravity**, **Claude Code**, and **Codex**.

- **Standalone**: no dependency on Hindsight, Hermes, or any specific memory/skill provider.
- **Cross-platform**: works on **Windows**, **macOS**, **Linux**, and **WSL** with Node.js >= 18 and `0` npm dependencies.
- **Single source of truth**: one `config.json` drives `SessionStart` hooks, `CLAUDE_ENV_FILE` injection, rules, skills, shell exports, and CLI wrappers.
- **Fail-closed**: unknown profiles, broken JSON, duplicate path rules, and mixed-profile multi-root workspaces never silently fall back to another profile.

## How Resolution Works

At session start or CLI invocation, the active profile resolves in strict precedence order:

1. **CLI flag**: `--profile <name>`
2. **Environment variables**: `envVars` in order (default `["AGENT_PROFILE"]`)
3. **Marker file**: walks upward from `cwd` / `workspacePaths` looking for `markerFiles` (default `[".agent-profile"]`)
4. **Directory prefix rules**: longest-prefix match across `profiles.<name>.paths` (symlink-aware, boundary-safe, case-insensitive on Windows)
5. **Default profile**: `defaultProfile` (default `"default"`)

## Installation

### Prerequisites

- **Node.js >= 18** on `PATH` (`node --version`).

### Antigravity

Install as a plugin (or register this directory in `~/.gemini/config/plugins.json`):

```bash
agy plugin install /path/to/agent-profiles
```

Antigravity automatically loads:
- `plugin.json`
- `hooks.json` (`SessionStart` -> `node scripts/hook.mjs agy session-start`)
- `rules/AGENTS.md`
- `skills/agent-profiles/SKILL.md`

### Claude Code

Install from marketplace:

```bash
/plugin install tamntlib-agent-profiles --marketplace tamntlib/agent-plugins
```

Or test locally with `--plugin-dir`:

```bash
claude --plugin-dir /path/to/agent-profiles
```

Claude Code automatically loads:
- `.claude-plugin/plugin.json`
- `hooks/claude-hooks.json` (`SessionStart` -> injects `additionalContext` and exports profile `env` into `CLAUDE_ENV_FILE` so every Bash call receives the active profile variables)
- `skills/agent-profiles/SKILL.md`

### Codex

Codex loads:
- `.codex-plugin/plugin.json`
- `hooks/codex-hooks.json` (`SessionStart` -> injects `hookSpecificOutput.additionalContext`)
- `skills/agent-profiles/SKILL.md`

### Optional CLI Usage (No Global Install Needed)

```bash
node /path/to/agent-profiles/bin/agent-profiles.mjs init
node /path/to/agent-profiles/bin/agent-profiles.mjs resolve
node /path/to/agent-profiles/bin/agent-profiles.mjs doctor
```

Or link globally if desired:

```bash
npm link
agent-profiles doctor
```

## Configuration

Run `agent-profiles init` to create the starter config:

- **Linux / macOS**: `~/.config/agent-profiles/config.json` (respects `XDG_CONFIG_HOME`)
- **Windows**: `%APPDATA%\agent-profiles\config.json` (or `%USERPROFILE%\.config\agent-profiles\config.json` if it already exists)
- **Override**: `AGENT_PROFILES_CONFIG` (file path) or `AGENT_PROFILES_HOME` (directory)

Example `config.json`:

```json
{
  "version": 1,
  "defaultProfile": "default",
  "envVars": ["AGENT_PROFILE"],
  "markerFiles": [".agent-profile"],
  "maxContextFileChars": 8000,
  "strictUnknownProfile": true,
  "profiles": {
    "default": {
      "description": "Default profile for workspaces outside explicit profile paths",
      "paths": [],
      "env": {
        "AGENT_PROFILE": "default"
      },
      "contextFiles": [],
      "instructions": ""
    },
    "work": {
      "description": "Work repositories and corporate accounts",
      "paths": ["~/work"],
      "env": {
        "AGENT_PROFILE": "work",
        "AWS_PROFILE": "work"
      },
      "contextFiles": [
        "~/.config/agent-profiles/profiles/work/CONTEXT.md"
      ],
      "instructions": "Follow company security and review policies."
    }
  }
}
```

> **Security**: Never store tokens, API keys, cookies, or passwords in `config.json`. Keep credentials in per-profile `.env` files (`0600`) or your OS keychain, and store only non-secret routing metadata here.

## CLI Reference

| Command | Purpose |
|---|---|
| `init [--force]` | Create starter `config.json` (`0700` dir / `0600` file on POSIX) |
| `resolve [--cwd DIR] [--workspace DIR] [--profile NAME] [--json]` | Resolve active profile and explain why |
| `list [--json]` | List all configured profiles |
| `show [NAME] [--json]` | Show details for a profile (defaults to active) |
| `add <NAME> [--path DIR] [--env K=V] [--context-file FILE] [--description TEXT] [--instructions TEXT] [--default]` | Add or update a profile |
| `remove <NAME>` | Remove a non-default profile |
| `set-default <NAME>` | Change `defaultProfile` |
| `mark <NAME> [--dir DIR]` | Write `.agent-profile` in a directory |
| `unmark [--dir DIR]` | Remove `.agent-profile` from a directory |
| `env [--shell sh\|fish\|powershell\|cmd]` | Output shell export statements |
| `exec [--profile NAME] -- <cmd> [args...]` | Execute a command with profile `env` applied |
| `doctor [--cwd DIR] [--json]` | Validate config, paths, context files, and markers |

## Integrating Other Plugins or Skills

Other plugins (memory bridges, skill packs, custom scripts) can stay decoupled by querying `agent-profiles`:

- **Via CLI**: `node <agent-profiles>/bin/agent-profiles.mjs resolve --cwd "$PWD" --json`
- **Via Node ESM import**: `import { resolveProfile } from "<agent-profiles>/src/resolver.mjs"`
- **Via environment**: read `AGENT_PROFILE` (automatically populated in Claude Code Bash calls via `CLAUDE_ENV_FILE`, or via `agent-profiles exec` / `eval "$(agent-profiles env)"`).

## Development & Tests

```bash
npm test
```

## License

Apache-2.0
