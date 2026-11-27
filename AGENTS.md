# Repository contribution boundaries

- Edit the owning canonical plugin or skill and its support files; do not duplicate or vendor upstream originals (exception: `plugins/hermes-builtin-skills/` is an automated upstream sync from `NousResearch/hermes-agent` for non-Hermes agents — never hand-edit upstream-synced skills under `plugins/hermes-builtin-skills/skills/`; only entries listed in `localSkills` are locally maintained, and synced skills are managed in `upstream-manifest.json` via `scripts/sync-hermes-builtin-skills.mjs`).
- Read the exact affected content and runtime provenance/protection state before editing. Preserve names, author attribution, pin/lock policy, and unrelated behavior.
- Keep credentials, account caches, runtime metadata, and captured private task/run histories outside this repository. Use process environment variables and parameterized examples.
- Resolve actual package paths rather than hardcoding a maintainer or plugin-cache location. Verify relative links and changed helper entrypoints.
- Review changes and run appropriate checks in an isolated environment before publication. Do not commit, push, install duplicates, or modify agent/profile settings without explicit task authority.
- Keep skills flat at `plugins/<plugin>/skills/<name>/SKILL.md` (omit `category` on creation) and verify `find plugins -path '*/skills/*/*/*/SKILL.md'` returns empty before committing.
