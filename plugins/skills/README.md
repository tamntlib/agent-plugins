# tamntlib-skills

Reusable cross-agent workflows and profile-isolated integration skills packaged as a standalone plugin inside [`tamntlib/agent-plugins`](https://github.com/tamntlib/agent-plugins).

## Included Skills (18)

- **Profile-isolated integrations (`~/.config/tamntlib-skills/{profile}/{skill}/`, default `{profile}` = `default`):**
  `backlog`, `discord`, `facebook`, `gh`, `gws`, `microsoft-graph`, `microsoft-teams`, `slack`, `telegram`
- **Cloud & browser CLI workflows (native CLI profile/configuration contracts):**
  `agent-browser`, `aws`, `gcloud`
- **General engineering & agent workflows:**
  `agent-corrective-action`, `authorization-aware-execution`, `git-cleanup`, `minimal-override-configuration`, `project-local-agent-context`, `project-local-development`

## Configuration Convention

1. For profile-scoped skills (`{profile}` `<=64` lowercase `[a-z0-9]` with single hyphens; order: explicit task scope -> `AGENT_PROFILE` -> active session/workspace profile context):
   - **Active profile present:** Privately consult only `~/.config/tamntlib-skills/{profile}/{skill}/` and fail closed if missing—never fall back to `default`, another profile, or host default tool configs.
   - **No profile active (`default`):** Consult `~/.config/tamntlib-skills/default/{skill}/` first; for standalone CLIs with native host configs (`gh`, `gws`), fall back to the host's default CLI config/env only when `~/.config/tamntlib-skills/default/{skill}/` does not exist.
2. For `.env`-keyed API skills (`backlog`, `discord`, `facebook`, `microsoft-graph`, `microsoft-teams`, `slack`, `telegram`), existing explicit process-environment presence wins (including empty values) before consulting `~/.config/tamntlib-skills/{profile}/{skill}/`.
3. Keep user-owned `tamntlib-skills/`, `{profile}/`, and `{skill}/` directories at `0700` and `.env`/credential files at `0600` (or equivalent owner-only Windows ACLs).

## License

Apache-2.0 — see `LICENSE` and `NOTICE.md`.
