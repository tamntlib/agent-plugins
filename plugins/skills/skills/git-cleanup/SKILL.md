---
name: git-cleanup
description: Use when cleaning Git worktrees, stashes and branches.
version: 0.5.1
author: tamntlib
license: Apache-2.0
platforms:
- linux
- macos
- windows
tags:
- git
- worktree
- stash
- branches
- cleanup
- safety
related_skills: []
---

# Git Cleanup

## When to Use

Inventory and clean linked worktrees, stashes, local branches, and disposable worktree caches. Not an instruction to run `git clean`. Loading this skill starts read-only inventory, not deletion.

## Preserve Requested Cleanup Scope

- Unless the user narrows scope, inventory and plan linked worktrees, stashes, and local branches together; do not silently omit worktrees or default to a narrower subset.
- Give every linked worktree an explicit disposition (**propose removal**, **retain by user request**, or **blocked**) with its exact path, reason, preservation or occupancy prerequisites, and next unblocking action. The main checkout is never a removal candidate.
- Present the complete requested cleanup plan plus blockers before asking for confirmation. Offer a safe partial cleanup only as an explicitly labeled option showing omitted work and consequences, and never ask blanket approval for uninspected targets.

## Mandatory Preview and Confirmation

1. **Inspect first, no mutations:** Resolve the repository root, main checkout, and linked worktrees at runtime using read-only shell/git commands. Perform zero fetches, stashes, branch switches, backups, or deletions during inventory.
2. **List every proposed operation before asking:** Exact worktree and cache paths, stash refs with immutable object IDs, every local branch name and HEAD, preservation steps, any new stash/branch/backup, and intended final checkout; clearly mark what stays and what is blocked. Never hide targets behind counts, wildcards, ellipses, or “and others”; for large inventories, attach a complete manifest with a readable summary.
3. **Request explicit user confirmation:** Present choices matching the full requested scope, including blocked targets and pending decisions. Wait for explicit confirmation before mutating, even if the user said “clean all.” Allow subset selection or cancellation, and confirm the target integration branch and final checkout whenever safety depends on them.
4. **Bind approval to identities and state:** Record paths, branch/HEAD, dirty/untracked/ignored state, stash object IDs, and active occupancy. Recheck immediately before each operation; stop affected operations on drift and present a revised manifest. Never widen scope silently or substitute another stash after ordinal shifts.

## Read-Only Inventory

Run read-only shell/git commands on the resolved repository:
- `git worktree list --porcelain` — main checkout, linked paths, branches or detached HEAD, and locks.
- `git status --short --untracked-files=all` per checkout; `git ls-files --others --ignored --exclude-standard`; `git submodule status` plus submodule working state where present.
- `git stash list --format='%gd%x09%H%x09%ci%x09%gs'` — every stash, object ID, timestamp, and description; inspect changed paths/stats (including untracked parent) without printing secret contents.
- `git for-each-ref --format='%(refname)%09%(objectname)%09%(upstream)%09%(upstream:track)' refs/heads` — including release, backup, and checked-out local branches. Compare candidates against the selected integration branch and upstream; remember cached remote-tracking refs reflect the last fetch, not necessarily the current remote.
- Check whether any active shell, process, editor, or agent session is running inside or beneath any target linked worktree.

For each candidate, state whether commits or working changes would lose their last named ref, whether a verified retained ref contains them, and whether the path or branch is actively in use. A detached HEAD already reachable from a retained branch or tag needs no extra preservation branch; otherwise propose an approved preservation ref or explicitly state the commit-loss risk before confirmation.

## Active Workspace Safety

- Before removing a linked worktree or switching the main checkout's branch, check whether any active shell, running process, or agent session uses that directory or a descendant path.
- Treat an actively occupied worktree as blocked; never silently terminate running processes or force-remove an in-use directory.
- After the user closes or relocates dependent processes/sessions, recheck occupancy immediately before running `git worktree remove`.

## Execute Only Approved Categories

### Linked Worktrees

1. Never remove the main checkout or an actively occupied worktree.
2. For approved preservation, run `git -C <worktree> stash push -u -m <label>`, record the new stash object ID, and verify tracked and untracked coverage. Stashes are shared across all worktrees and omit ignored files and submodule working changes—back up required omitted data only with explicit approval, or stop. Never blindly pass `-a`.
3. Recheck recorded state, stash coverage, and workspace occupancy; from outside the target worktree, run `git -C <main> worktree remove <path>` without `--force`. Investigate any refusal rather than bypassing it.
4. List disposable ignored caches (such as `.pytest_cache/` or `.ruff_cache/`) explicitly as deletion effects in the preview rather than treating them as implicitly safe. Never delete other ignored, untracked, private config, or credential files without itemized approval, and never implicitly remove parent scratch directories or sibling artifacts.

