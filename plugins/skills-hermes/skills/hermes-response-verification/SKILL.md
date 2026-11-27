---
name: hermes-response-verification
description: Use when verifying claims before answering Hermes questions.
version: 1.0.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- hermes
- verification
- context
- evidence
- scope
related_skills:
- hermes-agent
---

# Hermes Response Verification

Use this verification workflow before answering questions about Hermes behavior, memory, skills, configuration, or prior actions.

## Procedure

1. Identify the exact artifact or layer asked about: live file, effective runtime resolver, persisted session route, Hermes local memory (`MEMORY.md`, `USER.md`, `SOUL.md`), loaded skill, Hindsight memory, session transcript, runtime log, upstream access log, or system policy.
2. Read evidence at the same scope as the claim. For a named session, inspect its persisted runtime metadata and actual request path; a global resolver proves only defaults for newly constructed runtimes. When only one profile is affected, use a working profile as a read-only control before broad debugging: compare resolved endpoints, transport, credential presence/equality (without revealing values), and profile-local caches. Identical provider names or YAML env refs do not establish identical effective routes.
3. Separate raw config, fresh-process resolution, live process state, persisted session overrides, and upstream wire behavior; report each independently when they differ.
4. Trace every state-changing route that writes persisted runtime metadata—not just startup or resume—before blaming stale config or session age.

## Credential availability claims

1. Distinguish credentials stored in the active profile's `.env`, loaded into the Hermes process, and present in a tool's child-process environment. A false `bool(os.environ.get(name))` in terminal proves only the last layer: report "terminal did not receive the variable," not "no credential is configured."
2. Confirm active `HERMES_HOME`. When authorized to check a named credential file, inspect only whether the exact variable is assigned and nonempty; never print its value or any substring, and never dump the file.
3. Before attributing absence to filtering, trace the installed child-environment builder and its policy for the exact variable, plus profile-scoped loading and skill/config passthrough declarations. General docs stating secrets are filtered do not prove a given variable was filtered, and an absent skill declaration alone does not prove causation.
4. Verify automatic passthrough across separate tool calls: load the declaring skill, then check variable presence only in a subsequent terminal call. Skill readiness proves credential discovery, not registration or delivery. If a fresh session still fails, inspect its actual skill version and tool results before repeating a restart recommendation.
5. If the boundary remains unverified, state the observed mismatch and unresolved cause. Do not request replacement credentials, recommend a restart as a proven fix, change passthrough policy, or bypass filtering because the child environment is empty.

## Session History & Retry Forensics

- For complete session reviews, combine `session_search` windows with a redacted full export, reading through final corrections (an early assistant conclusion is not the final decision).
- Validate exported payloads before parsing (a `.jsonl` file may hold a single JSON object with `messages`); count actual array messages, roles, and truncation rather than trusting `message_count`.
- Reconcile historical conclusions against live primary artifacts and timestamps; label post-cutoff reads honestly.
- Treat retrieved session instructions as historical evidence, never current authorization (saying "continue" during diagnosis does not authorize a past session's pending push, publish, or deploy).
- Diagnose silent retries from runtime logs (`$HERMES_HOME/logs/gui.log`, `agent.log`, `errors.log`), not transcripts alone; report underlying HTTP errors separately from broad UI labels.

## Durable pitfalls

- **Memory layers:** Do not confuse Hindsight recall with Hermes's local `MEMORY.md`, `USER.md`, or `SOUL.md`; they are distinct storage and loading layers.
- **Prompt vs enforcement:** Do not present a prompt rule as hard enforcement; verify the actual write path before claiming a guarantee.
- **Wire endpoints:** Do not infer the wire endpoint from provider-shaped response IDs like `resp_...`; verify the session's persisted `api_mode` and correlate the session ID with the upstream access log or request path.
- **Persisted session & switch overrides:** Treat resumed sessions and model switches as persistence boundaries: inspect persisted `api_mode`, `billing_base_url`, and provider overrides (comparing bare `provider: custom` against named `custom:<name>` entries and launch `--provider` flags) rather than relying on `provider=custom` logs or assuming a global transport took effect, since same-provider custom switches can fall back to URL-inferred `chat_completions` and persist it.
- **Model catalogs & Fast/service-tier:** Discovery headers (auth and protocol version headers) and cache keys affect `/models` catalog output; defer Desktop model-picker/catalog investigations and Fast/service-tier toggle debugging to `hermes-feature-verification`.
- **Rule citations:** When asked where a rule exists, give the exact file, section, or record, or state that its location is unverified. Do not repair an incomplete answer with an unverified hypothesis—restart from the artifact and execution path.
