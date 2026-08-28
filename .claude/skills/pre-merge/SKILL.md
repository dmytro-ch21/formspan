---
name: pre-merge
description: Run the full pre-merge gate before pushing or opening a PR — the CI check suite AND the code reviewers. Use whenever the user asks to check everything passes, and before opening or updating any PR.
---

Three things have to happen before a PR, and they are **one gate, not
three**. Run them in the same turn, in parallel:

1. **`pre-merge-checker`** — the CI-equivalent check suite.
2. **`ac-verifier`** — the branch against the acceptance criteria of the
   issue it closes. Always, on every PR that closes an issue.
3. **The review subagents matching the diff.** Decide from
   `git diff origin/main...HEAD --name-only`:
   - any `backend/**` or `contracts/**` change → **`backend-reviewer`**
   - any `apps/**` change → **`frontend-reviewer`**
   - a change spanning both → **both, launched together**

## A gate that fails to launch is not a gate that passed

**Before treating any of the three as having run, confirm it actually
launched.** `Agent(subagent_type: "ac-verifier")` (or `pre-merge-checker`,
`backend-reviewer`, `frontend-reviewer`) can fail *at the launch step itself*,
before the agent does any work, if this session's agent registry does not
currently contain that type — for example, a session started before a new
`.claude/agents/*.md` file merged into `main`. That failure is a **tool
error**, not an agent report:

```
Agent type 'ac-verifier' not found. Available agents: general-purpose,
statusline-setup, claude, Explore, Plan, claude-code-guide,
frontend-reviewer, backend-reviewer, ticket-manager, pre-merge-checker,
backend-module-scaffolder
```

(Reproduced verbatim on 2026-08-27 against a deliberately-misspelled
`subagent_type`, in the session that wrote this section — see the N410
history entry for the full old-vs-new demonstration.)

This is the defect #410 named: every other gate still runs and reports green,
the missing gate produces no report at all, and unless the orchestrating
session explicitly notices the shape of that error, `/pre-merge` reads as
complete with the one gate that checks the ticket silently gone.

**So, explicitly, for every gate in the numbered list above:**

1. Issue the `Agent` call and look at what came back. A tool error naming
   the agent type as not found is not "nothing to report" and is never
   folded into a green summary.
2. **If any gate agent fails to launch this way: STOP.** Do not continue to
   the next gate as though this one passed, and do not present a report that
   omits it silently. State it as its own line, first, ahead of every other
   result:

   ```
   GATE FAILED TO LAUNCH: <agent-name> — agent type not found in this
   session's registry. /pre-merge did NOT complete; the following gates
   did not run for this reason: <list>.
   ```

3. **The workaround — use it before considering a restart**: re-run that
   gate through the `general-purpose` agent type instead of the missing
   specific one. Read the missing agent's own definition file
   (`.claude/agents/<name>.md`), strip the YAML frontmatter, and hand the
   rest of the file to `general-purpose` as its prompt — it is written as a
   self-contained set of instructions for exactly this purpose (finding the
   issue, the verdict rubric, the report format). Say explicitly in the
   final report that this gate ran via the `general-purpose` workaround, so
   the reader knows the registry was stale for this session rather than
   assuming the specific agent type was used.
4. This is a **session-staleness condition**, not proof the agent
   definition is broken or missing from the repo — check
   `.claude/agents/<name>.md` exists on `origin/main` first; if it does,
   this is exactly the registry-staleness gap #410 describes, and the
   workaround in step 3 is the intended route, not a restart. (Exactly
   *what* makes a session pick up a new definition — a fresh session, a
   registry refresh event, something else — is still an open, unresolved
   question: see #410's `NEEDS HUMAN EVIDENCE` criterion. Do not guess at
   it here.)

**Fetch the issue first and hand its acceptance criteria to every one of
them**, not only to `ac-verifier`:

