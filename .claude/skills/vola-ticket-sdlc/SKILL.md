---
name: vola-ticket-sdlc
description: The full VOLA per-ticket delivery pipeline — claim, worktree, implement, history entry, review gate, PR, CI counting, merge policy, board sync, cleanup. Use when starting work on a board ticket, opening or updating a PR, deciding whether to merge, or wiring the dev engine's run loop to mirror what sessions do by hand.
---

This is the pipeline VOLA tickets actually go through — not an aspiration.
It matches the N141–N188 history entries step for step, and every trap named
below has already fired at least once. CLAUDE.md's hard-rule sections are the
authority; this skill is the ordered checklist those sections add up to.

## The pipeline

1. **Claim before writing anything.** Read the board, then
   `gh issue edit <n> --add-assignee @me` AND set board Status → In Progress
   — both, together, at the moment work starts. Check the in-progress cap
   first: the number lives in `.vola-agent/policy.json`
   (`max_tickets_in_progress`), never in prose. If every slot is taken,
   queue — a queued ticket stays Todo/unassigned, which is true.
   If the ticket doesn't exist yet, allocate the next id by scanning ALL
   issues (open and closed) AND open PR titles; never fill a gap.

2. **Worktree from origin/main.** `git fetch origin` first; branch under
   `.claude/worktrees/<short-name>`; never the primary checkout; clean tree
   at both ends. Migration numbers are claimed at REBASE time, strictly above
   origin/main's highest.

3. **Implement with the repo's testing discipline** — see the
   `vola-testing` skill for what's mandatory per change type, and CLAUDE.md's
   "own the library rows you depend on" for backend fixtures.

4. **Mutation-verify every new guard**: baseline green first, mutate, confirm
   the covering test goes red as a TEST failure (a compile error proves
   nothing), restore, confirm green by RE-RUNNING — never by grepping the
   file. Full detail: CLAUDE.md "Verify that a check can fail".

5. **History entry** in `docs/decisions/history.md`, inserted before the LAST
   occurrence of `## Open items / known gaps as of this entry`
   (`s.rindex` in Python — the file contains several decoy occurrences in
   prose, and only the last is the heading). Verify by counting:
   `grep -c '^## Open items / known gaps as of this entry'` must be 1.

6. **Functional scenarios** (`docs/testing/functional-scenarios.md`) if the
   change has user-facing or API-surface behavior; skip for
   refactors/CI/docs. README's "Current state"/"Run it locally" if a new
   app, route, or local-dev step landed.

7. **Commit BEFORE launching reviewers, and never touch git while they
   run.** Reviewers legitimately mutate files (to answer mutation-check
   criteria) and restore them; a `git add -A` mid-review has shipped a
   mutation instead of a fix once already.

8. **Run `/pre-merge`** — the checker, `ac-verifier`, and whichever of
   `backend-reviewer`/`frontend-reviewer` the diff paths select. Hand every
   one of them the issue's acceptance criteria, not just ac-verifier.
   Resolve or explicitly justify every `[blocking]` finding before the PR.
   A partial `NOT MET` verdict means the PR says "part of #N", not
   "closes #N" — the issue stays open, with the remainder filed as its own
   ticket rather than absorbed.

   **If launching any of those agents returns `Agent type '<name>' not
   found`, that is a hard stop, not a skip** — a session's agent registry
   can be stale relative to `main` (#410). Do not let `/pre-merge` read as
   complete with that gate silently missing. See the `/pre-merge` skill's
   "A gate that fails to launch is not a gate that passed" section for the
   loud-failure report format and the `general-purpose`-agent workaround
   that avoids restarting the session.

9. **`pnpm run verify` (one command, never split), push, open the PR** with
   `closes #<issue>` in the body — then verify what GitHub PARSED, never
   what the body looks like:
   `gh api graphql ... closingIssuesReferences`. Backticks do not disarm a
   closing keyword; quoting the phrase in an explanation still closes the
   issue. Re-check after every body edit. `gh pr edit` silently fails in
   this repo — PATCH via `gh api` instead.

10. **Count the check runs**: `pnpm run ci:checks` must report the full
    declared count and exit 0. Zero checks looks exactly like passing on
    every other surface; the usual cause is a base conflict, and the fix is
    `git fetch origin && git rebase origin/main && git push
    --force-with-lease`. Exit 5 means green-but-stale. History.md conflicts
    on rebase are normal (it's the file every ticket edits) — resolve by
    keeping both entries, re-verify the heading count.

11. **Merge policy: the default is ASK.** Green CI is not permission. The
    user may grant standing authority for a session, in their own words, and
    it does not transfer between sessions. Standing authority still never
    waives: the ci:checks count, re-reading `mergeable` immediately before
    the merge itself, and the evidence latch on `NEEDS HUMAN EVIDENCE`
    criteria. `gh pr merge <n> --squash` — without `--delete-branch` when
    run from a worktree (it tries to check out main locally and collides
    with the primary checkout; GitHub auto-deletes the remote branch anyway).

12. **Board Status does NOT auto-sync when the issue closes.** Measured on
    N187 and N188: the issue closed, the board still said In Progress. Set
    Status → Done by hand after the merge, via the `updateProjectV2ItemFieldValue`
    mutation. Same recipe, different value, for a ticket the evidence latch
    reopens: Status → Awaiting evidence — CI writes the `evidence-outstanding`
    label, never the Status field.

13. **Clean up**: `git worktree remove`, `git worktree prune`,
    `git branch -D` — from the primary checkout, not from inside the
    worktree being removed.

## Not covered here, and where it lives

- What the reviewers check and why they exist: the `/pre-merge` skill.
- The engine's own machinery (leases, gates, breakers, sandbox):
  `engine/internal/*` package docs and the N135-epic history entries.
- The evidence latch mechanics (never open a line with the attestation
  gesture unless you mean it): CLAUDE.md "Merged is not done".
