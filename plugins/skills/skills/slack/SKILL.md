---
name: slack
description: Use Slack's Web API for authenticated requests using browser-session tokens (xoxc/xoxd).
version: 0.3.6
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- slack
- api
- web-api
- messaging
related_skills: []
---

# Slack API

Use Slack's Web API documentation to resolve and execute authenticated HTTP API requests with browser-session tokens (`xoxc`/`xoxd`) without MCP or task-specific persistent helper scripts.

## Source and Authentication

Consult these documentation references:

- Guide: [`https://docs.slack.dev/apis/web-api.md`](https://docs.slack.dev/apis/web-api.md)
- Methods: [`https://docs.slack.dev/reference/methods.md`](https://docs.slack.dev/reference/methods.md)

Authentication uses an explicitly authorized browser session (not a bot-token recipe) with two matching tokens from the selected account/workspace contract:

- `SLACK_XOXC_TOKEN`
- `SLACK_XOXD_TOKEN`
- `SLACK_USER_AGENT` (optional): selects the approved client identity; otherwise the recipe uses a generic client identifier, not a hardcoded browser fingerprint.

Use this browser-session mode only for the explicitly authorized account/workspace and approved client contract. Do not substitute an unrelated bot/OAuth token, acquire another account's session, or switch profiles, accounts, or authentication modes on failure.

Follow **Profile & Environment** below before running requests; the recipe consumes supplied process values directly, and missing or empty required tokens block access.

Every request MUST include these headers together:

```text
Authorization: Bearer <SLACK_XOXC_TOKEN>
Cookie: d=<SLACK_XOXD_TOKEN>
```

Never expose tokens or persist extra copies during requests.

## Resolve the Operation

Do not load full Slack documentation pages into conversation context unnecessarily.

1. Fetch the relevant method page or reference with a web fetch tool with a bounded returned-text budget when signature details are needed.
2. Resolve the endpoint URL: `https://slack.com/api/<method>`.
3. Use GET for read methods that accept query parameters, or POST with `application/x-www-form-urlencoded` / `application/json` according to the method doc.
4. For permalinks like `https://<workspace>.slack.com/archives/<channel>/p<digits>` (including reply permalinks with query parameters), parse the URL path first, strip the leading `p`, and insert a decimal point exactly six digits before the end:
   ```python
   import urllib.parse

   raw = urllib.parse.urlsplit(permalink).path.rstrip("/").split("/")[-1].removeprefix("p")
   ts = f"{raw[:-6]}.{raw[-6:]}"
   ```
   Preserve every digit exactly. Do not hardcode or hand-transcribe timestamp examples.
5. Fetch the targeted message first:
   - Prefer `conversations.history?channel=<channel>&latest=<ts>&oldest=<ts>&inclusive=true&limit=1`.
   - Confirm the returned message `ts` equals the converted permalink timestamp before using its text or files.
   - If the message has `reply_count > 0` or a `thread_ts`, call `conversations.replies?channel=<channel>&ts=<thread_ts>` to inspect replies.
   - A reply permalink may return no messages from `conversations.history`. When its URL explicitly contains `thread_ts`, fetch and paginate that thread with `conversations.replies`, then verify that one reply's `ts` exactly matches the converted permalink timestamp. An empty history response alone does not establish that the linked reply is missing or inaccessible.
   - Read author names from the message's embedded `user_profile.real_name` or `user_profile.display_name` first; call `users.info` only for unresolved user IDs.
6. If the task involves a private file:
   - Inspect `files` on the target message.
   - Use `url_private_download` from the file object directly, or call `files.info` if metadata is missing.
   - After downloading office documents (`.pptx`, `.xlsx`, `.docx`, `.pdf`), inspect them using the matching domain skill or tool.

### Resolving `file_not_found` errors

Slack file IDs do not silently mutate; `files.info` returning `file_not_found` means the ID was mistyped, the file was deleted or replaced, or the session lacks access. Re-fetch the live parent message or thread, inspect its current `files[]` entries (comparing message `ts`, filename, and live file ID) before concluding deletion, then retry with the verified live ID/URL and verify binary integrity.

## Execute

Use a shell execution tool to run Python with the standard library:

```python
import json
import os
import urllib.parse
import urllib.request

xoxc = os.environ.get("SLACK_XOXC_TOKEN")
xoxd = os.environ.get("SLACK_XOXD_TOKEN")
if not (xoxc and xoxd):
    raise RuntimeError("Missing or empty required SLACK_XOXC_TOKEN or SLACK_XOXD_TOKEN")

headers = {
    "Authorization": f"Bearer {xoxc}",
    "Cookie": f"d={xoxd}",
    "User-Agent": os.environ.get("SLACK_USER_AGENT") or "AgentSkills-Slack/0.1",
}
```

Build the method URL, query parameters, POST body, and headers from the documented method. Send requests sequentially. Follow documented pagination via `response_metadata.next_cursor`.

For private file downloads, fetch `url_private_download` with the same `headers`. Warning: redirects in `urllib` can drop `Authorization` or return an HTTP 200 HTML login page—verify final HTTP status and MIME/magic bytes (never treat HTML sign-in pages as valid downloads), stream or write to a temporary file, verify byte size and format integrity, then rename to the final target path.

## Audit Threads a Participant Joined

- Resolve the authenticated user with `auth.test` and each channel's current `name` with `conversations.info` before searching. Use `search.messages` with `from:me in:#<channel-name>` for the authenticated participant (or `from:<@USER_ID> in:#<channel-name>` for another participant); verify every returned `user` and `channel.id`. Do not interpret zero results from `in:<channel-id>` or `in:<channel-name>` (missing `#`) as proof of no messages: resolve the channel name and retry with `in:#<channel-name>`.
- Paginate search results through `pagination.page_count`, persist matches, and deduplicate by `(channel.id, ts)`. Derive thread roots from `thread_ts` or the permalink's `thread_ts` query parameter; search hits for replies may expose the root only in the permalink. Fall back to the message's own `ts` only when neither is present.
- Fetch and cursor-paginate `conversations.replies` for every unique root, including later replies by other participants. Reconcile the unique fetched replies with the root's `reply_count` and the target's fetched messages with the search matches; investigate mismatches before claiming complete coverage.

## Evaluating Responses and Rate Limits

All Slack Web API responses return JSON containing:

```json
{"ok": true}
```

or:

```json
{"ok": false, "error": "..."}
```

- Always verify `ok == true`. Do not treat HTTP 200 alone as success.
- On error, report the Slack error code and method; never dump full responses or secrets.
- When Slack returns HTTP 429, read the `Retry-After` header, wait that duration, then retry. Do not retry blindly or flood the API with parallel requests.
- Only perform write or delete operations when explicitly requested. Verify mutations with the relevant read method when available.

## Report

Verify that the response matches the requested channel, thread, or file scope. Report the method, status, useful response data, and local file path/size without dumping sensitive message bodies or tokens.

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Variables (`.env`):** Required: `SLACK_XOXC_TOKEN`, `SLACK_XOXD_TOKEN`. Optional: `SLACK_USER_AGENT`.
- **Precedence & fallback:** Explicit caller-supplied process env wins by presence (including empty strings; empty required = error); otherwise read `{config_dir}/.env`. No host-default fallback when `default/slack` is absent.
