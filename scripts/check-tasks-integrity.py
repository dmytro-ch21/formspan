#!/usr/bin/env python3
"""Fail if `docs/TASKS.md` has lost, duplicated, or un-finished a task.

`docs/TASKS.md` is the ARCHIVE of the task list — the live list moved to GitHub
Issues on 2026-08-20 (see CLAUDE.md, *The open list*). This check stays, because
the archive is still the record that a task was considered and its ids are still
what "closes W2" resolves against; losing or un-ticking one silently rewrites
history. It remains a file **every other check is blind to**. It is prose: `lint`, `typecheck`,
every test suite and every parity script look straight past it. So a task that
silently goes from `[x]` back to `[ ]`, an id that gets duplicated, or a line
that disappears entirely will pass `verify`, pass CI, and merge.

## What actually happened, which is why this exists

All three nearly landed on 2026-08-19, in one evening, on branches that were
green at the time:

- **A hand resolution** took one side of a conflicted hunk wholesale. `main` had
  two ids ticked and the branch had them stale; taking either side regressed
  finished work to open, with nothing to notice it.
- **A helper script** written to make those resolutions safer re-added a ticked
  line whose counterpart sat OUTSIDE the conflict hunk, producing a duplicate
  id. Automation aimed at this problem created a new instance of it.
- **A clean auto-merge** produced no conflict at all and still needed auditing,
  because an auto-merge picks a side just as silently and leaves no marker. This
  is the case a conflict-driven fix would miss entirely, and it is the reason
  this runs on every build rather than only when git noticed something.

The damage is quiet in the way that matters: an id reverted to `[ ]` reads as
"still to do", so the next session picks it up and redoes finished work — which
is the exact loss the claiming convention was written to prevent.

## It has caught its own author twice, on different failure modes

Recorded because the lesson is not obvious from the code, and because both were
rebase resolutions that no other check in the repo can see.

**A duplicated id.** A helper written to make doc resolutions safer re-added a
ticked line whose counterpart sat OUTSIDE the conflict hunk, so the same id
appeared twice. Automation aimed at this problem created a fresh instance of it.

**A regressed tick.** A later version of that helper kept "the longer line per
id" — and an upstream `[x]` lost to a longer local `[ ]`, silently reopening a
finished task. **Length is a proxy for authority and a bad one**: it happens to
work until a verbose local edit meets a terse upstream tick.

The rule a conflict resolver actually needs is about **authority, not shape**: a
tick upstream is a claim that work landed, and it wins regardless of how the two
lines look. That is what this check's own failure message says, and it took two
goes to put it in the resolver.

## What it promises, and what it cannot

It compares this working tree against the **merge base** with `origin/main`.
That bounds it in four ways, stated rather than implied — the first two are the
ones that matter operationally and the first draft of this file omitted both:

- **It is blind to a branch losing its OWN work.** Measured: a branch that ticks
  an id and files a new one, then has a bad resolution revert its own tick and
  drop its own new id, prints `tasks intact`. Both sides of a resolution can
  lose work and only the upstream-facing side is guarded. Inherent to a
  two-point comparison, and the reason the headline claim is "makes a lost
  UPSTREAM tick a red build" rather than anything broader.
- **A stale `origin/main` weakens it.** If the fetched tip predates a tick, the
  merge base does too, and reverting that tick is invisible here. `git fetch
  origin` first, which the branching rule already requires. Note this is
  weakening, never a false alarm: being behind cannot fail this check, which is
  what the merge base buys.
- **A qualified id may appear only ONCE.** `**N7 (backend)**` parses as `N7`, so
  adding `**N7 (mobile)**` — splitting a task the way the file already models —
  is reported as a duplicate. The alternative (keying on id-plus-qualifier)
  would miss a real duplicate where one copy gained a qualifier, which is the
  worse trade. Split with a new id instead.
- **It does not read prose.** A line rewritten to say something false, or a task
  ticked that was never done, is out of scope. This checks structure only.
- **It only guards a tick being ERASED, never one being forgotten.** A PR whose
  title says `closes N68` and which never ticks N68 passes here cleanly. That
  half is real and has cost a day already — an id sat open, marked HIGH
  PRIORITY with a stale diagnosis, well after the PR that fixed it had merged.
  Closing it means comparing a PR's stated intent against the file, which needs
  the PR context this script does not have; filed separately rather than bolted
  on here.

Retiring or renumbering an id fails as a dropped line. That is deliberate —
`CLAUDE.md` says a finished task's line is never deleted, because it is the
record that the task was considered — but it means a genuine renumbering needs
that rule revisited rather than this check bypassed.

Stdlib-only and syntactic, matching `check-grip-parity.py` and
`check-rate-parity.py`, so `verify` needs no toolchain beyond `python3` and
`git`.
"""

import re
import subprocess
import sys

TASKS = "docs/TASKS.md"
UPSTREAM = "origin/main"

