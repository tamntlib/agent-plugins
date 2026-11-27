---
name: project-local-development
description: Use when preparing or running cloned projects locally, configuring Git SSH commit signing, or running local Docker/Swarm checks.
version: 1.7.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- git
- local-development
- runtime
- hot-reload
- docker
- uv
---

# Project Local Development

Prepare or run a cloned repository with its own runtime or launcher while preserving prior work and touching only the requested branch and scope.

## Authority and Execution Gates

- **Separate actions:** Preparation is not execution; local build or smoke checks are not push, sync, or deploy; local identity setup is not history rewrite or force-push. Never print credentials.
- **Prep-only ("prepare/configure, do not run"):** Perform Git, configuration, and read-only inspection only. Do not install or sync dependencies (including `uv run`), run migrations, build artifacts, start services or watchers, or run app smoke tests.
- **Execution:** Check the launcher's first-run side effects (virtualenvs, dependency installs, image pulls, DB setup, codegen, migrations), distinguish local vs global changes, and complete local setup, repairs, and tests to readiness.

## Local Setup and Execution Workflow

1. **Worktree and Git:** Resolve the repository root and inspect branch, status, and remotes while preserving staged, modified, and untracked files; handle nested repositories at their own root. Inspect `origin` and `upstream` URLs before editing remotes (no unsolicited full fetch). For checkout, check local branches first, fetch only the exact remote branch if needed, track it, and verify.
2. **Local ignores:** Put machine-only ignore rules in `.git/info/exclude` (not `.gitignore`) using the narrowest pattern; prove them with `git check-ignore -v <path>` and `git status`.
3. **Runtime selection:** Follow the repository's lockfiles, manifests, `Makefile`, or docs (`uv`, Poetry, npm, pnpm, yarn, bun, Docker, Make; run `uv run` only when execution is authorized). Use `python3` for stdlib-only scripts and the project interpreter for project dependencies.
4. **Run, readiness, and resource bounds:** Invoke the canonical launcher (for non-executable scripts, call via the interpreter without unrequested `chmod`) and report process and environment details. Respect workspace CPU and RAM limits and inspect live host capacity before heavy builds or parallel test runs. Probe health, port, PID, and smoke behavior; fix local setup failures and retry, or stop on missing credentials, out-of-scope dependencies, or external blockers. Run task-relevant tests (and mandatory release gates on release tasks).
5. **Hot reload and runtime state:** Verify backend flags, frontend scripts, watch mounts, and docs separately — framework support does not guarantee hot reload is enabled, and live reload requires execution proof. For state or observability persistence issues, verify app paths against rendered or live mounts rather than relying on volume declarations alone.

## Git Identity and Signed Commits

Inspect effective identity and signing configuration before committing:

```bash
git config --show-origin --show-scope --get-regexp '^(user\.(name|email|signingkey)|commit\.gpgsign|gpg\.)'
git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT
```

- To inherit global or system identity, unset repo-local `user.name` and `user.email` (`git config --local --unset-all user.name || true`); never compensate via `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, or `GIT_COMMITTER_EMAIL`.
- For SSH commit signing (`[user] signingkey`, `[gpg] format = ssh`, `[gpg "ssh"] allowedSignersFile`, `[commit] gpgsign = true`), verify the key pair and allowed-signers principal match the commit email, then probe in a disposable repo with no command-scoped identity overrides:

```bash
(
  tmp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$tmp"' EXIT
  git -C "$tmp" init -q && git -C "$tmp" commit --allow-empty -S -m 'test: signing probe' \
    && git -C "$tmp" cat-file commit HEAD | grep -m1 '^gpgsig ' && git -C "$tmp" verify-commit HEAD
)
```

- Replacing an unsigned pushed tip requires explicit rewrite and push authorization (otherwise stop after the probe and report the untouched tip). On a clean worktree at the branch tip, record `HEAD`, `origin/<branch>`, and `HEAD^` after `git fetch origin <branch>` (stop if remote moved), check `git diff HEAD^ HEAD --check`, re-sign in place with `git commit --amend --no-edit -S` (prefer this over `git reset --soft HEAD^` + `git commit -S -m` so original author, date, and full commit body are preserved), verify `gpgsig`, `git verify-commit HEAD`, `git log -1 --show-signature`, and exact tree hash, then push with:

```bash
git push --force-with-lease=refs/heads/<branch>:<expected-old-sha> origin HEAD:refs/heads/<branch>
```

Re-fetch to verify local and remote tips match; check the hosting platform UI/API separately if a verified badge matters (local cryptographic verification does not prove remote key association).

## Local Container Builds and Swarm Checks

- **Inspect before building:** Check the Dockerfile, build context, platform, exact repo/tag expansion (including mutable tags like `latest`), temporarily modified tracked files (trap-restore and check `git diff --exit-code` on both failure and success), and whether a launcher chains build and push (never run chained push for local-only scope).
- **Candidate-first verification:** Build an unpublished candidate, inspect its architecture, OS, entrypoint, and command (`docker image inspect`), and run smoke probes (version, imports, entrypoint/help, assets). Changing base image, libc, OS package set, runtime version, resolver/lock, or architecture creates a new lineage requiring explicit approval before release.
- **Authorized publish:** Push only explicitly authorized registries, repositories, and tags (versioned before mutable), then read back remote manifests and digests (`docker buildx imagetools inspect`) and confirm a clean worktree.
- **Swarm `--skip-interpolation` bind-mount pitfall:** When rendering Docker Swarm configs with `docker stack config --skip-interpolation`, an env-driven bind mount (`source: ${HOST_DIR}`) may be treated as relative and prefixed with the stack file's directory. Inspect the uninterpolated render for unexpected checkout prefixes and re-run `docker stack config` with harmless dummy inputs to verify resolved sources and RO/RW flags (on Linux engines, a leading `/` such as `source: /${HOST_DIR:?...}/subpath` keeps the placeholder absolute; verify per engine).

## Completion

Report local changes, preserved pre-existing worktree state, runtime and launcher evidence, and only the checks applicable to the requested mode: prep-only (valid config with zero installs, builds, migrations, or running processes), local run (environment, readiness, fixed failures or blockers), or authorized remote operations (exact readbacks, never inferred from local builds).
