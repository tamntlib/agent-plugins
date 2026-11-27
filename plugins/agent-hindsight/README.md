# tamntlib-agent-hindsight

Cross-platform, **zero-dependency** Node.js plugin that connects **Antigravity**, **Claude Code**, and **Codex** to a [Hindsight](https://github.com/vectorize-io/hindsight) memory server with strict per-profile isolation.

- **Zero dependencies**: Node.js >= 18 built-in `fetch`, atomic JSON conversation state (no SQLite native bindings), works on Windows, macOS, Linux, and WSL.
- **Profile-isolated**: automatically integrates with `tamntlib-agent-profiles` when installed (fail-closed on conflicts/errors), or works standalone via `AGENT_PROFILE` (default `default`).
- **Auto-recall & background auto-retain**: injects relevant memories before each turn and asynchronously retains completed turns on `Stop` without blocking the agent loop.
- **Secret-safe MCP proxy**: bundles a stdio-to-Streamable-HTTP MCP proxy (`scripts/mcp.mjs`) that reads your local `config.json` and `0600` `.env` at runtime — zero credentials in plugin manifests.

## Configuration

Run `init` for each profile you want to customize:

```bash
node bin/agent-hindsight.mjs init --profile default --url http://127.0.0.1:8888 --bank default
```

Files live under `~/.config/agent-hindsight/<profile>/` (or `%APPDATA%\agent-hindsight\<profile>\` on Windows):

- `config.json` (`0600`): non-secret settings supporting both `camelCase` and Hermes `snake_case` keys (`extends`, `apiUrl`, `bankId`, `bankIdTemplate`, `trustedProjectDirs`, `mirrorToOwnBank`, `additionalBanks`, `recallAdditionalBanks`, `memoryMode`, `autoRecall`, `autoRetain`, `budget`, `maxTokens`, `recallMaxInputChars`, `recallPromptPreamble`, `recallPrefetchMethod`, `reflectTags`, `reflectTagsMatch`, `recallMinScores`, `recallTags`, `recallTagsMatch`, `recallTypes`, `retainTags`, `observationScopes`, `retainAsync`, `retainEveryNTurns`, `retainContext`, `retainStrategy`, `retainUserPrefix`, `retainAssistantPrefix`, `retainSource`). Use `"extends": "/path/to/base/config.json"` (supports `~/` and relative paths) to inherit a shared config file and override only client-specific fields (such as `"retainSource": ""`).
- `.env` (`0600`, optional): secret/endpoint overrides (`HINDSIGHT_API_KEY`, `HINDSIGHT_API_URL`, `HINDSIGHT_BANK_ID`, `HINDSIGHT_BANK_ID_TEMPLATE`, `HINDSIGHT_MCP_URL`, `HINDSIGHT_RETAIN_STRATEGY`, `HINDSIGHT_RETAIN_SOURCE`, `HINDSIGHT_RETAIN_CONTEXT`, `HINDSIGHT_RETAIN_USER_PREFIX`, `HINDSIGHT_RETAIN_ASSISTANT_PREFIX`, `HINDSIGHT_RETAIN_OBSERVATION_SCOPES`, `HINDSIGHT_RETAIN_TAGS`).

Multi-bank, recall, and retain semantics mirror Hermes Hindsight `1.2.4` 1:1 across hook-based agents: `.hindsight/config.toml` lookup in `trustedProjectDirs` -> `bankIdTemplate` (`{project}` from git root, linked worktrees, and symlinks) -> static `bankId`; multi-bank write fan-out (`mirrorToOwnBank`, `additionalBanks`) and concurrent recall (`recallAdditionalBanks`) with 80% extra-bank timeout and 5-minute cooldown; `recallMaxInputChars` (`800`), `recallMinScores`, `recallPrefetchMethod` (`"recall"` / `"reflect"`), `retainEveryNTurns`, and persistent transient-failure retry queue with idempotent `operation_id`. Dedicated banks automatically default to `recallTags: []`, `retainTags: []`, and `observationScopes: "shared"`; shared `"default"` banks preserve `profile:<active>` tag isolation automatically.

## Verification

```bash
npm test
node bin/agent-hindsight.mjs doctor --no-network
```

## License

Apache-2.0
