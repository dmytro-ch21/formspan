---
name: pre-merge
description: Run the full pre-merge gate before pushing or opening a PR — the CI check suite AND the code reviewers. Use whenever the user asks to check everything passes, and before opening or updating any PR.
---

Two things have to happen before a PR, and they are **one gate, not two**.
Run them in the same turn, in parallel:

1. **`pre-merge-checker`** — the CI-equivalent check suite.
2. **The review subagents matching the diff.** Decide from
   `git diff origin/main...HEAD --name-only`:
   - any `backend/**` or `contracts/**` change → **`backend-reviewer`**
   - any `apps/**` change → **`frontend-reviewer`**
   - a change spanning both → **both, launched together**

Give each reviewer the diff scope *and the design intent* behind the change,
not just "review this branch". They find substantially more when they know
what the code is trying to do — say which invariant is load-bearing, and
what would be a disaster if it broke.

## Why this skill covers both

These used to be separate rules in `CLAUDE.md`. In practice the checks got
run and the reviewers got skipped, repeatedly, across several PRs — because
running the checks *feels* like having verified the change. It isn't.

The checks prove it compiles and that CI will pass. They have never once
caught an authorization gap or a data-loss bug. The reviewers have caught
several: the same cross-user ID-enumeration bug in two different modules,
and a `completed` flag that was written to Postgres but never read back —
which zeroed every session's volume and would have erased real data through
the mobile sync cycle. Every one of those shipped a green check suite.

If only one of the two were ever going to happen, it should be the
reviewers. So they live here, in the thing that actually gets invoked.

## Reporting

Surface the checker's per-check pass/fail verbatim, then the reviewers'
findings.

Resolve or explicitly justify every `[blocking]` finding **before** opening
the PR — not after. A PR is where review attention lands, and opening one
with a known-bad diff spends that attention on something already known.

`[suggestion]` items are judgment calls: act on them, or say why not.

Everything green means **CI will likely pass**. It does not mean the PR
should be merged. Merging always needs the user's own explicit go-ahead,
every time, however green it looks.