### Stashes

1. Delete only approved stash object IDs. Re-read `git stash list` and resolve each approved SHA to its current `stash@{n}` immediately before `git stash drop <ref>`, because ordinals shift after every drop.
2. Prefer individual `git stash drop` calls over `git stash clear`. Verify exact remaining stash object IDs and confirm unapproved stashes remain intact.
3. Keep any preservation stash created during this run unless its deletion was separately previewed and approved; never create a stash solely to drop it.

### Local Branches

1. Include backup branches in inventory; never assume a branch is redundant because a release branch was squashed or the name looks old. Identify commits unreachable from remaining refs, warn before deleting last named refs, and require explicit approval covering any loss.
2. Recheck worktree occupancy; never force-delete a branch checked out in another worktree.
3. Keep the current branch unless it qualifies for **Return from Merged Current Branch** below or deletion was explicitly requested. When the current branch differs from the established integration branch, is verified merged into it, and has no unpreserved changes needing separation, propose switching to the integration branch and deleting the current branch in the same manifest (while honoring explicit retention requests). If an approved manifest deletes all local branches, explicitly preview that the checkout will become detached at its exact current commit, then run `git switch --detach <recorded-HEAD>` after confirmation without resetting files.
4. Use `git branch -d -- <approved-name>` when applicable; use `-D` only when the preview explicitly covered unmerged or backup deletion and preservation/loss. Stop on unexpected refusal instead of auto-escalating to `-D`.
5. Never recreate a deleted branch unless requested. If a later request asks to recreate it from a verified remote-tracking ref, verify branch name, upstream, HEAD, and working-tree state afterward.

### Return from Merged Current Branch

- Resolve the target integration branch from user and repository context (for example, `main` or `develop`); never guess from the current branch name alone. Confirm the current (source) branch differs from the integration branch, and record source HEAD, local integration HEAD, and the exact integration commit used as merge evidence.
- Verify containment with `git merge-base --is-ancestor <source-HEAD> <integration-commit>`. A matching upstream ref or an older commit does not prove uncommitted changes are merged. Label cached remote-tracking evidence honestly; if freshness matters, request a scoped fetch rather than fetching during inventory.
- For squash or rebase merges, require separate evidence linking the exact source HEAD to the merged change and accounting for unmatched commits; a merged PR label or similar tree alone never authorizes `git branch -D`.
- Preview the destination branch, final HEAD, merge evidence, and preservation/restoration steps in the confirmation manifest. If the local integration branch lags the verified integration commit, preview an explicit `--ff-only` update (old and new commits) and block on divergence rather than silently resetting or merging.
- Resolve dirty, untracked, and ignored files before switching so source edits are not silently carried onto the integration branch; obtain approval for any required stash, omitted-data backup, or restoration target, and verify no active process or worktree occupancy conflicts with the switch.
- After approval, recheck recorded refs, merge evidence, working-tree state, and occupancy; run approved preservation, then `git switch <integration-branch>` (without force/discard) and any approved `git merge --ff-only <recorded-integration-commit>`.
- Verify the destination branch, HEAD, and preserved data before deleting the approved source branch per the Local Branches rules; stop on drift, conflict, or refusal instead of escalating to `-D`.
- Confirm afterward that the source branch ref is gone, the checkout is on the approved integration branch at the expected commit, and preserved stashes, untracked data, remote-tracking refs, and tags match the plan.

## Excluded Unless Separately Requested and Previewed

Remote branch deletion or push, tag deletion, fetch/prune, reflog expiration, garbage collection, `git reset --hard`, broad `git clean`, deleting repository contents, or modifying unrelated checkouts. Retain config and secret files untouched, never read secret contents during inventory, and never create hidden backups that undermine a confirmed deletion.

## Verification and Report

- Confirm approved worktree directories and registrations are gone, and that preserved refs and preservation stashes remain intact unless approved for deletion.
- Read back exact remaining stash object IDs and local branch names, computing counts from the readback lists. Verify final branch or detached HEAD, working tree, index, remote-tracking refs, and tags match the approved plan.
- Report deleted paths, stashes, and branches, retained items, final checkout state, and any unperformed categories. Distinguish **approved operations completed** from **original cleanup goal completed** when a subset was chosen, and list the disposition and next prerequisite for any remaining linked worktrees. Cleanup implies no push, merge, publication, or deployment.

## Pitfalls

- Confirmation binds strictly to the previewed manifest—a generic "yes" never authorizes newly discovered targets.
- Removing a worktree, deleting its branch, and dropping its stash are separate approved operations.
- Never claim a branch is safely on the remote solely from a cached `origin/...` ref, or treat squashed backup commits as redundant without checking reachability.
- Avoid creating unnecessary safety refs for already-reachable commits, but never silently discard the last named ref to unmerged work.
