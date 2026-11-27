---
name: agent-corrective-action
description: Trigger immediately whenever the agent retracts a claim, apologizes for an error, or confirms any mistake (code, command, factual claim, or flawed design/recommendation) to fix it, find the root cause, and prevent recurrence (proposing agent-level changes for user approval).
version: 0.2.0
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- agents
- corrective-action
- root-cause
- recurrence-prevention
- capa
related_skills: []
---

# Agent Corrective Action

When you confirm you made **any** mistake—whether in code, commands, factual claims, or a flawed design/recommendation—act in the **same turn**; do not stop at an apology, excuse, or future promise. Fix the affected task result within your current scope, find the evidence-backed root cause, and prevent recurrence (CAPA). **Any change that modifies the agent itself (skills, memory, agent config, profiles, or global rules) must be proposed for user approval rather than applied automatically.**

## 1. Confirm & Fix the Task Result
- Verify the mismatch from direct evidence (files, commands, tool outputs). Do not concede blindly to a challenge, and separate your own error from external tool or system failures.
- Correct the wrong claim, output, or in-scope task artifact immediately within existing task permissions, and verify the fix by live readback.

## 2. Find the Root Cause (RCA)
Trace what actually caused the mistake using direct evidence—never guess or stop at vague excuses like "oversight":
- **Backward trace:** Walk back from the wrong output to the exact tool call, assumption, input, code path, or instruction read/missed.
- **Evidence-backed 5 Whys:** Ask "why" along observed facts until you hit an actionable root cause (missing validation, conflicting rule, missing check, bad design/assumption).
- **Differential check:** Compare working vs. failing cases (or before vs. after changes) when relevant.
- **Root-cause test:** Ask *"If this cause is closed, can the same class of mistake still happen another way?"* If yes, dig deeper. If evidence is insufficient, state clearly what remains unknown.

## 3. Prevent Recurrence (Match Action to Cause & Boundary)
Separate **in-task engineering prevention** from **agent-level changes**:
- **In-scope code/project prevention (apply & verify now):** When the root cause is a code/script defect within the authorized task, add a focused regression test, validation guard, or check alongside the fix and verify both.
- **Agent-level prevention (mandatory check; propose only — wait for user approval):** Always evaluate whether preventing recurrence requires updating **skills, memory, agent config, profiles, hooks, or global rules**. Never skip this check silently, and **never** apply agent-level edits automatically: if warranted, propose the exact target, concrete edit (fixing/replacing weak, unreachable, or conflicting wording/triggers—or adding a deterministic check/hook—rather than piling on duplicate warnings), and how it blocks recurrence.
- **Reachability & specificity gate before claiming "no change needed":** Never dismiss an improvement just because a related sentence exists somewhere on disk. Before concluding existing rules are adequate (one-off skip), inspect the relevant skill, rule, or config directly **and** prove both: (1) **reachability**—it was actually mounted and triggered/loaded in the failing agent and task flow (not buried in another runtime's plugin or an on-demand skill whose trigger did not fire), and (2) **operational specificity**—it names the concrete failure mode or check without conflicting instructions, rather than relying on a broad slogan that failed to prevent the mistake. If a rule was unreachable, vague, conflicting, or violated repeatedly while active in context, do not stamp it "already covered": propose closing the trigger gap, tightening/replacing the vague phrasing in place, or adding a deterministic guard/hook/test instead of piling on duplicate prose.
- **Blocked (outside task permissions, protected upstream file, or unresolved cause):** Never bypass boundaries—state the exact blocker and proposed action.

## 4. Verify & Report
Close concisely in the same turn with:
1. **Root cause** (evidence-backed chain, or unresolved gap)
2. **Fix & verification** (what was corrected and verified now)
3. **Recurrence prevention:** in-task guard/test applied, plus an explicit **agent-level decision**—either a concrete proposed skill/memory/config edit awaiting user approval, or why no agent-level change is needed.

If the user approves a proposed agent-level change, apply it, verify it separately, and report the verified result.
