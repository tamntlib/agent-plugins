---
name: microsoft-graph
description: Use when calling Microsoft Graph via Python SDK.
version: 0.4.6
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- microsoft-graph
- api
- oauth
- python
related_skills: []
---

# Microsoft Graph

Use official Microsoft auth libraries and the Graph Python SDK as a base. Discover the required API per task, then run task-local Python scripts outside this skill directory. Never accumulate task-specific commands or business workflows here.

## When to Use

Access Microsoft Graph resources (files, SharePoint, Teams, mail, calendars, workbooks) via Python.

### Scope & Authority Boundaries
- Loading this skill or holding a cached token grants no authority to inspect accounts, initiate login, change tenant/app settings, broaden scopes, switch to application permissions, create client secrets, request admin consent, or perform remote writes.
- Resolve Personal/Work account type, target tenant, cloud, app registration, and minimal task scopes explicitly; never silently switch accounts, tenants, or saved configuration.
- Remote writes require an explicitly approved target, content, and scope.

## Prerequisites

- Python 3.10+ with `msgraph-sdk` and `azure-identity`, plus network access to the matching Microsoft identity and Graph endpoints.
- Explicitly selected app registration, tenant, account, and permission set.
- Reuse a suitable existing venv; if dependencies are missing, get approval and install into an isolated venv without touching system Python or unrelated projects.

## Profile & Environment

- **Config dir:** Resolve `{profile}` in order: explicit task profile -> `AGENT_PROFILE` -> active session/workspace profile context, then use `{config_dir}` = `~/.config/tamntlib-skills/{profile}/{skill}`.
  - **Active profile present:** Use `{config_dir}` and fail closed if missing/invalid—never fall back to `default`, another profile, or host defaults.
  - **No profile active (`default`):** Use `~/.config/tamntlib-skills/default/{skill}` if present; otherwise apply the skill-specific fallback below (or fail closed if none).
- **Secret handling:** Read `{config_dir}` files only inside the execution runtime (never via chat-returning file-read tools) and parse `.env` literally as `KEY=value` (do not shell-source). Pass credentials only via in-memory settings or a scoped child env—never in CLI args, logs, or chat output. Keep newly created config dirs at `0700` and credential files at `0600`.

### Skill-specific settings

- **Variables (`.env`):** Required non-secret context IDs: `MSGRAPH_CLIENT_ID` (selected app registration) and `MSGRAPH_TENANT_ID` (selected auth authority). Delegated device-code flow has no access-token or client-secret env var.
- **Precedence & fallback:** Explicit caller-supplied process env wins by presence (including empty strings; empty required = error); otherwise read `{config_dir}/.env`. No host-default fallback when `default/microsoft-graph` is absent.
- **Account record file:** Store serialized `AuthenticationRecord` metadata at `{config_dir}/auth_record.json` (`0600` permissions; or `{config_dir}/auth_record.<account_alias>.json` when one profile uses multiple accounts).

### Authority Selection Rules

`MSGRAPH_TENANT_ID` accepts aliases (`consumers`, `organizations`, `common`) as well as tenant UUIDs—do not enforce UUID-only validation. The returned `AuthenticationRecord` carries the concrete tenant ID rather than the alias. Pass `consumers` explicitly for Personal tasks (never silently inherit a Work or registration tenant) and reserve `common` for approved account-choice flows.

## Workflow

1. Resolve account type (Personal vs. Work), account, auth authority, app registration, cloud, and exact targets. The same email can map to distinct Personal and Work accounts—never infer type from email domain or app owner, and keep registration tenant distinct from resource tenant.
2. Check official Microsoft Graph docs for the exact method, path, API version, delegated/app support, permissions, request fields, pagination, and response semantics.
3. Reuse the approved SDK persistent cache and selected `AuthenticationRecord`; run interactive auth only when required and approved.
4. Write a temporary SDK script outside this skill directory, run it in the isolated venv with bounded runtime/scope, and verify results honestly.

## App Registration and Consent

For a reusable owned app, support both Work and Personal accounts unless narrower audience is required:

1. In Manifest `api`, set `requestedAccessTokenVersion` to `2` and save before changing supported account types (preserving other fields). Registration validation requires this for Personal accounts; the v2 OAuth endpoint alone does not satisfy it.
2. Select **Any Entra ID Tenant + Personal Microsoft accounts** (`signInAudience: AzureADandPersonalMicrosoftAccount`). `AzureADMultipleOrgs` excludes Personal; use `PersonalMicrosoftAccount` only when Personal-only restriction is intended.
3. Delegated dynamic consent does not require pre-populating **API permissions** in the portal—requesting documented scopes in OAuth prompts user consent directly. Configured portal permissions are neither consent nor granted token scopes, and adding them does not refresh existing tokens (acquire a token with the new scope).

