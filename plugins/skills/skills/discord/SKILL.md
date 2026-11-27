---
name: discord
description: Use Discord's OpenAPI spec and user-API docs for authenticated API requests.
version: 0.1.10
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- discord
- api
- openapi
- messaging
related_skills: []
---

# Discord API

Use Discord's current OpenAPI specification (with the user-API fallback docs for endpoints omitted from OpenAPI) to resolve and execute HTTP API requests. The bundled request recipe uses the raw `Authorization: <token>` header contract (`DISCORD_TOKEN`); separate Bot (`Bot <token>`) or OAuth (`Bearer <token>`) apps must use their own documented auth adapters.

## Source and Authentication

Use Discord's OpenAPI specification URL as the primary source (reuse a fresh cached copy when already fetched in the session or environment; fetch when missing or checking unfamiliar/changed endpoints):

```text
https://raw.githubusercontent.com/discord/discord-api-spec/refs/heads/main/specs/openapi.json
```

When a user-account operation or HTTP method is absent from `openapi.json` (for example, `GET /users/@me/channels`, `GET /users/@me/mentions`, or `GET /channels/{channel_id}/messages/search`), consult the unofficial community user-API documentation fork as a secondary source:

```text
https://raw.githubusercontent.com/tamntlib/discord-userdoccers/refs/heads/master/pages/resources/<resource>.mdx
```

- Common resource files: `channel.mdx`, `message.mdx`, `user.mdx`, `guild.mdx`, `relationships.mdx`, `notification-center.mdx`, `user-settings.mdx`. List available resource filenames via `https://api.github.com/repos/tamntlib/discord-userdoccers/contents/pages/resources` when unsure.
- Read the API base URL from `servers[0].url` in `openapi.json`.
- Follow **Profile & Environment** below before running the recipe (the recipe reads supplied process env only).
- `DISCORD_TOKEN` (required): uses the raw-header compatibility contract `headers={"Authorization": token}` only for an explicitly authorized account/action and client contract calling for a raw token. Preserve that contract—do not blindly prepend `Bot`/`Bearer`, infer token types, guess schemes, or cycle auth modes on failure. Separate bot or OAuth apps must use their own documented auth adapter; this recipe grants no selfbot/automation permission or extra scopes.
- `DISCORD_MY_USER_ID`: optional selected account ID.
- `DISCORD_USER_AGENT`: optional approved client identity via process env; otherwise use a generic client User-Agent (not an invented browser fingerprint).
- Never print, log, echo, trace, mask-dump, or copy any part of `DISCORD_TOKEN` (full, prefix, or suffix); check presence in memory only. If missing/empty after provisioning, stop and ask the caller to configure it in `{config_dir}/.env` (`~/.config/tamntlib-skills/{profile}/discord/.env`, where `{profile}` defaults to `default`).
- Never call `/users/@me` without explicit user permission (forbidden for setup, token checks, sanity checks, or background inspection).

## Resolve the Operation

The specification is large; do not load it into context in full:

1. Fetch it with a web fetch tool using a bounded text budget (or fall back to Python via shell to save and inspect selectively).
2. Search the saved file for the resource path, `operationId`, or schema, and read only the matching section.
3. For minified or large objects, use inline Python in the shell to print only the selected operation or referenced `$ref` components.
4. If the required path or HTTP method is absent from `openapi.json`, fetch only the matching `pages/resources/<resource>.mdx` file from `tamntlib/discord-userdoccers` (do not load full docs into context) and extract only the relevant `<RouteHeader method="..." url="..."/>` section and referenced schema definitions.

## Execute

Run Python with the standard library:

```python
import os
import urllib.request

settings = {name: os.environ[name] for name in ("DISCORD_TOKEN", "DISCORD_MY_USER_ID", "DISCORD_USER_AGENT") if name in os.environ}
token = settings.get("DISCORD_TOKEN")
if not token:
    raise RuntimeError("Missing or empty DISCORD_TOKEN")
headers = {
    "Authorization": token,
    "User-Agent": settings.get("DISCORD_USER_AGENT", "AgentSkills-Discord/0.1"),
}
# Add "Content-Type": "application/json" only when sending a JSON body (omit for GET or multipart).
request = urllib.request.Request("<BASE_URL>/<PATH>", method="<METHOD>", headers=headers)
response = urllib.request.urlopen(request)
```

Build method, URL, parameters, headers, and JSON body from the selected OpenAPI operation (or the matching fallback doc section when absent from OpenAPI). Keep auth and `User-Agent` headers on every request, use only fields documented in the selected source, send requests sequentially, and follow documented pagination.

## Rate Limits

Inspect `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix timestamp), `X-RateLimit-Reset-After` (seconds), and `X-RateLimit-Bucket` when present.

On HTTP `429`, wait the exact `Retry-After` or JSON `retry_after` duration before retrying (no blind retries or parallel requests). If `X-RateLimit-Remaining` is `0`, wait `X-RateLimit-Reset-After` before the next request.

Perform writes or deletes only when explicitly requested, and verify mutations with the corresponding `GET` when available.

## Report

Confirm the operation matches the fetched spec (or explicitly label it as unofficial/community-documented when resolved from the user-API fallback fork) and requested scope. Report operation, status, useful data, and limitations without dumping large responses or secrets.

Whenever a message is sent or created (new message, reply, or thread message), include its direct Discord link:
- Guild channel / thread: `https://discord.com/channels/<guild_id>/<channel_id>/<message_id>` (obtain `guild_id` from `GET /channels/{channel_id}` or known channel metadata—REST `POST /channels/{channel_id}/messages` responses omit `guild_id`).
- Direct message (DM): `https://discord.com/channels/@me/<channel_id>/<message_id>`.

## Pitfalls

- Treat the fetched OpenAPI spec as the primary source of truth, falling back to `tamntlib/discord-userdoccers` only for user-account operations/methods absent from `openapi.json` (reverse-engineered client endpoints may change or differ from official bot routes); preserve Discord IDs and literal values exactly; distinguish auth, permission, validation, and rate-limit errors.
- Fetch messages via `around` for user tokens: use `GET /channels/{channel_id}/messages?around={message_id}&limit=...` instead of `GET /channels/{channel_id}/messages/{message_id}`—user tokens often receive HTTP 403 on the single-message endpoint in guild channels, while `around` succeeds and returns surrounding context.
- Webhook status codes: both plain JSON and `multipart/form-data` webhook posts without `?wait=true` return HTTP `204 No Content`, whereas `?wait=true` returns HTTP `200 OK` with the created message object. Accept both `200` and `204` (e.g., `response.status in (200, 204)` with stdlib `urllib.request`, which raises `HTTPError` on non-2xx responses) when `?wait=true` is optional, and expect `200` when passing `?wait=true`.
- Validate attachment payloads: avoid uploading empty (0-byte) attachments; verify non-empty content before adding files to a multipart request.

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Variables (`.env`):** Required: `DISCORD_TOKEN`. Optional: `DISCORD_MY_USER_ID`, `DISCORD_USER_AGENT` (promote any operation-mandatory variable to required first).
- **Precedence & fallback:** Explicit caller-supplied process env wins by presence (including empty strings; empty required = error); otherwise read `{config_dir}/.env`. No host-default fallback when `default/discord` is absent. Provisioning grants no `/users/@me` or write authority.
