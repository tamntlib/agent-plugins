---
name: hermes-feature-verification
description: Use when verifying Hermes features across UI surfaces.
version: 1.8.2
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- hermes
- feature-verification
- dashboard
- desktop
- tui
- source-tracing
related_skills:
- hermes-agent
- hermes-configuration-maintenance
- hermes-response-verification
---

# Hermes Feature Verification

Verify Hermes features across CLI/TUI, Desktop, Web Dashboard, messaging adapters, third-party clients, browsers/extensions, and OS/IME layers. Identify the owning surface first — a shared URL, store, or UI style does not prove ownership.

Route config, provider schema, model-picker config, and smart-approval checks to `hermes-configuration-maintenance`, and response, claim, or session-evidence verification to `hermes-response-verification`; verify cross-profile or multiplex gateway boundaries separately before mutating shared state.

## Universal Verification Gates

- **Pin context:** Record build, revision, connection mode, profile, and operation first. Separate agent tools, Desktop Terminal pane, and Desktop UI; diff against prior/upstream revisions when checking regressions.
- **Check docs and schema:** Read [official docs](https://hermes-agent.nousresearch.com/docs/llms.txt) and relevant guides via `hermes-agent` before claiming a feature is absent; verify config schema and runtime behavior separately.
- **Trace end to end:** Follow UI → route → server/plugin → runtime. Source code is not the installed binary; an issue is a bug report; an open PR is not shipped; a merged PR still needs commit plus live/device checks.
- **State boundaries honestly:** Mark code-only checks **source-verified, not device-tested**. Mobile touch/IME requires real-device testing (not emulation); `/health` or `/api/status` does not prove REST/WS auth; reconnect checks require the production helper and a fresh dial.
- **Read-only default & redaction:** Never quit, restart, mutate, inject shims, or publish without authorization. Never print tokens, credential URLs, keys, or unrelated session contents (report booleans, lengths, fingerprints, status codes, PID, port, and owner).
- **Reporting & repairs:** Report owner, proof, untested gaps, and revision-qualified negatives. Authorized repairs use the environment's current resource budget (respecting any configured container CPU/memory caps), keep rollback material, verify via readbacks, and respect service-owner/cgroup restart gates.

## UI, PTY, and Connection Boundaries

Confirm device, gateway, profile, and view before concluding a host or workspace bug; separate displayed row, selected session, and execution route.

- **Ownership:** Agent `terminal` runs on the session backend; Desktop Terminal pane runs an Electron PTY (mode/build dependent); file/session views query the profile gateway (verify previews and file links separately); Bot-to-Bot runs on the owning gateway (Desktop Bot Mode acts as relay).
- **Modes:** Local (local backend/PTY), Remote URL (remote backend; verify whether PTY is remote or local), Cloud (cloud backend; verify shell), SSH (remote backend + SSH PTY; closed issue does not prove shipped fix).
- **Boundary probe:** Run identically in both `terminal` and the Terminal pane (creating no files):

```sh
hostname; whoami; pwd; uname -a; printf 'HOME=%s\n' "$HOME"
```

Different hostnames reflect distinct boundaries — remote chat with a local pane is not a broken agent, and remote status does not prove a remote pane. For Bot Mode, distinguish ordinary vs Bot Chat, reachable gateways, relay vs peers, and which gateway owns filesystem, tools, MCP, credentials, and trust.

## Desktop Artifacts, Port Topology, Remote Auth, and Lifecycle

Verify revision and artifact metadata against `/docs/llms.txt`, `/docs/user-guide/desktop`, `/docs/user-guide/multi-connection-desktop`, and `hermes serve`.

- **Artifacts & modes:**
  - **Bootstrap installer** (`Hermes-Setup.exe`/`.dmg`, `apps/bootstrap-installer/src/routes/welcome.tsx`, `store.ts`): installs local Hermes, Python, deps, Node, and Desktop (cannot operate zero-local-runtime).
  - **Desktop app** (`apps/desktop/src/components/desktop-install-overlay.tsx`, `apps/desktop/README.md`): supports **Connect to existing Hermes** and **Install Hermes locally**.
  - **Connection modes:** Local (`hermes serve`), Remote (HTTP(S)/WS), SSH (tunnel + on-demand start/adopt), Cloud (Portal). Remote stops local execution while bootstrap files remain. GUI-only requires an official Desktop artifact (Web Dashboard is an alternative).
- **Port topology:** `hermes serve` / `hermes dashboard` (port `9119`, JSON-RPC/WS + REST) are Desktop backends; OpenAI API (`8642`: `/health`, `/v1/*`) and messaging adapters (Telegram/Discord/Slack) are **not**. Use **SSH** (`user@host:port`, key + tunnel + token) for trusted single-user on-demand sessions, and **Remote** (`http(s)://host:9119`) for always-on, multi-client, LAN/Tailscale, HTTPS, or supervised hosts. Check `hermes serve --status`, bind address, `/api/status`, and Desktop **Settings → Gateways → Test** (HTTP + WS).
- **Remote Basic Auth deployment:** Confirm port `9119` is free and enable fail-closed auth **before** non-loopback bind: store username, password hash, and a 32+-byte secret in `0600` `.env`. Run `hermes serve --host 0.0.0.0 --port 9119` (or `hermes dashboard ... --no-open`), or use user systemd with `.env`, `HERMES_HOME`, the `pm` launcher (`<checkout>/.hermes/bin/hermes`) and `~/.hermes/tools/*` on `PATH`, restart policy, and linger. Restrict firewall to trusted interfaces (e.g., `tailscale0`); use Basic Auth only on trusted LAN/VPN (public internet requires HTTPS + OAuth/OIDC). Verify listener, `GET /api/status` (`auth_required: true`), unauthenticated REST `401`, login, `POST /api/auth/ws-ticket`, `/api/ws` ticket, and Desktop sign-in + **Test**. Store hashes in `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` (`plugins.dashboard_auth.basic.hash_password`), delete plaintext `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` completely, show generated passwords once, and rotate `HERMES_DASHBOARD_BASIC_AUTH_SECRET` to invalidate sessions.
- **SSH boundaries (trace in order):** (1) key + non-interactive SSH; (2) remote `hermes` executable/version/profile/`serve` owner flags; (3) runtime dir, spawn log, owner record (PID/port/profile/nonce); (4) `127.0.0.1:<dynamic-port>` PID; (5) `/api/status`; (6) handshake token length/fingerprint vs owner record + REST; (7) `/api/ws?token=...` via Desktop; (8) served token failing while file token works indicates an import-time closure capturing a mutable token.
- **Close vs Quit semantics:** Closing the window does not quit Desktop (e.g., macOS Dock). On quit, **Keep Running** preserves the backend while **Quit Anyway** stops an owner-verified SSH backend (bounded wait/force-stop, cancel forward, close SSH; active turn interrupted). Crash/kill/drop differs from clean quit; reopening history does not auto-resume live execution; Remote URL backends are unowned by Desktop. Trace `apps/desktop/electron/remote-lifecycle.ts`, `main.ts`, and `connection-apply.ts`.

## Projects and Workspaces

Separate runtime `pwd` (`cd` never reassigns a workspace) from persisted `state.db.sessions.cwd`. A directory on disk is not automatically a workspace; Home uses `cwd = NULL` with a non-empty runtime fallback.

- **Taxonomy:**
  - **Home (`__no_project__`):** Unclaimed, undeletable default bucket.
  - **Auto:** Derived from `cwd`/Git root or repo-discovery cache. **Hide from sidebar** is Desktop-local; cross-client removal requires clearing/reassigning metadata and scan roots/exclusions (archiving does not remove it; never delete the repo). Adopt as Explicit to rename, combine folders, style, or delete.
  - **Explicit:** Stored in profile `projects.db` (shared across clients; deleting keeps files and sessions).
- **Read-only inspection:** Verify backend + profile → `projects.list` (empty implies synthetic/auto) → `projects.tree` (`id`, `path`, `isAuto`, `isNoProject`, `sessionCount`) → `state.db` (`source`, `cwd`, `git_repo_root`, messages) → live registry + `terminal.cwd`/`terminal.home_mode` → fallback → compare `sessions.cwd` vs `pwd`.
- **Native moves (`session.workspace.move`):** Lack of a `move` subcommand in `hermes sessions --help` does not require SQLite edits. `session.workspace.move` accepts `session_key`, `profile`, and existing `cwd`, updating Git metadata and live lanes mid-turn (unlike `session.cwd.set`, which rejects busy sessions). Bare OS home maps to Home via `_is_session_cwd_junk` unless an Explicit project claims it. `desktop_project switch` targets Explicit projects only. Confirm shell `pwd`, session ID, and messages remain intact.
