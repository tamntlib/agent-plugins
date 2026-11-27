# tamntlib-skills-hermes

Public Hermes-oriented skills packaged as an independent plugin inside [`tamntlib/agent-plugins`](https://github.com/tamntlib/agent-plugins).

## Included Skills (3)

- `hermes-configuration-maintenance`: edit, prune, and verify named Hermes profile configuration (`config.yaml` and `.env`), provider fallbacks, MCP secret externalization, API listener binding, and timeout watchdogs.
- `hermes-feature-verification`: verify Hermes features across CLI/TUI, Desktop, Web Dashboard, remote auth, SSH boundaries, and projects/workspaces end to end.
- `hermes-response-verification`: verify claims about Hermes behavior, memory layers, credentials, session history, and runtime retries before answering.

## Installation

Install from the marketplace or link `plugins/skills-hermes/skills` into `~/.hermes/skills/`:

```bash
/plugin install tamntlib-skills-hermes --marketplace tamntlib/agent-plugins
```

## License

Apache-2.0 — see `LICENSE` and `NOTICE.md`.
