---
name: facebook
description: Use when accessing Facebook through session-based APIs.
version: 0.1.5
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- facebook
- graphql
- api-first
- search
- browser-session
related_skills: []
---

# Facebook API

Resolve and execute authorized Facebook web API operations from live request contracts. Prefer thin reusable transport and task-specific Python over MCP, browser clicking, full scraper stacks, or one permanent command per feature. This is an unofficial browser-session interface, not the public Graph API.

## When to Use

- Read or search Facebook posts, comments, profiles, pages, or group content via an authorized session.
- Investigate a Facebook operation or verify a client library's claimed support.
- Distinguish Facebook content search from Messenger conversations before selecting a transport.

Read-only unless explicitly authorized: credential possession never grants permission to post, comment, message, join groups, or modify account state.

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Variables (`.env`):** Required: `FB_COOKIES` (complete authorized cookie string from the request `Cookie` header—`document.cookie` omits `HttpOnly` cookies) and `FB_DTSG`. Optional: `FB_LSD` (provision only when required by the operation).
- **Precedence & fallback:** Explicit caller-supplied process env wins by presence (including empty strings; empty required = error); otherwise read `{config_dir}/.env`. No host-default fallback when `default/facebook` is absent.
- **Mode & isolation:** Internal web-session mode only (not public Graph API); never silently switch modes or broaden account access. Session acquisition is user-driven via an approved secure channel (never ask for cookies/tokens in chat). Isolate dependency installation from credentials (never pass secrets to package installers or build steps) and keep TLS verification enabled.

## Procedure

### 1. Establish resource and action

Parse the URL, target IDs, query, and requested operation, preserving IDs and query text verbatim. Distinguish group posts/comments, global search/filters, and Messenger chats/E2EE history. Always use the current target rather than library examples: `filter_type="group"` searches group names rather than posts inside one group, and a self-authored-post filter is not a sent-messages search.

### 2. Inspect reference client source first

Inspect reference source at a resolved commit (discovery entry points, not immutable contracts):

- Session, transport, and discovery: https://github.com/XD-MHLOO/facebook-gql-scraper (`facebookGraphql.py`, `facebookOperationDiscovery.py`, `unifiedFacebookParser.py`)
- Group feed and search/filter semantics: https://github.com/MEOMcGill/fbscrape (`docs/endpoints/group_timeline.md`, `search.md`, `search_filters.md`, `adding_endpoints.md`)
- Persisted queries and incremental responses: https://github.com/rust-works/omni-dev/blob/main/docs/recipes/browser-bridge-facebook.md

Resolve the current commit SHA via standard unauthenticated HTTPS/Git (`gh api` is optional if already configured):

```bash
git ls-remote https://github.com/XD-MHLOO/facebook-gql-scraper.git refs/heads/main
```

Fetch needed files at that SHA via unauthenticated HTTPS/raw URLs or a shallow checkout, saving large files to task scratch (keep out of tool output) and reading runtime/dependency needs from source. Inspect the reference request builder's session, bootstrap, discovery, and POST flow to confirm current headers and form fields before writing a thin HTTP client (or optionally adapting a reference client); never execute copied shell commands blindly. For Messenger tasks, see **Messenger Protocol and Capability Boundaries** first.

### 3. Construct a settings-backed HTTP session

After **Profile & Environment**, load required values from the scoped process environment into memory:

```python
import os

settings = {name: os.environ[name] for name in ("FB_COOKIES", "FB_DTSG", "FB_LSD") if name in os.environ}
for name in ("FB_COOKIES", "FB_DTSG"):
    if not settings.get(name):
        raise RuntimeError("Missing or empty " + name)
```

- Parse `settings["FB_COOKIES"]` (splitting each `name=value` pair at the first `=` only) into your HTTP session's cookie jar with an explicit approved Facebook domain and path—never attach a domainless cookie dict when the session also fetches CDN scripts. Keep `fb_dtsg` (and `lsd` when required) in memory only; disable on-disk state persistence unless explicitly authorized.
- Enforce transport guards on requests and redirects: HTTPS only, exact approved Facebook hosts for authenticated calls, anonymous allowlisted CDN script fetches (strip `Cookie`, `Authorization`, and session-token headers on every anonymous request), and finite timeouts/request budgets. Keep any retained auth-bearing responses private.
- *Optional reference-client pattern (`facebook-gql-scraper`):* If reusing `FacebookContext` from a resolved commit instead of a thin standalone HTTP client, subclass it without modifying upstream source—e.g., overriding internal hooks such as `_load_cookies` (domain-scoped cookie loading) and `_load_state` / `_save_state` (no-ops when persistence is unauthorized) and setting `context.fb_dtsg = settings["FB_DTSG"]` up front, after verifying private hook names against that exact commit.

### 4. Discover persisted operations and derive variables

Discover current persisted `doc_id` values and initial variables against the authorized target page (never a hardcoded example):