# `- [x] **N41** — ...`, and also `- [x] **N7 (backend)** — ...`, where the id
# carries a qualifier inside the bold. Deliberately NOT anchored on the closing
# `**`: that form is real and skipping it would silently drop an id from every
# count below, which is the failure this file exists to catch.
#
# Lines with no bold id at all are real too — the historical entries near the
# bottom are plain `- [x] Per-side dumbbell load — …` — and are ignored rather
# than treated as errors.
TASK_LINE = re.compile(r"^- \[([ xX])\] \*\*([A-Z]+\d+)")


def parse(text: str) -> dict[str, list[str]]:
    """Map id -> list of states, one entry per line carrying that id.

    A list rather than a single value so a duplicate is representable. Collapsing
    to a dict here would hide the very thing the first assertion looks for.
    """
    found: dict[str, list[str]] = {}
    for line in text.splitlines():
        m = TASK_LINE.match(line)
        if m:
            found.setdefault(m.group(2), []).append(m.group(1).strip().lower())
    return found


def git(*args: str) -> str | None:
    """Run a git command, or None if it fails."""
    try:
        return subprocess.run(
            ["git", *args], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def baseline_ref() -> str | None:
    """The commit to compare against: the MERGE BASE, not `origin/main`'s tip.

    This distinction is the whole correctness of the check, and the first
    version got it wrong.

    Comparing against the tip fails any branch that is merely BEHIND — and being
    behind cannot produce the damage this file is looking for. Git's three-way
    merge resolves against the merge base, so a line the branch never touched is
    never regressed by merging it, no matter how far the tip has moved. The tip
    comparison therefore fired on a condition structurally incapable of causing
    harm, while telling the author they had regressed a task they had not
    touched.

    It made three ordinary situations red for no reason: a **stacked PR** (whose
    merge ref contains its feature base, not `main`'s newest ticks — and
    `ci.yml` deliberately supports stacked PRs), a **push to `main`** racing
    another merge, and — worst — **every local `verify` on every in-flight
    branch** after any merge anywhere, since this runs first and blocks the
    chain. A check that cries wolf on undamaged trees gets deleted, which is the
    one outcome that leaves the file unguarded again.

    After a rebase — the exact moment this check exists for — the merge base IS
    `origin/main`, so nothing is given up. Verified against all three real
    failures (un-tick, duplicate, drop): each still fails.
    """
    return git("merge-base", "HEAD", UPSTREAM)


def baseline_text(ref: str) -> str | None:
    """`docs/TASKS.md` as of `ref`, or None if it cannot be read."""
    return git("show", f"{ref}:{TASKS}")


def main() -> int:
    with open(TASKS, encoding="utf-8") as fh:
        here = parse(fh.read())

    problems: list[str] = []

    # 1. No duplicate ids. Ids are permanent handles — "closes W2" has to mean
    #    one thing a year later — and two lines claiming one id makes every
    #    later reference ambiguous.
    for task_id, states in sorted(here.items()):
        if len(states) > 1:
            problems.append(
                f"  {task_id} appears {len(states)} times (states: "
                f"{', '.join('[x]' if s == 'x' else '[ ]' for s in states)})"
            )

    ref = baseline_ref()
    base_text = baseline_text(ref) if ref else None
    if base_text is None:
        # NOT a skip. A check that quietly passes when it cannot do its job is
        # the failure this repo has already shipped once — an integration test
        # that skipped on every CI run for months while its package printed
        # `ok`. If the baseline is unreachable, say so and fail.
        print(
            f"check-tasks-integrity: cannot read {TASKS} at the merge base with\n"
            f"{UPSTREAM}, so the comparison that catches a regressed task cannot be\n"
            f"made.\n\n"
            f"Run `git fetch origin` and try again. In CI, the workflow must fetch\n"
            f"the base branch before this step — a shallow checkout does not have it."
        )
        return 1

    base = parse(base_text)

    # 2. Nothing `main` considers finished may be open here. This is the
    #    regression that costs real work: it reads as "still to do", so the next
    #    session picks the task up and does it again.
    for task_id, states in sorted(base.items()):
        if "x" in states and here.get(task_id) and "x" not in here[task_id]:
            problems.append(
                f"  {task_id} is [x] at the merge base but [ ] here — a finished "
                f"task marked open again"
            )

    # 3. Nothing may vanish. A finished task's line IS the record that it was
    #    considered, which is why the convention marks lines in place rather
    #    than deleting them.
    for task_id in sorted(set(base) - set(here)):
        problems.append(f"  {task_id} is at the merge base and missing here")

    if problems:
        print(f"check-tasks-integrity: {TASKS} has regressed against the merge base.\n")
        print("\n".join(problems))
        print(
            "\nThis is almost always a rebase resolution that took one side of a\n"
            "conflicted hunk wholesale, or an auto-merge that did the same without\n"
            "producing a conflict at all. Resolve per task id instead: keep every id\n"
            "both sides have, and prefer [x] over [ ] — a tick is a claim that work\n"
            "landed, and nothing else in the repo can tell you it was lost."
        )
        return 1

    print(
        f"tasks intact ({len(here)} ids, none duplicated, "
        f"none regressed against the merge base with {UPSTREAM})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
