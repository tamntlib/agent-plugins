---
name: hermes-configuration-maintenance
description: Use when editing or pruning Hermes configuration.
version: 0.1.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- hermes
- configuration
- defaults
- pruning
- secrets
- activation
related_skills:
- hermes-agent
- minimal-override-configuration
---

# Hermes Configuration Maintenance

Maintain named Hermes profile configuration without altering unrelated values, storage layers, or running consumers. Use `minimal-override-configuration` for product-independent defaults/precedence and `hermes-agent` for supported commands, docs, and installed readers; this skill owns Hermes execution.

## Scope and universal invariants

- **In scope:** Edit/prune overrides, provider fields, and presence-sensitive generated state; resolve API listener YAML-vs-env precedence; verify primary-provider fallbacks; tune timeouts; and externalize explicitly requested MCP credentials.
- **Excluded / separate scopes:** Cross-profile sharing, Managed Scope, and multi-profile or multiplex gateway restarts are separate scopes (never infer multi-profile authority from equal values). Excludes memory hygiene, storage migration, and unrequested skill edits.
- **Target resolution:** Run `hermes profile list` and `hermes -p <id> config path`. Pass the internal profile selector (not display label) to `-p`, never assume the default home, resolve symlinks/shared storage before writing, and obtain owner authority before exceeding the named target.
- **Scope, secret, and activation boundaries:** Separate read, write, credential-migration, and lifecycle/restart scopes. Neither config edits nor discovering literal secrets grants restart authority or permission to prune adjacent keys. Never print secrets, parser excerpts, or credential structures, and never disable `security.redact_secrets`. Never kill interactive CLI/TUI sessions or restart unrelated services. Offline writes and parse checks never prove live activation — report **pending next-start activation; live state unverified** whenever the owning consumer is not restarted in scope.

## Core edit and verification procedure

1. **Raw read and rollback:** Parse profile YAML with a duplicate-key-safe loader; record intended paths and owner-only rollback material. Installed source overrides docs and CLI help for exact defaults and precedence.
2. **Trace the winning reader:** Preserve the requested storage layer; an existing `.env` assignment never justifies adding a competing YAML override. For timeouts, inspect explicit caps and competing request/stale deadlines first so longer windows are not silently clamped or preempted.
3. **Classify removals:** Separate exact installed defaults, verified alternate-reader fallbacks, inactive/legacy keys, and explicit user-requested deletions (never label the latter three as exact defaults). Keep `_config_version`, stability/security pins, user presets, and presence-sensitive state unless removal is requested and understood.
4. **Scoped writes:** Use `hermes -p <id> config set/unset` or the verified Hermes env writer. Resolve informal setting names from installed defaults/readers rather than guessing key paths. Keep literal IDs, and write root `model.default`, provider-entry default model, per-model `models` metadata, and `agent.reasoning_effort` separately (e.g., `model.default: example.model-v1` and `agent.reasoning_effort: medium`).
5. **Dual readback and consumer checks:**
   - Read raw YAML and `hermes config get` separately. On disagreement, stop treating the edit as active and inspect profile selection, managed/shared config, snapshots, overlays, or caches before running behavior tests.
   - Diff unrelated keys, run profile `hermes config check`, and test raw-presence behavior via the real resolver (not merged CLI output alone).
   - Verify exact resolved provider, model, endpoint/transport, and task-specific routing metadata rather than generic feature success (auxiliary tasks like approval, compression, and title generation resolve independently).
   - On existing/resumed sessions, inspect persisted runtime route (`provider`, `base_url`, `api_mode`) before blaming global config — explicit session overrides persist across turns. Treat snapshots as rollback evidence unless proven read by the running process.
6. **Activation lifecycle:** Fresh-process resolution does not prove a running consumer updated. Classify each edited key from installed source and restart only the authorized owner when activation is in scope (verify multiplex or cross-profile ownership separately before restarting any shared service):

| Activation boundary | Typical keys / consumers | Verification after authorized activation |
|---|---|---|
| **Next read / next turn** | Mtime-keyed raw-config caches read per request or turn | Confirm call path reloads each turn/request |
| **New session / agent** | Model, tool schemas, prompts, reasoning cached in `AIAgent` | Check cache signature/busting; open new session or recreate agent |
| **Service restart** | Listener ports, adapters, webhooks, env credentials, stdio MCP | Restart authorized owner; probe health + one scoped behavior |
| **Browser frontend** | UI-cached values or backend session state | Reload or reconnect client only if UI caches the value |

## Default pruning and targeted provider-field removal

### Candidate generation and presence-sensitive leads

