---
name: authorization-aware-execution
description: Use when permission or execution scope is unclear, or on mid-execution course corrections, pause, cancellation, or reversal.
version: 1.2.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- authorization
- intent
- approvals
- state-change
- communication
- course-correction
- cancellation
- rollback
---

# Authorization-Aware Execution

Use when requested action, target, side effects, or continuation authority is unclear, or when the user narrows, challenges, pauses, or reverses an ongoing task. Do not load as ceremony before every ordinary file write.

## Interpret the Requested Outcome

A question about truth or whether a change would be better is not permission to implement it. Conversely, an execution request can be phrased as a question ("Can you fix this?"). Judge from the full message and active task contract, not a verb whitelist.

| Intent | Permitted work |
|---|---|
| Explain, inspect, audit, compare | Read evidence and produce the answer/report; do not remediate audited targets |
| Plan, draft, propose | Create the local artifact; do not execute the plan or send the draft |
| Fix, build, run, update | Perform the scoped action plus necessary safe task-local edits, disposable fixtures, and verification |
| Conditional action | Execute only the named branch after proving its prerequisite |
| Corrective question after completion | Answer the discrepancy; do not infer a repair request unless also asked |

Permission to write an audit report does not authorize rewriting audited instructions; fixing local code does not authorize publishing it. When the requested outcome explicitly entails bounded publication (e.g., opening a specified PR), honor that scope without demanding an extra verb, while still excluding merges, unrelated pushes, visibility changes, or history rewrites. Repository and user approval or release gates remain binding.

## Resolve the Meaningful Boundary

Before a consequential write, verify:
- exact target and ownership, including shared files and symlinks;
- whether the side effect is necessary for the requested outcome or an unrelated improvement;
- whether production, credentials, paid APIs, persistent setup, other environments/accounts, deletion, or published history are involved;
- latest constraints and any prerequisite that must pass first.

When clear and authorized, proceed through verification without asking at every step. When ambiguity affects authority, major scope, or an irreversible decision, ask one focused question or batch independent decisions. Continue safe independent authorized work and report what is blocked instead of guessing or expanding scope. Never bypass a tool approval denial or timeout without fresh authorization.

## Corrections and Unauthorized Mutations

Answer corrective questions directly, explain the discrepancy briefly, and offer the specific repair if an action was unauthorized.

When an unauthorized mutation already occurred, state it plainly and preserve evidence; never compound it with unapproved rollback. Learning a guardrail never authorizes editing the agent itself—any change to skills, memory, agent config, profiles, hooks, or global rules must always be proposed to the user and applied only after explicit user approval (honoring any read-only exclusions).

## Mid-Execution Course Correction

Apply when a newer instruction changes method, scope, or continuation state after an authorized task begins—especially when processes or external records may outlive files.

### Core rule

Any mid-execution user message or interruption supersedes the prior branch immediately; apply it at arrival as a direct instruction, not passive tool output. Stop advancing the old branch before another mutation, keeping completed work only while compatible with the new scope.

### Change types and verification

| Change type | Meaning | Verification required |
|---|---|---|
| **Constraint change** | Same objective, different method or newly prohibited mechanism | Prove old mechanism is absent/unused and replacement is active |
| **Scope narrowing** | Continue only for the reduced target | Prove no out-of-scope target changed after narrowing |
| **Pause** | Stop mutations and wait (not cancellation) | Prove no task process continues unintentionally |
| **Cancellation** | Stop future work and leave current state as-is unless reversal is requested | Prove no task process continues unintentionally |
| **Reversal** | Restore pre-task state within explicitly requested scope | Prove task-created state is removed/restored and unrelated state remains intact |

### Freeze and re-plan

Before another state change:
1. Stop writes, installs, builds, starts, credential collection, and config changes for the old approach; never finish a nearly done old step for convenience.
2. Separate already-created artifacts from planned actions, and mark superseded checklist items cancelled rather than completed.
3. Stop an old-branch long-running process only when cancellation or reversal authorizes it; otherwise report and ask.
4. Classify each affected artifact as reusable unchanged, reusable after modification, incompatible and removable, or pre-existing (outside rollback scope); adapt the smallest safe set without layering replacements over obsolete task-created scaffolding.

### Cancellation vs reversal

- Prohibiting a mechanism changes method; it does not cancel the objective.
- Stopping or cancelling halts future work; it does not authorize deletion.
- Reversal requires explicit terms (`revert`, `undo`, `remove what you created`) and covers task-owned changes only, never a broad workspace reset.
- Files created and later removed are still performed actions; report the verified final state rather than claiming nothing happened.

For an authorized reversal: inventory task-owned files, directories, services, processes, dependencies, credentials, and external records; restore or remove only those targets while preserving pre-existing state (including similarly named files); avoid broad cleanup commands when exact targets exist; stop and ask if ownership is unclear; verify final target state.

Report separately: what instruction changed; what was stopped, reused, modified, or removed; what was verified; and what was never installed, started, configured, or collected. Never claim full rollback while a task-created process, dependency, service, credential, or external record remains.

## Completion

Complete the authorized outcome and relevant checks, then report what changed, what was verified, and what remains blocked. Read back the exact target for external writes. Preserve pre-existing work and distinguish performed actions from proposals. A green test, model confidence, available credentials, or an easy fix never creates authority outside the task.