Dynamic consent excludes application permissions, static consent, `.default`, and tenant-wide admin consent. If enabling Personal fails validation, check manifest limits (including max `30` configured permissions per resource) rather than disabling Personal support.

## Authentication

Prefer delegated authentication for user-scoped tasks.

### Context Gate

- Preserve account type, account, cloud, owned app registration (never a library built-in dev app), and resource scope across follow-ups; stop on preflight mismatch (`personal` -> `consumers`; `work` -> selected resource tenant or `organizations`).
- Post-login, validate `record.client_id`, `record.authority`, concrete `record.tenant_id`, and account identity (`record.home_account_id` from an approved prior record, or `record.username` against the explicitly selected account on first use) before any Graph call. Authority aliases never waive concrete tenant verification; stop on mismatch rather than calling profile/inventory endpoints to guess who signed in.
- Request only minimal documented scopes (no broad bundles or `.default` shortcuts). Use an approved alternative if tenant policy blocks a flow rather than weakening Conditional Access.

Use `DeviceCodeCredential` with `disable_automatic_authentication=True` in ordinary scripts so cache misses never trigger unexpected login. Match the Graph auth provider's CAE mode: by default `is_cae_enabled=True` caches CAE tokens separately from non-CAE tokens, so call `credential.authenticate(scopes=task_scopes, enable_cae=True)` for explicit login. If login succeeds but Graph raises `AuthenticationRequiredError`, check CAE mode, scopes, and account before blaming consent or policy—a local cache miss is not a Graph `403`.

### Device Code User Handoff

- Supply `prompt_callback` and send `verification_uri` (validated HTTPS on the expected Microsoft verification origin for the selected cloud), `user_code`, and expiry in plain text; Device Code requires neither terminal input nor a localhost callback. (For auth-code flows, verify browser localhost reaches the callback handler.)
- Display only the live user-facing `user_code` for that approved sign-in; never expose internal `device_code`, full OAuth responses, passwords, MFA codes, auth codes, or tokens, and ask the user to verify app, account, and scopes on Microsoft's page before approving.
- Never persist temporary user codes in skills, memory, scripts, CLI args, or reports; on expiry, start a fresh approved challenge.

## Basic Client

Bootstrap for fixed-account-type scripts: reads required process env vars, enforces explicit `profile`, `account_type` (`personal`/`work`), and task scopes, and returns the SDK client and credential with profile-isolated persistent caching (post-login Context Gate still applies). Pass a validated `authentication_record` for ordinary reuse; reserve `prompt_callback` for approved login.

```python
import os
from azure.identity import DeviceCodeCredential, TokenCachePersistenceOptions
from msgraph import GraphServiceClient


def make_client(*, profile, scopes, account_type, authentication_record=None,
                cache_persistence_options=None, prompt_callback=None):
    if not isinstance(profile, str) or not profile.strip() or "/" in profile or "\\" in profile or profile.strip() in {".", ".."}:
        raise ValueError("Pass the resolved active profile name (e.g., 'personal', 'work', or 'default')")
    if isinstance(scopes, str) or not scopes:
        raise ValueError("Pass the documented task scopes as a non-empty list")
    if account_type not in {"personal", "work"}:
        raise ValueError("Resolve account_type explicitly: personal or work")
    values = {}
    for name in ("MSGRAPH_CLIENT_ID", "MSGRAPH_TENANT_ID"):
        value = os.environ.get(name, "").strip()
        if not value:
            raise RuntimeError(f"Missing or empty required environment variable: {name}")
        values[name] = value
    authority = values["MSGRAPH_TENANT_ID"]
    if account_type == "personal" and authority != "consumers":
        raise RuntimeError("Personal task requires consumers in the selected child environment")
    if account_type == "work" and authority in {"consumers", "common"}:
        raise RuntimeError("Work task requires organizations or the selected resource tenant")
    if cache_persistence_options is None:
        cache_persistence_options = TokenCachePersistenceOptions(name=f"microsoft-graph-{profile.strip()}")
    credential = DeviceCodeCredential(
        client_id=values["MSGRAPH_CLIENT_ID"],
        tenant_id=values["MSGRAPH_TENANT_ID"],
        authentication_record=authentication_record,
        cache_persistence_options=cache_persistence_options,
        disable_automatic_authentication=True,
        prompt_callback=prompt_callback,
    )
    return GraphServiceClient(credentials=credential, scopes=scopes), credential
```

