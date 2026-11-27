---
name: project-local-agent-context
description: Use when persisting project-local agent context.
version: 1.2.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- project-context
- hermes
- claude-code
- codex
- gitignore
related_skills: []
---

# Project-Local Agent Context

Keep repository knowledge in that repository's local context, not in global memory. Use when persistence is requested or allowed by the governing task policy; an audit or read-only review does not itself authorize changing context files.

## Choose the owner

Repository commands, paths, ports, architecture, deployment policy, release conventions and project-specific preferences are project-local. Stable user facts and genuinely cross-project environment conventions may belong in global memory. Reusable cross-project procedures belong in their governing skill, not a project fact dump.

Resolve the active Git root, or the explicitly selected workspace when there is no Git repository. Reuse the project's established local-context owner. For a cross-agent local setup without an established owner, `AGENTS.override.md` is the default canonical file. Preserve existing content, resolve contradictory facts rather than appending both, and never duplicate the same fact in local and global stores. A restricted reviewer unable to write locally must not fall back to global memory.

## Compose context before creating adapters

Inspect the current native entry points and the installed runtimes' actual precedence. In current Hermes, `.hermes.md` can win over the AGENTS family; `AGENTS.override.md` (Codex's local override convention) shadows the neighboring `AGENTS.md`; Claude Code loads `CLAUDE.md` and `CLAUDE.local.md`; and Gemini/Antigravity runtimes also load `GEMINI.md` and workspace rules (such as `.agents/rules/` or `.gemini/` rule files alongside `AGENTS.md`). A local file's existence therefore does not prove the committed base was also loaded.

Determine whether the local context intentionally **replaces** or **supplements** shared rules:

- Preserve an established replacement contract; do not silently import all upstream guidance.
- For supplementation, arrange for applicable base instructions to be considered once, followed by explicit local differences. Use a contextual reference to the relevant base/section, not an unconditional stack of every document before every edit.
- Do not import upstream auto-push, deployment or other conflicting directives as a workaround for shadowing. User/task authorization and deliberate local security boundaries still govern. Ask when replacement versus supplementation is a consequential unresolved choice.

Create only adapters needed by the runtimes actually in use. Claude Code can import `@AGENTS.override.md` from `CLAUDE.local.md` (alongside `CLAUDE.md`) when that loader supports it. Hermes versions that already discover the native override need no new `.hermes.md` merely to point at it; if `.hermes.md` already exists, preserve its shared/local composition and add the needed local reference without discarding its other rules. For Gemini/Antigravity workspaces using `GEMINI.md` or local workspace rule files, reuse or reference the canonical local context rather than duplicating rules across files. Do not create or migrate every runtime's files automatically.

## Write and verify

For authorized persistence, make the smallest update to the chosen canonical local file and necessary adapters. Keep local context uncommitted. Check whether `AGENTS.override.md`, `CLAUDE.local.md`, `.hermes.md`, `GEMINI.md`, or any Antigravity/Gemini workspace rule files actually created or maintained by this operation are already ignored. Add missing exact entries to `.git/info/exclude`, not the shared `.gitignore`, unless the user asked for shared ignore policy.

An ignore rule does not hide an already tracked file; report that boundary instead of removing it from the index without permission. Verify with `git check-ignore` where applicable and inspect the effective context-loading path with a read-only probe or current loader evidence. State whether the base is replaced or supplemented and which files changed. Do not claim an adapter text reference was expanded automatically unless the runtime proves it. Do not commit or push these local files.
