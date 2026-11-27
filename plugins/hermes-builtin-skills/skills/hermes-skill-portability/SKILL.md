---
name: hermes-skill-portability
description: Load alongside Hermes-authored skills (`microsoft-office`, `pdf`, `systematic-debugging`, `simplify-code`, `dogfood`, `youtube-content`, `popular-web-designs`, `spike`, `document-to-action-items`) when running outside Hermes to adapt Hermes-specific tools, helper idioms, and runtime paths to the active agent environment.
version: 1.0.0
author: tamntlib
license: Apache-2.0
---

# Hermes Skill Portability

Adapt synced Hermes built-in skills cleanly when executing them in a non-Hermes agent runtime (such as Antigravity, Claude Code, or Codex).

## Adaptation Rules

1. **Map tools dynamically to the active runtime:** Treat Hermes-specific tool names, helper idioms, and calling conventions in synced skills as capability intent rather than literal API requirements. Substitute the closest equivalent native tool, MCP server, or installed skill already available in the current runtime (for example, using the runtime's own shell, file/image reader, web search/fetch, subagent/workflow runner, or installed browser automation skill).
2. **Ignore Hermes-internal setup & paths:** Skip Hermes-only bootstrap commands, source-checkout helpers, or `$HERMES_HOME` cache/state assumptions. Run bundled helper scripts with standard upstream dependencies using an environment that follows the current user/runtime execution policy (such as Docker-only execution or explicit approval before host package/venv installs).
3. **Preserve active runtime boundaries:** Keep the current session's active profile, credential isolation, approval gates, and safety rules authoritative—never fall back to Hermes defaults or bypass access/anti-bot controls.
4. **Fail closed on missing capabilities:** If a step requires a tool, binary, or dependency with no safe equivalent available, stop and report the exact gap clearly rather than fabricating results.
5. **Do not patch synced upstream skills in place:** Apply these runtime adaptations at execution time; keep files under upstream-synced skill directories unmodified so automated syncs stay clean.
