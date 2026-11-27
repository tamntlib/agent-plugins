---
name: gh
description: Use when operating GitHub via the gh CLI with profile-isolated auth and config.
version: 0.1.0
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- github
- gh
- pull-requests
- issues
- code-review
- attachments
- authentication
related_skills: []
---

# GitHub CLI (`gh`)

Operate GitHub repositories, issues, pull requests, releases, CI checks, API queries, and private issue/PR attachments through the standalone `gh` CLI using profile-isolated configuration and credentials under `~/.config/tamntlib-skills/`.

## When to Use

- Reading, searching, reviewing, or performing approved writes on GitHub issues, pull requests, discussions, checks, releases, or repositories via `gh` / `gh api`.
- Reading private `github.com/user-attachments/files/...` links referenced in GitHub issues or pull requests.
- Setting up or verifying per-profile GitHub CLI authentication without cross-profile leakage.

## Prerequisites

- `gh` CLI available on `PATH`; verify with `gh --version`. Reuse existing installations and request explicit approval before installing host packages.
- Authorized GitHub credentials stored inside `{config_dir}` when a profile is active (or in `~/.config/tamntlib-skills/default/gh/` / system default `gh` auth when no profile is active).

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Auth files inside `{config_dir}`:** `.env` (`GH_TOKEN` for classic or fine-grained PATs, plus optional `GH_HOST` / `GH_ENTERPRISE_TOKEN`), or `hosts.yml` (plus optional `config.yml`) for OAuth / `gh auth login`.
- **Scoped invocation & fallback:** When `{config_dir}` is used, always bind `GH_CONFIG_DIR="$CONFIG_DIR"` and unset ambient `GH_TOKEN`/`GITHUB_TOKEN` (then load `{config_dir}/.env` into the child env if present); fail closed if `{config_dir}` has neither a valid `.env` nor `hosts.yml`. When no profile is active and `default/gh` does not exist, fall back to host default `gh` auth (`GH_TOKEN`/`GITHUB_TOKEN` or `~/.config/gh`).
  ```sh
  # Example when using hosts.yml (or inject GH_TOKEN from {config_dir}/.env in the scoped child env)
  env -u GH_TOKEN -u GITHUB_TOKEN \
    GH_CONFIG_DIR="$CONFIG_DIR" \
    gh auth status --json hosts
  ```
- **Auth gate & setup:** Confirm `gh auth status --json hosts` reports `active: true` for the expected host and account before reads/writes. Never cache rotating OAuth `gh auth token` output; stop on `refresh_expired` or wrong account. With explicit user authorization, configure PATs in `{config_dir}/.env` (`GH_TOKEN=<token>`) or run interactive OAuth login (`env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$CONFIG_DIR" gh auth login --insecure-storage`; on keyring-less Linux hosts where `--with-token` hangs, use `.env`).
- **Git SSH boundary:** `GH_CONFIG_DIR` / `GH_TOKEN` isolate `gh` CLI (and HTTPS git helpers); Git over SSH (`git@github.com:...`) is controlled separately by `~/.ssh/config` and `~/.gitconfig` (`includeIf`).

## Core CLI Usage Patterns

When `{config_dir}` is in use, always prefix commands with the scoped profile environment (`GH_CONFIG_DIR="$CONFIG_DIR"` + validated `GH_TOKEN` from `.env` if present, with ambient `GITHUB_TOKEN` unset); when falling back to host-default auth (no active profile and no `default/gh`), invoke `gh` directly under the verified host environment.

- **Non-TTY behavior:** `gh` automatically disables the pager, strips ANSI color, and fails fast instead of prompting when run non-interactively (there is no `--no-pager` flag; do not pass it).
- **Structured output:**
  - Use `--json <field1,field2,...>` for machine-readable output; run `--json` with no field list to discover available fields for a subcommand.
  - Use `--jq '<expr>'` for inline filtering, or `--template '<go-template>'` alongside `--json` (check `--help` first because `-T`/`--template` selects body templates on `issue create` / `pr create`).
  - On `gh issue view` and `gh pr view`, pass `--json ...,comments` for structured comments; `--comments` is only for human-readable output and cannot be combined with `--json`.
- **Pagination & truncation:**
  - List and search commands default to 30 results; pass `-L <N>` (`--limit <N>`) explicitly and treat it as a cap rather than a complete total.
  - For complete API listings, use `gh api --paginate <endpoint>` (with `--jq` / `--slurp` when combining pages). Use `gh api graphql` when exact `totalCount` is required.
- **Repository targeting:** Pass `-R OWNER/REPO` (`--repo`) explicitly whenever outside the target repo or when remotes may be ambiguous.
- **Search vs list:**
  - `gh search issues|prs|code|repos|commits|users`: pass each qualifier as its own bare token (e.g., `gh search issues repo:owner/name is:open author:alice`), quoting only multi-word free text. Prefer dedicated flags (`--repo`, `--author`, `--label`, `--app <bot-slug>`) when available.
  - `gh issue list --search "..."` / `gh pr list --search "..."`: takes one quoted query string scoped to the single repo.
  - Bot authors are GitHub Apps: use `--app dependabot` or `--author "dependabot[bot]"` instead of `--author dependabot`.
- **Read without mutating local git state:** Prefer `gh pr view` and `gh pr diff` over `gh pr checkout` (which switches the current branch). When a local checkout is explicitly needed without disturbing the working tree, use `gh pr checkout <n> --worktree <path>`.
- **Fresh remote verification:** Back every claim about CI status, reviews, merges, releases, or issue state with a fresh `gh` read (e.g., `gh pr checks`, `gh pr view --json state,mergedAt,reviewDecision,headRefOid`)—never assume from memory.

## Authority & Write Gate

- Loading this skill or holding valid profile credentials grants **no write authority**.
- **Never** create, edit, comment on, label, close, merge, approve/request changes on, upload attachments to, release, fork, or delete GitHub resources without explicit human approval naming the target profile/account, repository, item, and content.
- Before creating an issue or PR (once authorized), read full thread context (`comments`) and sweep for duplicates with `gh issue list --search` / `gh pr list --search`.

## Private GitHub Issue & PR Attachments

Use when reading `github.com/user-attachments/files/...` links from private issues or pull requests. An unauthenticated HTTP 404 does **not** prove the file is missing.

1. Confirm `gh` is authenticated via the `gh auth status` gate above (scoped to `{config_dir}` when active, or host default when no profile is active and `default/gh` does not exist).
2. Fetch the exact attachment URL with an `Authorization: Bearer` header using a fresh token from that active `gh` auth context (`GH_TOKEN` from `{config_dir}/.env`, or `gh auth token` under the active scoped/default `gh` environment) **in process memory** (e.g., a short Python script reading the file/env in memory); never place the token in command arguments or print the token, raw response bodies, or signed redirect URLs.
3. Verify the authenticated HTTP status and expected file type. For Office archives (`.pptx`/`.xlsx`/`.docx`), verify ZIP integrity before inspecting the artifact, and remove temporary downloads afterward.
4. If authenticated access still fails, report the observed HTTP status and access limitation; only conclude a link is broken when authenticated evidence supports it. Never infer visual correctness from a successful download or ZIP check.

## Verification & Reporting

- Report the active `{profile}`, verified GitHub account/host, target repository, and exact fresh read results (URLs, numbers, states, statuses).
- Never echo tokens, `hosts.yml` contents, or signed attachment redirect URLs in chat or logs.
