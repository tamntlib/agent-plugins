---
name: minimal-override-configuration
description: Use when auditing/pruning overrides, resolving precedence, or default changes.
version: 1.9.0
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- configuration
- defaults
- overrides
- cleanup
- migration
- validation
---

# Minimal-Override Configuration

Remove redundant overrides, resolve disputed configuration precedence, or choose between a local override and a canonical default change. A literal single-value edit is not a request to prune adjacent keys, migrate storage layers, or fan out changes to other instances. Read-only precedence explanations never imply artifact generation or deployment.

Keep this skill product-independent. Product-specific commands, configuration keys, storage layouts, and lifecycle rules belong in the owning product or domain skill; load that skill alongside this one when implementation details are needed.

Configuration instances are isolated unless the installed loader proves otherwise. Value equality classifies entries; it never authorizes fan-out. Name the user-authorized instance set before any multi-instance write, including every consumer affected by shared administrator policy.

## Core Rule

Do not copy every documented option into a config file. Resolve the actual default in the installed version, then keep only meaningful overrides.

Minimal does not mean speculative deletion. Removing a key as redundant requires proof that the correct fallback supplies the same effective value. An explicit unwanted-setting deletion may intentionally change behavior; state the verified inherited value and any concrete safety risk.

## Default-Resolution Layers

For every candidate key, identify which layer supplies it and which wins. This is a layer checklist, not a universal precedence order:

1. command-line or runtime override;
2. profile or project config;
3. environment variable or secret store;
4. plugin or application default in installed code/schema;
5. upstream service default.

Never equate an upstream service default with a client or plugin default — the client may always send its own value.

## Preserve the Requested Configuration Layer

Treat the storage mechanism as part of execution scope. Before changing a value, identify its owning source and the installed loader's real precedence. If asked to change an existing `.env` variable, edit that variable directly; do not turn a one-field update into a YAML migration, new override layer, or architecture change unless requested.

A preferred long-term layout is not permission to normalize adjacent config. Moving a setting between `.env`, YAML, a service-manager environment, or administrator policy is a separate change that can alter precedence, upgrade behavior, and operator expectations. When the existing layer works and the request is literal, make the smallest edit there. If activation is requested, restart only an authorized consumer that caches the value and verify effective behavior; otherwise report the offline verification boundary.

## Reuse the Existing Operational Path

Before introducing a workflow, credential, token file, or config variable, trace the existing `source file -> renderer -> transport -> apply/import job -> runtime consumer` path, including its current authentication source. If that path already performs the update, modify its input and add regression coverage instead of building a parallel deployment mechanism. Disclose existing deployment side effects; they never authorize inventing a second control plane.

## Override Review and Pruning

For a quick config sanity check, inspect the named file directly using only the nearby schema or resolver needed to verify syntax, references, and obvious inconsistencies. Do not expand into a repo-wide or live-service audit unless requested; a short check should produce a short, file-grounded answer, not a release gate.

Separate proven defects from intentional policy choices. Missing fallback coverage or overlapping wildcards are questions to flag, not automatic bugs; once the user confirms intent, preserve it instead of repeatedly proposing fixes. Never infer runtime wildcard precedence from declaration order alone.

For requested candidate keys, establish the owning layer, installed reader/default, and omission semantics. Record a before/after decision table when reviewing multiple removals; a single-value edit needs no whole-config inventory. Preserve intentional modes, endpoints, scopes, security policies, resource limits, compatibility pins, and operational metadata. When disabling a feature or authentication provider, inspect and update dependent directives or authorization gates together so partial removal does not leave dangling requirements.

An audit returns candidates and evidence without modifying files. For authorized cleanup, apply only verified removals through the supported writer, validate syntax and effective values, and reconcile exact changed paths. Requested safe local validation may proceed without repeated approval. Exercise affected behavior when claiming runtime equivalence or activation; if only offline validation was requested or available, state that limit instead of restarting unrelated services.

## Presence-Sensitive Keys and Schema Metadata

Absence from a central defaults map does not prove a key is unused; inspect extension, compatibility, and component-specific readers, and verify omission through the real resolver before claiming equivalence. Not every value equal to a runtime default is removable: schema or version markers may be operational metadata whose removal triggers spurious migration checks, so verify metadata keys with the installed validator and retain the minimal marker needed for a clean current-version status. Config cleanup never authorizes credential migration, unrelated data cleanup, or unrequested restarts; if removing a literal secret in favor of an environment reference is separately authorized, verify the scoped secret exists and matches without printing it before editing.

## Changing the Canonical Default

If the desired value differs from the application's current default, choose explicitly:

- **Local override:** keep the key in config. Safest; survives upstream code changes.
- **Product-level default change:** update source, schema, docs, and tests so the key can be omitted everywhere. Use only when the user wants that value as the canonical default for this installation or fork.

Never remove a key while leaving an incompatible application default underneath — that creates clean-looking config with wrong runtime behavior.

When changing a product-level default, update all representations together:

- runtime initialization and fallback paths;
- environment fallback;
- configuration schema and UI;
- setup wizard or generated config;
- documentation and examples;
- tests for omitted-key behavior.

Trace CLI/parser defaults and direct-backend defaults separately before editing constants: an adapter may supply a value hiding an unchanged backend fallback. Add regressions for omitted arguments through both entrypoints and for explicit overrides; inspect mocked request payloads, not merely constants or help text. Leave sibling commands unchanged when they already have the requested defaults.

## Upgrade Tradeoff

Minimal configs deliberately inherit future default changes, reducing stale duplication while potentially changing behavior on upgrade. Preserve an explicit override when stability outweighs inheriting future defaults — especially for security, data isolation, retention, destructive behavior, or resource limits.

## Destructive Migrations

Config cleanup and data recreation are separate state changes. Before deleting data or volumes:

- verify explicit authorization and backup intent;
- stop at the approval boundary if confirmation is not granted;
- never report migration complete when only config files changed;
- after recreation, verify service health, effective default, and a semantic acceptance case.

## Verification

Match evidence to the requested claim:

- **Review:** report source-grounded candidates, owning layers, and unresolved precedence; no cleanup implied.
- **Offline edit:** verify syntax, intended path changes, installed-version fallback/resolver behavior, retained intentional overrides, and schema metadata.
- **Runtime activation/equivalence:** additionally verify affected consumer health and one semantic behavior probe at the activation boundary. Restart only an authorized consumer that caches the changed value; a valid file alone is not activation.

Keep intentional pins or user state even when equal to today's default. Report exact removals and future-default inheritance separately.

## Default Resolution Checklist

Use one row per candidate key:

| Key | Current value | Winning source | Installed default | Semantic risk if omitted | Decision |
|---|---|---|---|---|---|
| example | value | profile config | value | low | remove |

Checks:

- Is the installed version known?
- Does CLI or environment override config?
- Does the client send a value even when config omits it?
- Is the value a security, isolation, retention, destructive, or resource boundary?
- Should upgrades inherit new defaults, or must behavior stay pinned?
- If changing the canonical default, were runtime, schema, setup, docs, and tests updated together?
- Was the effective value inspected after cleanup?
- Was behavior tested, not only syntax?
- Does activation require a new session or process restart?