- Fetch the target page HTML and linked JS bundles (using anonymous requests for CDN bundles) to resolve persisted operation IDs from `_facebookRelayOperation`, `.graphql` (`params.id`), and `$Parameters` (`params.id`) modules—either directly with a thin parser or via an optional reference-client discovery helper (such as `facebook-gql-scraper`'s `operation_discovery.discover_operation(target_url)`). HTML/JS GET is bootstrap only, not an API substitute; on failure, classify whether navigation, auth, script fetch, JS evaluation, or missing operation failed.
- Parse `application/json` script blocks with an HTML + JSON parser (never eval arbitrary snippets or dump full HTML) and select the preloader (`queryName`, `queryID`, `variables`) matching the requested scope and query. Preserve captured scope/config/provider flags, assert target and query before dispatch, and permit only read operations for read-only tasks (no recent-search mutations).
- `SearchCometResultsInitialResultsQuery`: use the discovered/preloaded query ID (`doc_id`) and initial variables.
- `SearchCometResultsPaginatedResultsQuery`: merge cursor and pagination parameters while preserving captured group scope, group ID, and search text instead of overwriting them with global-search defaults (when using `facebook-gql-scraper`, avoid `SearchEngine.search(..., filter_type="group")` for group posts, as it searches group entities).

### 5. Execute a bounded API probe

Send a bounded `POST` with form-encoded `doc_id`, JSON-serialized `variables`, `fb_dtsg`, `__comet_req`, and `__a` (plus `lsd` or `fb_api_req_friendly_name` when required by the operation) to the resolved GraphQL endpoint (commonly `https://web.facebook.com/api/graphql/`; report the actual endpoint host selected and never relabel it `www.facebook.com`). Start with one page and fetch a second only when needed for pagination and permitted by rate limits. If using `facebook-gql-scraper`'s `FacebookContext.post(...)`, inspect its signature at the pinned commit before passing options such as `_retry=False`.

### 6. Inspect raw responses, parse, and classify errors

- **Response framing:** Check application errors even on HTTP 200 or `text/html` `Content-Type`. Strip any `for (;;);` prefix, parse JSON or JSONL incremental chunks, and reject non-JSON error pages rather than treating them as empty.
- **Raw edges vs wrapper parsing:** Compare raw `edges`/story counts against parsed records (empty wrapper output != empty search). If a reference parser drops stories present in raw `edges`, adapt extraction from the live response, validate returned group IDs and canonical links against scope, and record the mismatch. Distinguish server-ranked results from literal body-text matches, reading authors from returned metadata unless unresolved.
- **Pagination cursors:** Inspect `page_info.has_next_page` and `end_cursor` across relevant chunks (attachment/substream cursors != result-set cursor).
- **Error classification:** Diagnose from `errors[]`, codes, HTTP status, and headers—not wrapper exception names alone. Code `1675004` (`Rate limit exceeded`) is an application rate limit, not expired cookies. If using a reference client (for example, `facebook-gql-scraper`, where internal checks such as `_check_session_dead` can raise `SessionExpiredError` from headers before body inspection), retain a sanitized response summary in the transport layer so body error codes remain diagnosable.
- **Rate limits:** Stop concurrent probes and automatic auth refresh; honor `Retry-After`/cooldown, or preserve partial results and mark remaining pagination unverified. Never retry blindly, parallelize probes, rotate identities, or auto-retry ambiguous writes.

## Messenger Protocol and Capability Boundaries

Applies to DMs, group chats, self-chat, and conversation history search:

- **Protocol distinction:** Messenger uses a separate transport/model from Facebook feed/group APIs (self-authored post search != sent-messages search; global search != mailbox search).
- **Reference implementations:** Inspect https://github.com/mautrix/meta (`pkg/messagix`, E2EE setup, `ROADMAP.md`) and https://github.com/m008v/fbchat-v2 (session/messaging docs, `bridge-e2ee/README.md`) to verify callable operations directly in code.
- **E2EE requirements:** Encrypted threads may require device keys, persistent private state, WebSocket transport, and an initialized cryptographic session beyond cookies; reuse a protocol client rather than improvising stateless HTTP calls, and never silently fall back to plaintext.
- **History & local indexing:** Check current upstream history/backup support; receiving live decrypted events does not grant older history, and local indexes must report exact synchronized threads and time ranges rather than claiming full-account search.
- **Sending & self-chat:** Separate authorized mutation requiring live recipient/thread resolution and readback; do not assume self-chat works by passing the viewer ID to a generic send method.
- **Capability boundaries:** Distinguish source-code expectations from live-verified behavior and state untested boundaries explicitly.

## Pitfalls

- Public Graph API != internal web operations (different auth and contracts).
- Persisted query IDs and provider flags rotate; never cache them indefinitely.
- Never substitute a wrapper's success flag or exception label for raw response evidence.
- Never log raw cookies, tokens, prepared requests, auth-bearing HTML, or raw response dumps; store necessary private artifacts only in task-local files with restrictive permissions/ACLs.

## Verification and Reporting

Capability claims require a real scoped API response with identifiable records or an explicitly verified empty response. Verify and report separately:

1. Bootstrap and operation discovery;
2. Authenticated identity where relevant (public data != logged-in session proof);
3. Scoped initial API POST (exact method, host, operation, target/query, counts, result links);
4. Parser fidelity (raw `edges` vs parsed records) and pagination state (`has_next_page=true` != complete dataset);
5. Untested Messenger, pagination, or mutation boundaries.

Perform mutations only when explicitly requested and verify the exact remote target via readback. Never alter unrelated services or configuration to run a read-only probe.