- Compare raw profile YAML leaves against `DEFAULT_CONFIG` from installed `hermes_cli.config_defaults` (type-sensitive; prune lists only if full configured list equals full default list) and compute candidate counts programmatically.
- Keep despite equality: `_config_version` (required by `hermes config check`), stability pins, security/isolation/retention/compatibility boundaries, and generated inventory lists unless omission behaves identically.
- Absence from `DEFAULT_CONFIG` does not mean unused: inspect dataclasses, gateway resolvers, CLI compat code, plugins, setup flows, and tool constants for `providers` (and legacy `custom_providers` if present in older profiles), `platform_toolsets`, `known_*_toolsets`, `session_reset`, `group_sessions_per_user`, and `onboarding.seen`.
- Test single-key and combined removals in memory via the real resolver, reporting **same now** separately from **same after upgrades**:
  - `platform_toolsets.<platform>` presence is authoritative (omission follows platform composite + future defaults; explicit `platform_toolsets.discord: [hermes-discord]` can opt into default-off `discord` and `discord_admin` toolsets). Run `_get_platform_tools` (or installed equivalent) on current vs proposed config per stored platform.
  - `known_plugin_toolsets` and `known_builtin_toolsets` are generated bookkeeping preserving user opt-outs across upgrades; removing them abandons opt-out preservation.
  - Recheck historical leads (e.g., `agent.verbose`) against active readers before pruning without confusing them with `agent.reasoning_effort`, `display.show_reasoning`, or `display.tool_progress`.
  - User-defined `agent.personalities` presets are intentional overrides even when unselected by `display.personality` or `/personality <name>`; delete only when explicitly unwanted (using the supported writer and stating inherited behavior).

### Targeted provider-field removal

Resolve profile, provider key, and target field from fresh raw YAML. Use the canonical `providers.<name>...` mapping schema (falling back to legacy `custom_providers.<index>...` only if an older profile still uses the list schema; verify CLI dotted-ID handling first):

```bash
hermes -p <profile> config unset 'providers.<name>.models.example.model-v1.web_search'
hermes -p <profile> config unset 'providers.<name>.default_model'
```

Remove only the requested field (removing `default_model` or legacy `model` must preserve per-model `models` metadata and root `model.default`). Read back `providers` and root `model`, run profile `hermes config check`, and compare the real resolver with/without the field before claiming routing equivalence. Provider `web_search` capability is separate from Hermes's independent web-search tool.

### Pruning mutation and verification

Unset reviewed paths via `hermes config unset section.key` (preserves formatting and cleans empty parent maps) and restore `_config_version` via `hermes config set _config_version <current>` if needed. Verify: (1) `hermes config check` passes with no migration warning; (2) re-running the raw-YAML-vs-`DEFAULT_CONFIG` walk leaves zero unexplained candidates; (3) representative retained overrides read back via `hermes config get ... --json`; and (4) removal totals reconcile programmatically against the mutated key list.

## API server binding and environment precedence

Inspect installed `gateway/config.py`: where YAML loads before `API_SERVER_HOST`, `API_SERVER_PORT`, and `API_SERVER_KEY` env values, an existing `API_SERVER_HOST` in `$HERMES_HOME/.env` overrides `gateway.api_server.host`. Verify load order and prove effective binding on the live listener after an authorized restart, not `hermes config get` alone.

- **Minimal mutation:** If `API_SERVER_HOST` owns binding, update only that var via the Hermes env writer (delete only a task-owned ineffective YAML key if introduced); migrating `.env` → YAML is separate explicit work requiring clearing the env var. If YAML shows the target host while `ss` shows `127.0.0.1`, fix `API_SERVER_HOST` in the active profile `.env`.
- **Authorized restart and listener check** (owning gateway only):

```bash
ss -ltnp '( sport = :8642 )'
curl -fsS --connect-timeout 3 --max-time 10 http://127.0.0.1:8642/health
curl -fsS --connect-timeout 3 --max-time 10 http://<overlay-ip>:8642/health
```

- Confirm authenticated endpoints reject unauthenticated calls (typically HTTP `401`). For wildcard binds (`0.0.0.0:<port>`), inspect firewall scope without changing firewall rules unless separately authorized.

## Primary-provider fallback verification

1. Resolve target profile home and raw `config.yaml`, confirming the live consumer uses the same `$HERMES_HOME`.
2. Each `fallback_providers` entry needs non-empty `provider` AND `model`; missing either is silently discarded. Read the normalized chain via `hermes fallback list` or installed `get_fallback_chain()`.
3. Resolve every candidate via the installed runtime resolver, printing only sanitized fields:

```python
from urllib.parse import urlsplit
from hermes_cli.runtime_provider import resolve_runtime_provider

rt = resolve_runtime_provider(
    requested="custom-provider-name",
    target_model="fallback-model",
)
url = urlsplit(rt.get("base_url", ""))
print(rt.get("provider"), rt.get("api_mode"), url.hostname, url.path)
print(bool(rt.get("api_key")))
```

