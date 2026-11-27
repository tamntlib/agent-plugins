# Hindsight Memory

Relevant long-term memories from Hindsight are automatically recalled into context before each turn, and completed conversation turns are automatically retained in the background.

- Do not call Hindsight recall tools redundantly if the information you need is already present in the `# Hindsight Memory` block for this turn.
- Treat recalled memories as historical guidance, not live ground truth for current repo or host state; verify mutable state directly when accuracy matters.
- When calling Hindsight MCP tools (`recall`, `retain`, `reflect`) directly:
  - Follow the active bank (and optional profile tag, if one is announced) reported at session start.
  - When a profile uses dedicated bank-level isolation (no profile tag announced at session start), do not add arbitrary `profile:*` tags; the bank endpoint already enforces isolation.
  - When a profile tag (`profile:<active>`) is announced for a shared bank, pass `tags: ["profile:<active>"]` and `tags_match: "any_strict"` on `recall`, and `tags: ["profile:<active>"]` on `retain`.
- Fail closed if the active profile is unresolved or in conflict: do not query or write Hindsight memories across profiles.
