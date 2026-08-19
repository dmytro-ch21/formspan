#!/usr/bin/env python3
"""Fail if `docs/TASKS.md` has lost, duplicated, or un-finished a task.

`docs/TASKS.md` is the shared task list, and it is the one load-bearing file in
this repo that **every check is blind to**. It is prose: `lint`, `typecheck`,
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

## What it promises, and what it cannot

It compares this working tree against `origin/main`. That bounds it in two ways
worth stating rather than implying:

- **A stale `origin/main` weakens it.** If the baseline predates a tick, the
  regression of that tick is invisible here. `git fetch origin` first, which the
  branching rule already requires.
- **It does not read prose.** A line rewritten to say something false, or a task
  ticked that was never done, is out of scope. This checks structure only.

Stdlib-only and syntactic, matching `check-grip-parity.py` and
`check-rate-parity.py`, so `verify` needs no toolchain beyond `python3` and
`git`.
"""

import re
import subprocess
import sys

TASKS = "docs/TASKS.md"
BASELINE = "origin/main"

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


def baseline_text() -> str | None:
    """`docs/TASKS.md` as `origin/main` has it, or None if it cannot be read."""
    try:
        return subprocess.run(
            ["git", "show", f"{BASELINE}:{TASKS}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


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

    base_text = baseline_text()
    if base_text is None:
        # NOT a skip. A check that quietly passes when it cannot do its job is
        # the failure this repo has already shipped once — an integration test
        # that skipped on every CI run for months while its package printed
        # `ok`. If the baseline is unreachable, say so and fail.
        print(
            f"check-tasks-integrity: cannot read {TASKS} from {BASELINE}, so the\n"
            f"comparison that catches a regressed task cannot be made.\n\n"
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
                f"  {task_id} is [x] on {BASELINE} but [ ] here — a finished task "
                f"marked open again"
            )

    # 3. Nothing may vanish. A finished task's line IS the record that it was
    #    considered, which is why the convention marks lines in place rather
    #    than deleting them.
    for task_id in sorted(set(base) - set(here)):
        problems.append(f"  {task_id} is on {BASELINE} and missing here")

    if problems:
        print(f"check-tasks-integrity: {TASKS} has regressed against {BASELINE}.\n")
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
        f"none regressed against {BASELINE})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
