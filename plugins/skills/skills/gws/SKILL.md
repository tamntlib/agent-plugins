---
name: gws
description: Use when operating Google Workspace services via gws CLI.
version: 0.1.0
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- google-workspace
- gws
- gmail
- calendar
- drive
- sheets
- docs
related_skills: []
---

# Google Workspace (`gws`)

Operate Google Workspace services (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Tasks) directly through the standalone `gws` CLI (`https://github.com/googleworkspace/cli`) using profile-isolated configuration and credentials under `~/.config/tamntlib-skills/`.

## When to Use

- Reading, searching, or performing approved writes on Gmail, Google Calendar, Google Drive, Shared Drives, Google Sheets, Google Docs (including multi-tab Docs), Google Slides, Contacts, or Tasks.
- Resolving Google Sheets/Docs URLs (`gid`, `tab`), handling `.xlsx`/Office workbooks on Drive, or preserving formatting on structured edits.

## Prerequisites

- `gws` CLI available on `PATH`; verify with `gws --version`. Reuse existing installations and request explicit approval before installing host packages.
- Authorized Google OAuth2 credentials stored inside `{config_dir}` when a profile is active (or in `~/.config/tamntlib-skills/default/gws/` / system default `gws` config when no profile is active).

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Auth files inside `{config_dir}`:** `credentials.json` or `credentials.enc`, `client_secret.json`, and optional `.env` (`GOOGLE_WORKSPACE_PROJECT_ID`, `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND`).
- **Scoped invocation & fallback:** When `{config_dir}` is used, bind `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$CONFIG_DIR"` and `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file` (unless overridden in scoped config), unsetting ambient `GOOGLE_WORKSPACE_CLI_TOKEN`, `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, `GOOGLE_WORKSPACE_CLI_CLIENT_ID`, `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`, and `GOOGLE_WORKSPACE_CLI_PROJECT_ID` unless explicitly supplied for that exact call. When no profile is active and `default/gws` does not exist, fall back to host default `gws` config/env (`~/.config/gws`).
  ```sh
  env -u GOOGLE_WORKSPACE_CLI_TOKEN -u GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE \
    -u GOOGLE_WORKSPACE_CLI_CLIENT_ID -u GOOGLE_WORKSPACE_CLI_CLIENT_SECRET \
    -u GOOGLE_WORKSPACE_CLI_PROJECT_ID \
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$CONFIG_DIR" \
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file \
    gws auth status
  ```
- **Auth gate & login:** Confirm `gws auth status` reports `token_valid: true` (expected scopes/account) before live reads/writes. Interactive login / re-auth (explicit user authorization only; use narrower `-s` lists when appropriate):
  ```sh
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$CONFIG_DIR" \
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file \
  gws auth login -s drive,gmail,calendar,sheets,docs,slides,people,tasks
  ```

## Dynamic API Discovery & Core Usage

`gws` builds commands dynamically from Google's Discovery Service. Inspect exact parameter/body schemas before calling unfamiliar endpoints:

```sh
gws schema drive.files.list
gws schema sheets.spreadsheets.batchUpdate --resolve-refs
gws schema docs.documents.batchUpdate --resolve-refs
```

Common flags:
- `--params '<JSON>'`: URL/query parameters.
- `--json '<JSON>'`: JSON request body (`POST`/`PATCH`/`PUT`).
- `--upload <PATH>` / `--output <PATH>`: binary upload/download.
- `--page-all --page-limit <N>`: bounded NDJSON pagination.
- `--format json`: structured machine-readable output (default).

### Authority & Write Gate

- Loading this skill or holding valid credentials grants no write authority.
- **Never** send or modify email, create/update/delete calendar events, upload/share/move/delete Drive files, or mutate Docs/Sheets without explicit human approval of the exact target (account/profile, IDs, recipients, share role, range/tab, and content).
- For Drive deletions, prefer trashing (`trashed: true`) over permanent deletion unless explicitly approved.

## Service Workflows & Pitfalls

### Gmail & Calendar
- Gmail always requires `"userId": "me"`; use standard Gmail search operators (`is:unread`, `from:`, `newer_than:`, `has:attachment`) inside `q`.
- Calendar datetimes must include an explicit ISO 8601 timezone offset (e.g., `+07:00`) or `Z`.

### Google Drive & Shared Drives
- Always pass `"supportsAllDrives": true` on Drive reads/writes, and `"includeItemsFromAllDrives": true` on `drive files list`; omitting these causes false `File not found` errors on Shared Drives.
- Treat a Google Docs/Sheets URL as a route, not proof of file format: inspect `drive files get` (`mimeType`) first to distinguish native Google Docs/Sheets (`application/vnd.google-apps.*`, converted via `drive files export`) from uploaded `.xlsx`/`.docx` Office files. Uploaded Office files cannot be downloaded with `drive files export`—download them via `drive files get` with `{"fileId": "...", "alt": "media", "supportsAllDrives": true}` and `--output <PATH>`, edit preserving styles/formulas, and upload back via `drive files update` (`--upload <PATH>`) with `supportsAllDrives: true`.

### Google Sheets
- **URL & `gid` routing:** For `.../spreadsheets/d/SPREADSHEET_ID/edit?gid=SHEET_GID`, preserve `SPREADSHEET_ID` and numeric `gid` verbatim. Resolve `gid` to its exact tab `title` via `sheets spreadsheets get` (fields `sheets.properties`) before constructing A1 ranges—never guess or silently switch tabs.
- **Preserve presentation on content edits:** Content approval (values, rows, formulas) never authorizes restyling. Use `sheets spreadsheets values update/append` or `updateCells` with `fields: "userEnteredValue"`—never send `repeatCell` formatting, `PASTE_FORMAT`, dimension edits, or view edits unless explicitly requested. For approved style changes, snapshot original fields first and restrict field masks strictly.
- **Spilled `ARRAYFORMULA` headers & conditional formats:** Clear colliding formulas in the target spill range in the same values update; prefer `IFNA` over broad `IFERROR` so blocked spills stay visible; check horizontal grid width before spilling (array formulas do not auto-append columns); verify rendered cells via `includeGridData: true`. Identify conditional formatting rules by live range/condition rather than a remembered index.
- **Dropdowns & notes:** When dropdown or strict list validation is requested, use `setDataValidation` with `ONE_OF_LIST`, `showCustomUi: true`, and `strict: true` (omit `inputMessage` unless requested; leave `strict: false` if soft warnings are intended). Delete notes only via `updateCells` with `fields: "note"` and an empty note on exact approved cells.
- **Readback & concurrency:** Re-read immediately before batch writes and abort on unexpected concurrent edits; read back exact mutated ranges afterward to verify effective values and untouched formatting.

### Google Docs (Multi-Tab & Structured Editing)
- Never flatten a multi-tab Doc to plain text when tabs, headings, lists, links, or direct formatting matter.
- Read with `"includeTabsContent": true` and locate tabs recursively through `childTabs` by `tabProperties.tabId` (matching the URL `tab=` query parameter), never by visible tab title.
- Capture `revisionId` and pass `writeControl: {"requiredRevisionId": "<id>"}` on every `batchUpdate` so concurrent edits fail closed.
- Include `tabId` on every `location` and `range` in a multi-tab document; preserve the mandatory final paragraph newline; for structural multi-tab rewrites where collateral edits are a risk, hash non-target `documentTab` bodies before and after writes to prove zero collateral changes.
- Calculate all text ranges in **UTF-16 code units** (`len(text.encode("utf-16-le")) // 2`), not Python character counts.
- For full structural tab rewrites, execute four ordered phases (refetching indexes after every index-changing phase):
  1. Replace body text up to `endIndex - 1` (preserving final newline; prefix bullet lines with `\t * nestingLevel`).
  2. Refetch indexes, then apply `createParagraphBullets` (e.g., `bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"`, supplying `●`, `○`, `■`) bottom-to-top per contiguous list block (bullet creation strips leading tabs and shifts later indexes; copy source indents after bullet creation if a first-level list is intentionally shifted, and refetch immediately after).
  3. Restore writable `updateParagraphStyle` fields (typical field mask: `namedStyleType,alignment,lineSpacing,direction,indentFirstLine,indentStart,indentEnd,spaceAbove,spaceBelow,spacingMode,keepWithNext,keepLinesTogether,avoidWidowAndOrphan,shading,pageBreakBefore`, excluding `headingId`).
  4. Apply `updateTextStyle` for direct emphasis, colors, and hyperlinks using UTF-16 offsets.

## Verification & Reporting

- Verify every authorized write via a fresh live API readback (HTTP 200 alone does not prove intended final state).
- Report the resolved `{profile}`, exact resource IDs/URLs/tabs/ranges, observed counts, and any untested or rate-limited boundaries without exposing credentials or dumping raw private content.
