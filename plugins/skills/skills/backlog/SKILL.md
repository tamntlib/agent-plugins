---
name: backlog
description: Use when working with Backlog issues, PRs, and wikis.
version: 0.2.3
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- backlog
- issues
- pull-requests
- repositories
- wiki
---

# Backlog

Operate Backlog via REST API v2 and Git for repository operations. Infer the target space from task context, select the API key dynamically, and follow read-context -> act -> verify discipline (Backlog is not GitHub).

## When to use

- Read, search, create, triage, assign, and update Backlog issues and comments.
- Work with Backlog pull requests, repositories, wikis, attachments, and shared files.
- Handle Backlog URLs or Git repositories with Backlog remotes.

## Target resolution before auth

Precedence: explicit target in current request -> currently discussed resource -> relevant Git remote or explicit project context. A reference link is not a write target. Inspect Git remotes locally without exposing embedded credentials, converting verified Backlog Git hosts to web spaces explicitly.

Do not ask the user to repeat an unambiguous space/project/repo; ask only when multiple spaces remain plausible. An issue key (`PROJECT-123`) alone does not identify a space—never scan configured spaces to guess. Resolve each target independently in cross-space tasks and never reuse a last-used key.

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Variables (`.env`):** Resolve the target `https://<space>.backlog.com` space first and select only `BACKLOG_<UPPERCASE_SPACE>_API_KEY` (hyphens -> underscores in the variable name only, e.g., `example-alpha.backlog.com` -> `BACKLOG_EXAMPLE_ALPHA_API_KEY`; never another space's key). `scripts/backlog_api.py` supports `*.backlog.com` spaces only (`*.backlog.jp`, `*.backlogtool.com`, and custom hosts require a separately verified client).
- **Precedence & fallback:** Explicit caller-supplied process env wins by presence (including empty strings; empty required = error); otherwise read `{config_dir}/.env`. No host-default fallback when `default/backlog` is absent. Provisioning grants no `auth` or write authority.

## CLI contract (`scripts/backlog_api.py`)

Paths are relative to `https://<resolved-space>.backlog.com/api/v2`. Uses Python 3.10+ stdlib only; resolve actual `PYTHON` and `SCRIPT` paths independently of any agent install.

```text
PYTHON SCRIPT --target example-alpha.backlog.com resolve
PYTHON SCRIPT --target https://example-beta.backlog.com/view/PROJ-123 auth
PYTHON SCRIPT --target example-beta.backlog.com api /issues/PROJ-123
PYTHON SCRIPT --target example-beta.backlog.com api /issues --param 'projectId[]=123' --param count=100 --param offset=0
PYTHON SCRIPT --target example-beta.backlog.com api /issues/PROJ-123 --method PATCH --write --data-file /absolute/update.json
PYTHON SCRIPT --target example-beta.backlog.com api /space/attachment --method POST --write --upload-file /absolute/file.txt
PYTHON SCRIPT --target example-beta.backlog.com api /issues/PROJ-123/attachments/456 --output /absolute/new-download.bin
```

- `resolve`: offline JSON `{host, credential_env}` (no credential read or network).
- `auth`: `GET /users/myself`; returns host, var/source, HTTP status, and `authenticated` flag only (no account details). Run once per space/session.
- `api`: single request returning `{status, data}` (no hidden pagination, retry, fallback key, or write verification).
- `--data-file`: JSON **object encoded as `application/x-www-form-urlencoded` form data** (not `application/json`). Preserve exact field names; arrays require `[]` (e.g., `"categoryId[]": [12, 15]`); booleans -> `true`/`false`; `null` and nested objects rejected. `""` clears only fields explicitly supporting it; empty arrays send nothing and do not clear collections.
- `--param`: repeated query fields; auth fields (`apiKey`, `authorization`) rejected.
- `--write`: required for `POST`/`PATCH`/`PUT`/`DELETE` (accidental-write guard, not user authorization).
- `--upload-file`: multipart `file` field for `POST /space/attachment` only (exclusive with `--data-file`/`--output`).
- `--output`: writes `GET` bytes to a new file only (no overwrite, no raw binary stdout, buffered in memory—use a reviewed streaming client with identical guards for large files; never forward the API key to external URLs).
- Errors: sanitized JSON on stderr + nonzero exit. Ambiguous write/timeout -> read back before retrying; never repeat non-idempotent writes blindly. `401`/`403` -> stop without cycling keys; `404` -> verify target/visibility; `429` -> bounded wait from numeric `Retry-After`, `X-RateLimit-Reset`, or `/rateLimit`.

## Security & working discipline

- Validate the exact host before loading credentials; reject lookalike suffixes, userinfo, explicit ports, non-HTTPS URLs, and malformed hosts.
- Send `Backlog-API-Key` header only (never query strings, CLI args, Git remotes, or browser URLs) with redirects disabled.
- Keep API credentials separate from Git SSH auth/signing; do not inspect unrelated account data.
- Resolve target project metadata before writing (never reuse numeric IDs across projects/spaces); bulk or destructive mutations require an explicit bounded target set.

## API workflows

### Project metadata (read before mutations)

| Task | GET path |
|---|---|
| Resolve project | `/projects/{projectIdOrKey}` |
| List accessible projects (only if needed) | `/projects` |
| Statuses / issue types / users | `/projects/{projectIdOrKey}/statuses`, `/projects/{projectIdOrKey}/issueTypes`, `/projects/{projectIdOrKey}/users` |
| Categories / versions / custom fields | `/projects/{projectIdOrKey}/categories`, `/projects/{projectIdOrKey}/versions`, `/projects/{projectIdOrKey}/customFields` |
| Priorities | `/priorities` |
| Repositories | `/projects/{projectIdOrKey}/git/repositories` |

Scope numeric IDs to space and project, resolve ambiguous assignees before writing, and avoid listing the whole space when the target is known.

### Issues and comments

| Operation | Method/path |
|---|---|
| Read / search / count issues | `GET /issues/{issueIdOrKey}`, `GET /issues`, `GET /issues/count` |
| Create / update issue | `POST /issues`, `PATCH /issues/{issueIdOrKey}` |
| Read / count / add comments | `GET /issues/{issueIdOrKey}/comments`, `GET /issues/{issueIdOrKey}/comments/count`, `POST /issues/{issueIdOrKey}/comments` |

1. Read the current issue/comments or search duplicates (`projectId[]` + `keyword`, including closed unless excluded) and match project language/markup.
2. Resolve metadata and send minimal fields. Create requires `projectId`, `summary`, `issueTypeId`, `priorityId` (optional: `description`, `assigneeId`, `dueDate`, array fields); never invent IDs or unrequested dates.
3. Write non-trivial payloads to a JSON file (replace IDs with verified values):

```json
{"projectId":123,"summary":"Login redirect ignores destination","description":"Observed behavior and reproduction steps.","issueTypeId":456,"priorityId":3}
```

4. Mutate with `--method` + `--write`. Comment payload: `{"content":"..."}`. Notification lists must be explicit arrays of verified user IDs.
5. Verify via fresh `GET` comparing intended fields (distinguish status-change history from human comments). Report `https://HOST/view/ISSUE-123`; resolve close/reopen status IDs from the target project.

### Pagination (endpoint-specific)

- **Issues:** `count=100`, `offset=0`; advance `offset` by actual page length with fixed filters/sort, reconciling unique IDs against `/issues/count`. Note if concurrent edits skew totals.
- **Issue comments:** `count=100`, `order=asc`; advance `minId` from the highest returned ID, deduplicate boundary IDs, verify progress, and reconcile with `/comments/count` (do not use `offset`).
- **PRs & others:** PR lists use `count`/`offset` (check docs for PR comments); wikis and other endpoints may lack `count`/`offset`.
- Persist batches to task-local JSON/CSV, aggregate/dedupe/count in code, and report partial results explicitly if bounded or interrupted.

### Pull requests, review, and issue-to-PR

Let `R = /projects/{projectIdOrKey}/git/repositories/{repoIdOrName}`.

| Operation | Method/path |
|---|---|
| Read repository | `GET R` |
| List / create PR | `GET`/`POST R/pullRequests` |
| Read / update PR | `GET`/`PATCH R/pullRequests/{number}` |
| List / add PR comments | `GET`/`POST R/pullRequests/{number}/comments` |

- Read the PR, comments, and linked issue criteria; fetch Git refs and inspect the real diff against the base (title != diff).
- Creation: verify branches exist and check duplicates. Required: `summary`, `description`, `base`, `branch`. `issueId` is the numeric ID (not display key); optional `assigneeId`, `notifiedUserId[]`, `attachmentId[]` require verified targets.
- Issue-to-PR: implement, run tests, inspect final diff, push/create within scope, and read back the PR confirming base, branch, and issue link.
- Reviews & merges: Backlog has PR comments, not GitHub review states (never invent approve/request-changes endpoints); cite files/lines from the reviewed revision. Updating PR status does not merge Git commits—after an authorized merge, verify both remote commit ancestry and Backlog PR state.
- Never import GitHub assumptions (labels, Actions, draft PRs, approvals, auto-merge, `Closes #123`); CI evidence must come from the actual CI system for the exact revision.

### Wikis and attachments

- Endpoints: `GET /wikis` (`projectIdOrKey`), `GET /wikis/{wikiId}`, `POST /wikis`, `PATCH /wikis/{wikiId}`. Wiki availability depends on space/project (unavailable in new spaces; disabled by default in new projects)—missing wiki != wrong key; never enable without authorization.
- Read current content and markup mode, preserve unrelated content, check concurrent edits before writing, and read back afterward.
- Attachments: `POST /space/attachment` -> attach returned ID to parent issue/PR/wiki -> read back parent confirming ID/name/size (unattached uploads expire). Download issue attachments via `/issues/{issueIdOrKey}/attachments/{attachmentId}` with `--output`; use documented endpoints for wiki/PR/shared files.

### Shared files

- **Endpoints:** [Get List of Shared Files](https://developer.nulab.com/docs/backlog/api/2/get-list-of-shared-files/) (`GET /projects/{projectIdOrKey}/files/metadata/{path}`) and [Get File](https://developer.nulab.com/docs/backlog/api/2/get-file/) (`GET /projects/{projectIdOrKey}/files/{sharedFileId}`). Stay scoped to the linked path/project.
- **Pagination & download:** Paginate directories with `count=100`, `offset=0` (advancing by page length until exhausted), queue `type == "directory"` entries preserving `dir`/`name`, dedupe by `sharedFileId`, and download in-scope files by ID (`--output` to a new file).
- **Path encoding:** Percent-encode spaces/Unicode once per segment keeping `/` separators and query params separate. Because `scripts/backlog_api.py` rejects spaces, Unicode, and percent-encoding in `path`, use a scoped stdlib `GET` with `urllib.parse.quote(raw_path.strip('/'), safe='/')` after the validated `/files/metadata/` prefix when encoding is needed—preserving exact-host binding, `Backlog-API-Key` header, no redirects, timeouts, and sanitized errors (never treat local path rejection as an API permission failure).

## Evidence & verification

Keep a task-local record of hostname, resource IDs, requested changes, resulting IDs, and fresh read-back verification (never store keys/headers). HTTP 2xx or timeouts without read-back do not prove completion; for deletes, confirm disappearance in parent listings and rule out permission errors before treating `404` as deleted.

For offline helper regression tests, run `PYTHON SKILL/scripts/test_backlog_api.py` (unit tests verify local helper behavior only, not live permissions); verify live setup read-only via `auth` without creating temporary remote issues.

## Official documentation

- [API overview and endpoint index](https://developer.nulab.com/docs/backlog/)
- [Authentication, including Backlog-API-Key header](https://developer.nulab.com/docs/backlog/auth/)
- [Issue list and pagination](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)
- [Add issue / form fields](https://developer.nulab.com/docs/backlog/api/2/add-issue/)
- [Issue comment pagination](https://developer.nulab.com/docs/backlog/api/2/get-comment-list/)
- [Pull request list](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-list/)
- [Add pull request](https://developer.nulab.com/docs/backlog/api/2/add-pull-request/)
- [Wiki availability and listing](https://developer.nulab.com/docs/backlog/api/2/get-wiki-page-list/)
- [Attachment upload](https://developer.nulab.com/docs/backlog/api/2/post-attachment-file/)
- [Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/)