Keep identical preflight and post-login checks in custom adapters or direct credential calls. Inspect installed SDK source/examples for async method signatures. For endpoints missing from the SDK, use a normal HTTP client with the same official credential (keeping bearer tokens in memory—never implement custom OAuth/refresh handling). For non-public Microsoft clouds, configure both identity authority and Graph endpoint from docs without mixing clouds.

## Session Reuse

Use SDK-managed persistent MSAL caching (`TokenCachePersistenceOptions`) rather than per-task memory-only login; let the SDK manage serialization, locking, reload, and refresh instead of writing custom token files.

- **Cache name & location:** Parameterize the cache name by the resolved active profile (`TokenCachePersistenceOptions(name=f"microsoft-graph-{profile}")`) so distinct profiles (e.g., `personal` vs. `work`) never share a token cache and stay isolated from shared `msal.cache`. Reuse the same profile-scoped name across processes and always validate the target account independently (one named cache can hold multiple accounts within a profile). Let the SDK pick its native path outside repositories, skill directories, scratch dirs, and agent config homes (Linux default marker area: `~/.IdentityService/`; with LibSecret, Secret Service may store the encrypted payload separately). Never copy, parse, or commit the SDK cache.
- **Account record:** After the Context Gate passes, save `AuthenticationRecord.serialize()` to `{config_dir}/auth_record.json` (or `{config_dir}/auth_record.<account_alias>.json` when one profile uses multiple accounts) with owner-only `0600` permissions inside the `0700` `{config_dir}` (the SDK does not auto-save records; keep records outside repositories, skill dirs, and scratch dirs). Reload via `AuthenticationRecord.deserialize()`, validate account/app/authority/tenant, and pass as `authentication_record` with auto-auth disabled and matching CAE mode. Never inspect raw token caches to discover accounts.
- **Encryption & reuse verification:** Keep platform encryption enabled by default; if unavailable, report the blocker rather than silently falling back to memory-only, installing services, or enabling plaintext (`allow_unencrypted_storage=True` requires explicit approval and owner-only files). Verify reuse in a separate process without prompting; persistence does not prevent reauth on revocation, expiry, policy changes, or new consent.

## API Execution

- Default to Graph `v1.0`; use `/beta` only when required and limitations are accepted.
- Keep account/resource IDs explicit; never call profile or inventory endpoints as unrelated auth smoke tests.
- Follow pagination to the requested boundary; treat next-page links as opaque, validate the Graph origin, and track partial failures.
- Distinguish `401`, `403`, throttling, and validation errors (a permission failure is not an empty result). Respect `Retry-After`, check SDK retry behavior before mutations, and inspect every sub-response inside Graph batches.
- Handle `202 Accepted` as pending and follow status endpoints where required. Fetch redirected preauthenticated download URLs with a separate unauthenticated request—never forward Graph bearer tokens to another host or log signed URLs.
- Never dump HTTP headers, raw auth exceptions, SDK debug logs, tokens, or partial/masked credentials. Classify operations semantically, not by HTTP verb alone.

## Writes and Verification

After any approved write, read back the exact target to confirm fields and reconcile uncertain outcomes before retrying. Verify file integrity/size/hash metadata, deduplicate collections by stable IDs, and compute declared totals programmatically.

Distinguish four verification boundaries and report only what was actually exercised: (1) local config/syntax checks, (2) successful authentication, (3) permission to call the requested API, and (4) verified end-to-end task completion.

## External Documentation

Fetch only docs relevant to the current task:

- Graph API: https://learn.microsoft.com/en-us/graph/api/overview
- Python SDK: https://github.com/microsoftgraph/msgraph-sdk-python
- Device authorization protocol and user-facing code:
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
- Device-code authentication:
  https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.devicecodecredential
- Persistent cache:
  https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.tokencachepersistenceoptions
- Account record:
  https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.authenticationrecord
- Authority discovery and account types:
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
- Permissions:
  https://learn.microsoft.com/en-us/graph/permissions-reference
- Account types and registration validation:
  https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation
- Manifest `api.requestedAccessTokenVersion`:
  https://learn.microsoft.com/en-us/graph/api/resources/apiapplication
- Static and dynamic consent:
  https://learn.microsoft.com/en-us/entra/identity-platform/consent-types-developer
