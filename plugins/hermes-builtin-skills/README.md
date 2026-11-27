# tamntlib-hermes-builtin-skills

Curated built-in skills automatically synced from [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) (MIT License) for **non-Hermes agents** (**Antigravity**, **Claude Code**, **Codex**), paired with a lightweight local portability skill.

> **Do not install or symlink this plugin into Hermes.** Hermes already ships these built-in skills natively; mounting this plugin inside `~/.hermes/skills/` would create duplicate skill names.

## Included Skills (15)

**Upstream synced from `NousResearch/hermes-agent` (14):**
- `microsoft-office` — Create, read, edit, and review Word (`.docx`), PowerPoint (`.pptx`), and Excel (`.xlsx`) files.
- `pdf` — Create, read, merge, split, fill/flatten forms, OCR, and edit PDF files.
- `systematic-debugging` — 4-phase root-cause debugging methodology.
- `test-driven-development` — Strict RED–GREEN–REFACTOR test-first workflow.
- `simplify-code` — Multi-pass code review and cleanup for recent changes.
- `architecture-diagram` — Dark-themed SVG architecture/cloud/infra diagrams as HTML.
- `claude-design` — Design one-off HTML artifacts (landing pages, decks, prototypes).
- `popular-web-designs` — 54 real website design systems as HTML/CSS references.
- `humanizer` — Strip AI-isms from prose and refine natural voice.
- `spike` — Timeboxed throwaway experiments to validate ideas before building.
- `document-to-action-items` — Extract cited obligations, deadlines, and tasks from documents.
- `meeting-action-items` — Turn meeting transcripts/notes into cited decisions, owners, and tickets.
- `youtube-content` — Turn YouTube transcripts into summaries, threads, or articles.
- `dogfood` — Exploratory web app QA workflow with evidence and structured issue reports.

**Local plugin skill (1, preserved across syncs):**
- `hermes-skill-portability` — General runtime-adaptation guidance loaded alongside Hermes-authored skills when running outside Hermes.

## Maintenance & Sync

Do **not** hand-edit upstream-synced folders inside `skills/`; upstream changes overwrite local edits on the next sync. Only entries listed in `localSkills` inside [`upstream-manifest.json`](./upstream-manifest.json) are locally maintained and preserved.

- Manage synced and local skills in [`upstream-manifest.json`](./upstream-manifest.json).
- Sync locally on demand:
  ```bash
  node scripts/sync-hermes-builtin-skills.mjs
  ```
- Daily automated sync runs via [`.github/workflows/sync-hermes-builtin-skills.yml`](../../.github/workflows/sync-hermes-builtin-skills.yml) and commits/pushes directly to `main` only when actual upstream skill or license contents change.

## License & Attribution

Upstream-synced skills originate from [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) and retain their upstream MIT License and authorship attribution (see [`LICENSE`](./LICENSE) and per-skill `LICENSE`/`SKILL.md` files). Locally authored plugin files (including `hermes-skill-portability`) are Apache-2.0.