```bash
gh issue view <n> --json title,body        # <n> from `closes #<n>` in the PR body
```

Give each reviewer the diff scope *and the design intent* behind the change,
not just "review this branch". They find substantially more when they know
what the code is trying to do — and the acceptance criteria **are** that
intent, already written down, which is the cheapest way to hand it over. Say
which invariant is load-bearing, and what would be a disaster if it broke.

**A reviewer's `[blocking]` finding is only as current as what it read this
run.** `backend-reviewer` and `frontend-reviewer` are each instructed (see
their own "Grounding a `[blocking]` convention finding" section) to read
`CLAUDE.md` fresh in every run rather than from training-time memory of the
repo, and to quote the current rule — verbatim, with `file:line` — for any
`[blocking]` finding that cites a VOLA-specific convention. A convention
finding with no such quote is not a blocker: treat it as a `[suggestion]`
regardless of how confidently it reads. (#436: a reviewer once demanded a PR
tick a line in `docs/TASKS.md`, a convention #399/#420 had retired hours
earlier — `CLAUDE.md` already said plainly that a tick there "means nothing".)
This is also why the three pieces of this gate cannot disagree about which
conventions are live: `ac-verifier` grades against the issue's own criteria,
read fresh every run; the reviewers ground convention findings the same way,
against `CLAUDE.md` read fresh every run. Neither carries a convention as a
standing belief between runs.

## The three answer different questions

- The checker asks **"will CI pass?"**
- The reviewers ask **"is this code good?"**
- `ac-verifier` asks **"is this the thing that was asked for?"**

Nothing else on the gate asks the third one, and a change can pass the first
two while not closing its ticket. That is not hypothetical here: the migration
on 2026-08-20 found three tasks marked open whose work had already merged, and
the inverse — a PR that looks finished and satisfies half its criteria — is the
same gap seen from the other side.

## Why this skill covers all three

These used to be separate rules in `CLAUDE.md`. In practice the checks got
run and the reviewers got skipped, repeatedly, across several PRs — because
running the checks *feels* like having verified the change. It isn't.

The checks prove it compiles and that CI will pass. They have never once
caught an authorization gap or a data-loss bug. The reviewers have caught
several: the same cross-user ID-enumeration bug in two different modules,
and a `completed` flag that was written to Postgres but never read back —
which zeroed every session's volume and would have erased real data through
the mobile sync cycle. Every one of those shipped a green check suite.

If only one of these were ever going to happen, it should be the reviewers.
So they live here, in the thing that actually gets invoked — and `ac-verifier`
lives here for the same reason: a separate rule saying "check the ticket" is a
rule that gets skipped by anyone who already believes they built the right
thing.

## Reporting

Surface the checker's per-check pass/fail verbatim, then the **acceptance
criteria table**, then the reviewers' findings.

### The acceptance-criteria gate

**Every criterion must be `MET`, or carry a stated reason, before the PR goes
ready-for-review** — that is what moving the issue to `In Review` on the board
asserts.

`ac-verifier` returns one of four verdicts per criterion, and they are not
interchangeable:

- **MET** — evidence quoted. Nothing further.
- **NOT MET** — fix it, or say plainly that this PR does not close the issue
  and drop `closes #<n>` from the body so it stays open.
- **NEEDS HUMAN EVIDENCE** — the criterion cannot be settled by reading the
  diff: a device run, a live-provider call, a mutation that must be watched
  going red, a screenshot, a decision confirmed with the user. Do not let it
  pass silently because the code looks right — these criteria are written as
  device checks precisely because reading the code is the thing that fails.

  **Produce whatever evidence you can yourself first** — run the mutation and
  watch it go red, drive the Simulator, make the live call. Then **hand the
  genuine remainder to the user as a numbered checklist and wait for their
  answer.** They have asked to run these themselves, on purpose, to catch bugs
  early; `ac-verifier` returns a *For the user to check* block written for
  exactly that. Give it to them, say which build they need and whether it wants
  a rebuild rather than a reload, and **do not move the issue to `In Review`
  until they report back.** Their "it works" is the evidence; your reading of
  the diff is not.
- **NOT ADDRESSED** — legitimate on a partial PR, but it has to be visible.
  List what is left and why.
- **NO CRITERIA** — the issue has none to check against. **Blocking, exactly
  like NOT MET.** Zero criteria yields zero unmet, which renders as a clean pass
  — so an under-specified ticket would sail through the one gate that exists to
  ask whether the thing was achieved. Write criteria into the issue (the
  verifier proposes a set, drawn from the issue rather than from the diff), get
  them agreed, then re-run. Do not let the verifier grade against its own
  proposal.

**A criterion is never marked met by the person who wants to merge, on the
strength of wanting to merge.** If the honest answer is "three of eight, and
the device run has not happened", that is a fine thing to report and a bad
thing to hide.

Resolve or explicitly justify every `[blocking]` finding **before** opening
the PR — not after. A PR is where review attention lands, and opening one
with a known-bad diff spends that attention on something already known.

`[suggestion]` items are judgment calls: act on them, or say why not.

## After the PR exists: count the checks, never the failures

Once the branch is pushed and the PR is open, run:

```bash
pnpm run ci:checks
```

It must report **6** check runs and exit 0 (read from `EXPECTED_CHECK_RUNS` in
`scripts/check-ci-checks.py` if this number and the tool's own output ever
disagree — it has drifted once already, see CLAUDE.md's "CI can run ZERO
checks" section). **A count of 0 is not "nothing
failed" — it is "nothing ran", and the two are indistinguishable** in
`gh pr view`, in an empty `statusCheckRollup`, and in `mergeStateStatus`. A
conflicting PR receives no new runs, because GitHub cannot build the
`refs/pull/N/merge` commit that a `pull_request` workflow runs on; the fix is
`git fetch origin && git rebase origin/main && git push --force-with-lease`.
See "CI can run ZERO checks" in `CLAUDE.md`.

**Exit 5 is the one to read carefully**: every check green *and* the PR
conflicting. Existing runs are never withdrawn, so those checks describe a merge
commit that no longer exists — GitHub will refuse the merge and a rebase re-runs
all of them. Every other surface calls that state ready. And if it notes
`mergeable` is `UNKNOWN`, **run it again**; GitHub computes that lazily and the
second call is the one with an answer.

Never report a PR as green off the absence of failures. Report the number.

Everything green means **CI will likely pass**. It does not mean the PR
should be merged. Merging always needs the user's own explicit go-ahead,
every time, however green it looks.