4. Probe `/models` on catalog-backed endpoints to confirm model IDs exist (routing metadata only, not live inference/failover proof). Same-provider fallbacks cover model-route failures only, not endpoint, network, or shared-credential failures. Never force primary failure for a read-only question; `hermes config check` does not prove fallback resolution.

| Entry | Parser | Runtime meaning |
|---|---|---|
| `model` only | Discarded | No fallback entry |
| Named custom provider + model | Retained | Resolves provider endpoint, key source, and API mode |
| `provider: auto` + model | Retained | Auto-detection (does not inherit main provider; may fail on custom-only config or pick a provider lacking the model ID) |
| Built-in provider + model | Retained | Resolves built-in provider credentials and endpoint |

## MCP secret externalization

Use only when explicitly requested for literals under `mcp_servers.<name>.env`. Hermes filters stdio MCP subprocess environments (safe baseline, trusted external-secret vars, and explicit server `env`), so `.env` alone does not expose variables to MCP subprocesses. Migrate:

```yaml
mcp_servers:
  service:
    env:
      SERVICE_TOKEN: literal-secret
```

to:

```yaml
mcp_servers:
  service:
    env:
      SERVICE_TOKEN: ${env:SERVICE_TOKEN}
```

with `SERVICE_TOKEN` in the same profile `.env`. Prefer `${env:VAR}` over `${VAR}` and keep the key unless the server no longer needs it.

1. Parse `config.yaml` for key paths, types, and ref status; compare against `.env` in memory printing only `match`, `different`, or `missing`. Keep the literal if absent/different until intended source is confirmed.
2. Copy missing values atomically into `.env` (preserving unrelated lines, without CLI args, logs, chat, or shell history), replace only `mcp_servers.<name>.env.<KEY>` with `${env:<KEY>}`, and enforce owner-only `0600` permissions on both files.
3. Re-parse and verify in memory: env reference set, `.env` var present, profile-scoped interpolation yields a non-placeholder value, and zero old literals remain anywhere in raw config.
4. On authorized activation, restarting the owning backend recreates stdio MCP children; verify owner health and scoped MCP startup/auth. If a placeholder remains, fix profile scoping or var name; on auth failure, distinguish wrong credentials from missing subprocess vars using in-memory checks and sanitized MCP stderr.

## Timeout settings

- **Task-scoped auxiliary timeout:** `auxiliary.<task>.no_progress_timeout` is task-scoped rather than a global default; check the installed reader to confirm retry and fallback propagation.
- **Responses first-event timeout:** Governs the main Codex/Responses first-event watchdog (including named custom providers), distinct from auxiliary no-progress, post-event idle, and total request timeouts:
  1. Resolve profile/session effective `api_mode`, provider, model, and reasoning effort; trace the installed first-event resolver and competing deadline layers.
  2. Inspect relevant numeric assignments and permissions in profile `.env`. Check BOTH `HERMES_CODEX_TTFB_TIMEOUT_SECONDS` and `HERMES_CODEX_TTFB_MAX_SECONDS` (raising the former alone stays clamped by the latter); preserve explicit caps unless raising is required.
  3. Confirm CLI routing to the env writer and apply:

```bash
hermes -p <profile> config set HERMES_CODEX_TTFB_TIMEOUT_SECONDS <seconds>
hermes -p <profile> config set HERMES_CODEX_TTFB_MAX_SECONDS <seconds>
```

  Apply the second only if an explicit cap blocks the target value. Never invent YAML keys for `os.getenv` readers, and store only old numeric values as rollback (never duplicate credential-bearing `.env`).
  4. Read back via `config get`, confirm no duplicate definitions and unchanged unrelated `.env`/`config.yaml` bytes, and run profile `hermes config check`.
  5. Run installed `_resolve_nonstream_watchdogs` in a fresh offline process (loading profile `.env` in memory) with the affected transport, reasoning config, synthetic context size, and stale-timeout calculation to confirm shorter budgets do not preempt the increase.
  6. Active watchdogs retain request-start values; verify `/reload` or `reload.env` RPC, reload only when authorized, and test a subsequent request. A longer window extends silent wait and postpones retry — it does not fix an endpoint failing to return HTTP headers.

## Reporting and Pitfalls

**Avoid:** Treating `DEFAULT_CONFIG` absence as unused; deleting `_config_version`; inferring raw-presence or live state from `config.yaml`, snapshots, or `config get` alone; dropping MCP env refs; inferring an auxiliary model from main model or generic feature success; or claiming completion while `hermes config check` fails.

**Report separately** (omit irrelevant layers):
- **Target & delta:** Profile/paths, key names, secret match status, final values/refs, programmatic removal counts, intentional exceptions, retained override categories, permissions, rollback info.
- **Verification:** Raw file value, effective resolver (`config get`/`config check`), persisted session override, behavior/wire/interpolation probe, unchanged unrelated state.
- **Activation:** Lifecycle boundary, authorized restarts/reloads run, unverified live consumers, and next authorized action if layers disagree.
