#!/usr/bin/env python3
"""Fail if a pull request has not actually been checked — count the runs, never the failures.

## The failure this prevents

**Zero CI check runs and five green ones are the same picture** in every place a
session normally looks. `gh pr view` reports no failing checks, because there
are none — there is nothing. `statusCheckRollup` is an empty list, which reads
as "nothing wrong". `mergeStateStatus` does not distinguish them either. So the
one question that decides whether code ships — *was this verified?* — is
answered by an absence, and absence is not evidence.

That is not hypothetical. N65 (#368) records a branch that took four
`synchronize` pushes and a `reopened` event and received **zero** runs for each,
while three sibling branches and `main` ran normally in the same minutes. The
only run it ever had was on its empty claim commit. Every commit carrying real
work went unchecked, and nothing anywhere said so.

So this script asserts the **positive**: the checks CI declares actually exist
on the commit GitHub thinks is the head of the pull request.

## The cause, which is now known — see the N65 entry in docs/decisions/history.md

A `pull_request` workflow does not run on your branch. It runs on
`refs/pull/N/merge`, the commit GitHub makes by merging your head into the base.
**When the pull request conflicts with its base, that merge commit cannot exist,
so no NEW workflow run is created** — silently, with no failure, no annotation
and no check.

**"No new run", not "no runs".** The distinction is load-bearing and was got
wrong here first: runs already created are never withdrawn, so a pull request
can carry a full set of green checks *and* be conflicting. See `diagnose`, which
measures that case and is why `EXIT_STALE` exists.

Measured on the branch in #368: it merged cleanly at 22:09Z and got its run; six
minutes later `main` moved and the branch began conflicting in `docs/TASKS.md`
and `docs/testing/functional-scenarios.md`; from there every push and the
close/reopen produced nothing; the force-push that rebased it onto current
`main` produced a full five within four seconds. Confirmed prospectively on a
deliberately conflicting throwaway pull request (#393), which received zero runs
while `mergeable` read `CONFLICTING` — and again unprompted on this script's own
pull request (#390) while it was under review.

Hence the remedy this script prints when it finds zero:
`git fetch origin && git rebase origin/main && git push --force-with-lease`.

## What it asserts

1. Every check CI declares for a pull request is **present by name** on the head
   commit, and the raw run count is reported alongside — the count is the number
   #368's acceptance criteria name, the name set is the strictly stronger test
   (four of five present is a count of 4, but it is also a *named* absence).
2. It reads the pull request's **`headRefOid`**, never the newest run on the
   branch. `gh run list --branch` will happily hand you a green run for a commit
   two pushes ago, which is the same absence-reads-as-answer failure wearing a
   green tick.
3. Nothing has failed, nothing was SKIPPED, and nothing is still running. Each
   gets its own exit code, because "not finished", "did not run" and "went red"
   are three different answers: `1` nothing ran / a check missing / a check
   skipped, `2` something failed, `3` still pending, `4` could not ask GitHub.
4. The green, if green, is about the PRESENT. A full set of passing checks on a
   pull request that is now CONFLICTING describes a merge commit that no longer
   exists — `5`, `EXIT_STALE`. Nothing else in any GitHub surface flags that
   state, and every one of them calls it ready to merge.

Expected checks are derived from the workflow files rather than hardcoded, and
cross-checked against `EXPECTED_CHECK_RUNS`, a literal somebody measured: if the
two disagree the script **refuses to run** rather than trusting either. So a new
CI job does not raise the bar by itself — it turns `check:ci-detector` red until
the constant is bumped in the same commit, which is the intended cost. A parser
that silently found one job would otherwise make this whole check vacuous.

## What it does not promise

- **It cannot tell you a check was meaningful**, only that it ran and concluded.
  A job whose steps were all deleted still reports `success`.
- **It is not a gate in `verify`.** `verify` runs before a pull request exists
  and must work offline; this needs the network and an authenticated `gh`. Its
  `--self-test` mode is the part that runs in `verify`, and that mode proves the
  decision logic still rejects the zero-run case rather than proving anything
  about any pull request.
- **It cannot see a check the local tree does not declare.** The expected set is
  parsed from *your* working copy while the runs come from the remote head, so
  pointing `--pr` at somebody else's branch compares their runs to your
  `ci.yml`. A run they have and you do not is reported as a `note:`, never a
  failure.
- **A new CI job does not raise the bar silently — it stops the script.** The
  derivation and `EXPECTED_CHECK_RUNS` disagree, which is a loud refusal by
  design; bump the constant in the same commit.
- It reads `mergeable` for the diagnosis, and GitHub computes that lazily — an
  `UNKNOWN` immediately after a push means "ask again in a moment", not "fine".
- **It needs Python 3.10+** for its `X | None` annotations, as several of its
  siblings in `scripts/` already do. `check:python` cannot catch that: 3.9's
  `ast.parse` accepts PEP 604 as *syntax* and the failure is at import.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github/workflows"

# Measured 2026-08-20 against a green run on `main` (11c230d): five check runs,
# one per CI job. Cross-checked below against the jobs actually declared in the
# workflow files — this literal exists so a parser that silently finds nothing
# cannot make the whole check vacuous, which is the way a detector most often
# dies. If CI genuinely gains or loses a job, change this in the same commit.
EXPECTED_CHECK_RUNS = 6

# A check run that actually did the work. ONLY `success`.
#
# This set held `skipped` and `neutral` for one draft, on the reasoning that
# neither means "failed" — and review measured what that bought: five jobs
# concluding `skipped` made this script print "all declared checks ran and
# passed" and exit 0. That is this script's own central claim being false in
# precisely the shape it exists to catch, and it is reachable in one edit (a
# job-level `if:` on the five jobs still derives all five names, so the count
# cross-check does not fire either). A skipped check did not run.
#
# `skipped` is therefore NOT-CHECKED, not FAILED, because it is the same
# category as a missing run: nothing verified anything. Everything else
# non-success is reported with its conclusion named, so a `neutral` reads as
# `neutral` rather than being silently forgiven.
GOOD_CONCLUSIONS = {"success"}
DID_NOT_RUN_CONCLUSIONS = {"skipped"}

EXIT_OK = 0
EXIT_NOT_CHECKED = 1  # zero runs, a declared check missing, or skipped — the N65 case
EXIT_FAILED = 2  # the checks ran and something is red
EXIT_PENDING = 3  # the checks ran and have not finished
EXIT_ERROR = 4  # we could not ask GitHub at all — deliberately NOT 1
# Every declared check is present and green, and the pull request is
# CONFLICTING. Its own code, because it is the one state a human reads as
# "ready to merge" while it is not: see `diagnose`.
EXIT_STALE = 5

REMEDY = (
    "  git fetch origin && git rebase origin/main && git push --force-with-lease"
)


# --------------------------------------------------------------------------
# What CI declares
# --------------------------------------------------------------------------


def strip_comments(text: str) -> str:
    """Drop whole-line YAML comments.

    Same reason as `check-verify-chain.py`: a commented-out job must not count
    as a job CI runs.

    **It changes nothing about today's `ci.yml`** — measured, `pull_request`
    appears there exactly once and not in a comment, and the file has no
    column-0 comments at all, so replacing this with the identity function
    leaves the parse byte-identical. An earlier version of this docstring
    claimed the opposite; review measured it. It is kept because a column-0
    comment inside the `on:` block would otherwise trip
    `triggers_on_pull_request`'s "left the block" test and silently drop the
    whole workflow — and `self_test` has a fixture for exactly that, so the
    guard is not resting on this paragraph.
    """
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def triggers_on_pull_request(text: str) -> bool:
    """Whether this workflow's `on:` block includes `pull_request`.

    Handles both the block form used by `ci.yml` and the inline list form. The
    match is confined to the `on:` block on purpose: a job step that mentions
    `pull_request` (or a `github.event_name` comparison) must not enrol an
    unrelated workflow into the expected set.
    """
    lines = text.splitlines()
    inside = False
    for line in lines:
        if re.match(r"^on:\s*(\[.*\])?\s*$", line):
            inline = re.match(r"^on:\s*\[(.*)\]\s*$", line)
            if inline:
                return "pull_request" in [t.strip() for t in inline.group(1).split(",")]
            inside = True
            continue
        if inside:
            if line.strip() == "":
                continue
            if not line.startswith(" "):  # left the `on:` block
                return False
            if re.match(r"^  pull_request:\s*$", line):
                return True
    return False


def job_names(text: str) -> list[str]:
    """The `name:` of every top-level job, in declaration order.

    Indentation does the disambiguating: a job key is exactly two spaces deep
    and its `name:` exactly four, while a step's `name:` is deeper and preceded
    by a `-`. That is narrow enough to be wrong if the file is ever reformatted,
    which is why the caller cross-checks the total against a measured literal
    instead of trusting this alone.
    """
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.rstrip() == "jobs:")
    except StopIteration:
        return []

    names: list[str] = []
    current: str | None = None
    for line in lines[start + 1 :]:
        if line.strip() == "":
            continue
        if not line.startswith(" "):  # a new top-level key ended `jobs:`
            break
        key = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if key:
            current = key.group(1)
            names.append(current)  # replaced by `name:` below if one is given
            continue
        named = re.match(r"^    name:\s*(.+?)\s*$", line)
        if named and current is not None and names:
            names[-1] = named.group(1).strip("\"'")
    return names


def expected_check_names() -> tuple[list[str], list[str]]:
    """(names, problems) — the checks a pull request should receive."""
    problems: list[str] = []
    if not WORKFLOWS.is_dir():
        return [], [f"{WORKFLOWS} does not exist; cannot tell what CI declares."]

    names: list[str] = []
    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        text = strip_comments(path.read_text())
        if not triggers_on_pull_request(text):
            continue
        # No `$` anchor: `matrix: {node: [20, 22]}` on one line is still a
        # matrix, and the anchored form missed it. Review measured that gap —
        # the outcome was safe (the runs come back named `Mobile (Expo) (20)`,
        # so they read as MISSING) but the message was wrong, printing N65's
        # rebase remedy for what is really a parser limitation.
        if re.search(r"^\s+matrix:", text, re.MULTILINE):
            # A matrix fans one job out into several check runs with generated
            # names, so counting job keys would under-report and the name set
            # would be wrong. Refuse rather than report a number that is quietly
            # too low, which is exactly the failure this script exists to catch.
            problems.append(
                f"{path.name} uses a job matrix, which this parser cannot expand.\n"
                "Teach it, or the expected check set is silently too small."
            )
        names.extend(job_names(text))

    if not names and not problems:
        problems.append(
            "no pull_request-triggered jobs found in .github/workflows.\n"
            "That is never right here, and it would make this check pass on "
            "any pull request at all."
        )
    if names and len(names) != EXPECTED_CHECK_RUNS:
        problems.append(
            f"the workflows declare {len(names)} pull_request check(s) "
            f"{names}, but EXPECTED_CHECK_RUNS is {EXPECTED_CHECK_RUNS}.\n"
            "One of the two is stale. If CI genuinely gained or lost a job, "
            "update the constant in the same commit; otherwise the parser in "
            "this script has stopped reading the workflow correctly."
        )
    return names, problems


# --------------------------------------------------------------------------
# The decision, kept pure so `--self-test` can exercise it offline
# --------------------------------------------------------------------------


def evaluate(expected: list[str], runs: list[dict]) -> tuple[int, list[str]]:
    """Decide whether a commit has really been checked.

    `runs` is the `check_runs` array from
    `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, so each element has
    `name`, `status` and `conclusion`.
    """
    out: list[str] = []

    if not expected:
        return EXIT_NOT_CHECKED, [
            "no expected checks were derived, so there is nothing to compare "
            "against and this check would pass on anything."
        ]

    out.append(f"check runs on this commit: {len(runs)} (expected {len(expected)})")

    if not runs:
        out += [
            "",
            "ZERO CHECK RUNS. This commit has not been checked at all.",
            "",
            "This is not 'no failures'. It is 'nothing ran', and the two are "
            "indistinguishable in `gh pr view`, in `statusCheckRollup` (empty) "
            "and in `mergeStateStatus`.",
            "",
            "The usual cause is that the pull request CONFLICTS with its base: a "
            "`pull_request` workflow runs on `refs/pull/N/merge`, which GitHub "
            "cannot create for a conflicting pull request, so no run is made and "
            "nothing reports the omission. Remedy:",
            "",
            REMEDY,
            "",
            "See docs/decisions/history.md (N65) and issue #368.",
        ]
        return EXIT_NOT_CHECKED, out

    present = [r.get("name", "") for r in runs]
    missing = [n for n in expected if n not in present]
    extra = sorted({n for n in present if n not in expected})

    if extra:
        out.append(f"note: run(s) not declared by the workflows: {', '.join(extra)}")

    if missing:
        out += [
            "",
            f"MISSING CHECK(S): {', '.join(missing)}",
            "",
            "Some checks ran and these did not, so the pull request shows no "
            "failures while part of CI never executed.",
            "",
            REMEDY,
        ]
        return EXIT_NOT_CHECKED, out

    pending = [r for r in runs if r.get("status") != "completed"]
    if pending:
        out += [
            "",
            "STILL RUNNING: "
            + ", ".join(f"{r.get('name')} ({r.get('status')})" for r in pending),
            "",
            "Not finished is not passing.",
        ]
        return EXIT_PENDING, out

    # Skipped before failed, because a skipped check is an ABSENCE and this
    # script is about absences. Reporting it as "FAILED" would be true enough to
    # act on but wrong about what happened, and the remedy differs: a red check
    # is a bug in the branch, a skipped one is a bug in the workflow's `if:`.
    skipped = [r for r in runs if r.get("conclusion") in DID_NOT_RUN_CONCLUSIONS]
    if skipped:
        out += [
            "",
            "SKIPPED, so NOT CHECKED: "
            + ", ".join(f"{r.get('name')}" for r in skipped),
            "",
            "A skipped check produced a green tick and verified nothing. Find "
            "the `if:` on that job — the check run exists, which is why the "
            "count and the name set both look right.",
        ]
        return EXIT_NOT_CHECKED, out

    bad = [r for r in runs if r.get("conclusion") not in GOOD_CONCLUSIONS]
    if bad:
        out += [
            "",
            "FAILED: "
            + ", ".join(f"{r.get('name')} ({r.get('conclusion')})" for r in bad),
        ]
        return EXIT_FAILED, out

    out.append("all declared checks ran and passed: " + ", ".join(expected))
    return EXIT_OK, out


def diagnose(code: int, facts: dict) -> tuple[int, str]:
    """Reconcile the run verdict with the pull request's mergeability.

    Returns a possibly-REVISED exit code plus the note explaining it. It revises
    rather than merely annotates because of the refinement below: there is a
    state where every check is green and the pull request is still not what a
    green set says it is.

    ## The precise claim is about run CREATION, not run existence

    The first version of this file said "a conflicting pull request receives
    zero check runs". Measured 2026-08-20, that is not quite right, and #395
    looks at first like a counterexample to the whole mechanism:

        PR #400  0 runs  CONFLICTING / DIRTY
        PR #395  6 runs  CONFLICTING / DIRTY   <- all six green
        PR #390  5 runs  MERGEABLE   / CLEAN

    The timestamps settle it. #395's six runs started at `14:40:33Z`; the merge
    that created its conflict, #404 into `main`, landed at `14:40:52Z`.
    **Nineteen seconds.** The runs were created while the pull request still
    merged cleanly, `main` then moved underneath it, and **existing check runs
    are never withdrawn.**

    So the claim is: *a pull request that conflicts with its base receives no
    NEW check runs.* That is exactly what `refs/pull/N/merge` failing to exist
    predicts, so the refinement strengthens the mechanism rather than qualifying
    it — a run already created is the record of a merge commit that once did.

    ## Which produces the state this function exists to catch

    A full set of green checks on a CONFLICTING pull request is the most
    dangerous reading in this whole area, and nothing else flags it. Every
    surface says green. The checks are real and they passed. But they describe a
    merge commit that **no longer exists**, GitHub will refuse the merge, and
    rebasing re-runs all of them — so the green says nothing about the code that
    would actually land. It is the stale-`headRefOid` trap with a perfectly
    valid `headRefOid`.

    Hence `EXIT_STALE`: green, but not about the present.
    """
    mergeable = facts.get("mergeable")
    state = facts.get("mergeStateStatus")

    if code == EXIT_OK and mergeable == "CONFLICTING":
        return EXIT_STALE, (
            "GREEN, BUT STALE: every declared check passed AND this pull "
            "request is CONFLICTING.\n\n"
            "Those runs were created while it still merged cleanly; the base "
            "has moved since, and existing runs are never withdrawn. They "
            "describe a merge commit that no longer exists, GitHub will refuse "
            "the merge, and a rebase re-runs all of them — so this green says "
            "nothing about the code that would actually land.\n\n" + REMEDY
        )

    if code == EXIT_OK and mergeable == "UNKNOWN":
        # Deliberately still 0. GitHub computes `mergeable` lazily and UNKNOWN
        # is the normal state for a few seconds after every push, so failing
        # here would cry wolf on healthy pull requests — and a check that cries
        # wolf is one somebody eventually silences, which costs more than this
        # case is worth. Saying so out loud is the middle course.
        return EXIT_OK, (
            "note: `mergeable` is UNKNOWN, which GitHub computes lazily. If it "
            "resolves to CONFLICTING this green is stale — re-run to be sure."
        )

    if code == EXIT_OK:
        return EXIT_OK, ""

    if code == EXIT_NOT_CHECKED and mergeable == "CONFLICTING":
        return code, (
            "CONFIRMED CAUSE: `mergeable` is CONFLICTING. GitHub cannot build "
            "this pull request's merge ref, so no NEW workflow run is created. "
            "Rebase (above) and the checks appear within seconds."
        )

    if code == EXIT_NOT_CHECKED and mergeable == "UNKNOWN":
        return code, (
            "`mergeable` is UNKNOWN — GitHub computes it lazily. Re-run this in "
            "a few seconds before concluding anything; UNKNOWN is not the same "
            "as MERGEABLE."
        )

    return code, f"mergeable={mergeable} mergeStateStatus={state}"


# --------------------------------------------------------------------------
# Talking to GitHub
# --------------------------------------------------------------------------


def gh(args: list[str]) -> str:
    proc = subprocess.run(
        ["gh"] + args, capture_output=True, text=True, cwd=str(ROOT)
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"`gh {' '.join(args)}` failed ({proc.returncode}):\n{proc.stderr.strip()}"
        )
    return proc.stdout


def repo_slug() -> str:
    return json.loads(gh(["repo", "view", "--json", "nameWithOwner"]))["nameWithOwner"]


def pr_facts(pr: str | None) -> dict:
    args = ["pr", "view"]
    if pr:
        args.append(pr)
    args += ["--json", "number,headRefOid,headRefName,mergeable,mergeStateStatus,url"]
    return json.loads(gh(args))


def check_runs_for(slug: str, sha: str) -> list[dict]:
    """The check runs on one commit, one per check name.

    `filter=latest` is the endpoint's DEFAULT and is pinned here anyway, because
    the behaviour is load-bearing and invisible when implicit. Measured
    2026-08-20 against a commit with five workflow attempts (`ee91313`):

        ?per_page=100              -> total_count 5,  array 5
        ?per_page=100&filter=all   -> total_count 25, array 25

    So a re-run does NOT add a duplicate name through this call — an earlier
    draft of this file claimed it did, and built a self-test vector on the
    claim, which is the "a stub built from an assumption cannot falsify it"
    rule arriving as a docstring instead of a stub. Review measured it.

    Do not switch to `filter=all` without also making duplicate handling
    explicitly latest-wins: with every attempt returned, a check that went
    red then green on a re-run reports FAILED, because the stale `failure`
    is still in the list.
    """
    payload = json.loads(
        gh(["api", f"repos/{slug}/commits/{sha}/check-runs?per_page=100&filter=latest"])
    )
    runs = payload.get("check_runs", [])
    total = payload.get("total_count")
    if total is not None and total != len(runs):
        # Only possible past 100 runs here, but a silently truncated list would
        # under-report and read as the very failure this script detects.
        raise RuntimeError(
            f"GitHub reports total_count={total} but returned {len(runs)} runs; "
            "the list is truncated and the count cannot be trusted."
        )
    return runs


# --------------------------------------------------------------------------
# Self-test: the part that runs in `verify`
# --------------------------------------------------------------------------


def _run(name: str, status: str = "completed", conclusion: str = "success") -> dict:
    return {"name": name, "status": status, "conclusion": conclusion}


# Named FIVE when there were five. It is the full declared set, whatever the
# count — renaming it on every addition would churn ~20 call sites below for
# no gain, and the count that matters is EXPECTED_CHECK_RUNS, which the
# self-test cross-checks against the workflows themselves.
FIVE = ["Backend (Go)", "Web (Next.js)", "Admin (Next.js)", "Scripts (Python)",
        "Mobile (Expo)", "Ready PRs contain work"]


def self_test() -> int:
    """Prove the decision logic still rejects what it exists to reject.

    Every vector below is a case somebody could break by "simplifying"
    `evaluate`, and each asserts an exit CODE, not merely non-zero — a version
    that returned 1 for everything would pass a non-zero assertion while being
    useless. Mutation-tested 2026-08-20: making `evaluate` return `EXIT_OK`
    unconditionally turns six of these red.
    """
    vectors: list[tuple[str, list[str], list[dict], int, str]] = [
        ("five green", FIVE, [_run(n) for n in FIVE], EXIT_OK, "passed"),
        # The N65 case itself, and the reason this file exists.
        ("zero runs", FIVE, [], EXIT_NOT_CHECKED, "ZERO CHECK RUNS"),
        ("four of five", FIVE, [_run(n) for n in FIVE[:-1]], EXIT_NOT_CHECKED, "MISSING"),
        (
            "one failed",
            FIVE,
            [_run(n) for n in FIVE[:-1]] + [_run(FIVE[-1], conclusion="failure")],
            EXIT_FAILED,
            "FAILED",
        ),
        (
            "one still running",
            FIVE,
            [_run(n) for n in FIVE[:-1]] + [_run(FIVE[-1], status="in_progress", conclusion=None)],
            EXIT_PENDING,
            "STILL RUNNING",
        ),
        # The two conclusions that used to be quietly forgiven. `skipped` is the
        # dangerous one: five skipped jobs are five check runs with the right
        # names, so the count and the name set both look perfect. Review found
        # this reporting "all declared checks ran and passed", exit 0.
        (
            "all skipped",
            FIVE,
            [_run(n, conclusion="skipped") for n in FIVE],
            EXIT_NOT_CHECKED,
            "SKIPPED, so NOT CHECKED",
        ),
        (
            "one skipped",
            FIVE,
            [_run(n) for n in FIVE[:-1]] + [_run(FIVE[-1], conclusion="skipped")],
            EXIT_NOT_CHECKED,
            "SKIPPED, so NOT CHECKED",
        ),
        # Not forgiven either, but it is a different thing and says so.
        (
            "one neutral",
            FIVE,
            [_run(n) for n in FIVE[:-1]] + [_run(FIVE[-1], conclusion="neutral")],
            EXIT_FAILED,
            "neutral",
        ),
        # NO duplicate-name vector. The endpoint defaults to `filter=latest` and
        # this script pins it, so a re-run cannot produce one — measured, see
        # `check_runs_for`. A vector for input the code cannot receive is the
        # one vector guaranteed never to catch anything.
        # An empty expectation must never pass vacuously — otherwise a parser
        # that stops reading the workflows turns this whole script green.
        ("nothing expected", [], [_run(n) for n in FIVE], EXIT_NOT_CHECKED, "nothing to compare"),
        # A run named something else does not satisfy a declared check.
        (
            "five runs, wrong names",
            FIVE,
            [_run("Lint") for _ in FIVE],
            EXIT_NOT_CHECKED,
            "MISSING",
        ),
    ]

    failures: list[str] = []
    for label, expected, runs, want_code, want_text in vectors:
        code, lines = evaluate(expected, runs)
        text = "\n".join(lines)
        if code != want_code:
            failures.append(f"  {label}: exit {code}, expected {want_code}")
        elif want_text not in text:
            failures.append(f"  {label}: output does not mention {want_text!r}")

    # The mergeability reconciliation. Two of these have a redundant *effect* —
    # the exit code already says the PR is unchecked — so nothing would go red
    # if the message were deleted, which is exactly why the message is asserted:
    # it is the sentence that tells whoever is staring at a zero what N65 found.
    # The `green but conflicting` pair is not redundant at all; it CHANGES the
    # verdict, and it is the case a human is most likely to misread.
    diagnoses: list[tuple[str, int, dict, int, str]] = [
        (
            "conflicting",
            EXIT_NOT_CHECKED,
            {"mergeable": "CONFLICTING"},
            EXIT_NOT_CHECKED,
            "CONFIRMED CAUSE",
        ),
        (
            "mergeable unknown",
            EXIT_NOT_CHECKED,
            {"mergeable": "UNKNOWN"},
            EXIT_NOT_CHECKED,
            "UNKNOWN is not the same",
        ),
        # Zero runs on a perfectly mergeable PR is the case the diagnosis must
        # NOT claim: something else is wrong and saying "CONFIRMED CAUSE" would
        # send the reader down the wrong path.
        (
            "clean but unchecked",
            EXIT_NOT_CHECKED,
            {"mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED"},
            EXIT_NOT_CHECKED,
            "mergeable=MERGEABLE",
        ),
        ("green and clean says nothing", EXIT_OK, {"mergeable": "MERGEABLE"}, EXIT_OK, ""),
        # THE REFINEMENT (measured 2026-08-20 on #395, see `diagnose`). Every
        # check green AND conflicting: the runs were created before the base
        # moved and are never withdrawn, so they describe a merge commit that no
        # longer exists. Every other surface calls this ready to merge.
        (
            "green but conflicting",
            EXIT_OK,
            {"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"},
            EXIT_STALE,
            "GREEN, BUT STALE",
        ),
        # UNKNOWN with a green set stays 0 on purpose — it is the normal state
        # for seconds after any push, and failing here would cry wolf. It still
        # has to SAY so, or the tolerance is indistinguishable from not looking.
        (
            "green but mergeability not yet computed",
            EXIT_OK,
            {"mergeable": "UNKNOWN"},
            EXIT_OK,
            "UNKNOWN",
        ),
    ]
    for label, code_in, facts, want_code, want in diagnoses:
        got_code, note = diagnose(code_in, facts)
        if got_code != want_code:
            failures.append(
                f"  diagnose/{label}: exit {got_code}, expected {want_code}"
            )
        elif want == "":
            if note != "":
                failures.append(f"  diagnose/{label}: expected silence, got {note!r}")
        elif want not in note:
            failures.append(f"  diagnose/{label}: {note!r} does not mention {want!r}")
    if "CONFIRMED CAUSE" in diagnose(EXIT_NOT_CHECKED, {"mergeable": "MERGEABLE"})[1]:
        failures.append("  diagnose: claims the conflict cause on a mergeable PR")
    # A green set on a conflicting PR must never exit 0 — the single most
    # misreadable state in this whole area.
    if diagnose(EXIT_OK, {"mergeable": "CONFLICTING"})[0] == EXIT_OK:
        failures.append("  diagnose: a green set on a CONFLICTING pull request exits 0")

    # And the workflow parser, against the real files rather than a fixture —
    # the constant it cross-checks is the thing that stops a broken parser
    # silently lowering the bar.
    names, problems = expected_check_names()
    for problem in problems:
        failures.append("  workflow parsing: " + problem.splitlines()[0])

    # Pin the NAMES, not only the count. Review found a case the count misses:
    # a trailing comment on a job key (`  mobile:  # expo`) stops that line
    # matching the job-key pattern, so the following `name:` OVERWRITES the
    # previous job's — `Scripts (Python)` silently became `Mobile (Expo)`. That
    # happened to move the count too, which is the only reason it was visible.
    # A corruption that preserves the count would otherwise sail through.
    if names and sorted(names) != sorted(FIVE):
        failures.append(
            f"  workflow parsing: derived {names}, expected the five in FIVE.\n"
            "  If CI's job names genuinely changed, update FIVE and "
            "EXPECTED_CHECK_RUNS together."
        )

    # Two parser fixtures, for guards whose effect on the CURRENT ci.yml is nil
    # and which would therefore read as dead code to the next person.
    on_block_with_comment = (
        "name: CI\n"
        "\n"
        "on:\n"
        "# a column-0 comment, which is what `strip_comments` is for\n"
        "  pull_request:\n"
        "\n"
        "jobs:\n"
        "  only:\n"
        "    name: Only\n"
    )
    if not triggers_on_pull_request(strip_comments(on_block_with_comment)):
        failures.append(
            "  strip_comments: a column-0 comment inside `on:` hides the "
            "pull_request trigger, dropping the whole workflow silently"
        )
    if triggers_on_pull_request(on_block_with_comment):
        failures.append(
            "  fixture is inert: it passes without strip_comments, so it "
            "proves nothing about the guard it covers"
        )

    if failures:
        print("check-ci-checks self-test FAILED:", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1

    print(
        f"ci-check detector ok — {len(vectors)} decision vectors, "
        f"{len(diagnoses)} diagnosis vectors, "
        f"{len(names)} check(s) declared by the workflows ({', '.join(names)})"
    )
    return EXIT_OK


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert a pull request's head commit really was checked."
    )
    # Mutually exclusive: with both, `--sha` used to win silently and answer a
    # question nobody asked — and it skips the conflict diagnosis, so the answer
    # was quieter as well as wrong. Found in review.
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--pr", help="pull request number (default: the current branch's)")
    target.add_argument(
        "--sha",
        help="check a raw commit instead of a pull request — no headRefOid "
        "resolution and no conflict diagnosis",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="exercise the decision logic offline; this is what `verify` runs",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    expected, problems = expected_check_names()
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return EXIT_ERROR

    try:
        slug = repo_slug()
        if args.sha:
            sha, facts = args.sha, None
            print(f"commit {sha} in {slug}")
        else:
            facts = pr_facts(args.pr)
            sha = facts["headRefOid"]
            print(
                f"PR #{facts['number']} ({facts['headRefName']}) in {slug}\n"
                f"head commit (headRefOid): {sha}"
            )
        runs = check_runs_for(slug, sha)
    except (RuntimeError, OSError) as err:
        # EXIT_ERROR, not EXIT_NOT_CHECKED. "I could not ask GitHub" and
        # "GitHub says nothing ran" are different answers with different
        # remedies, and giving them one exit code would blur the single signal
        # this script exists to produce. `OSError` covers `gh` missing from
        # PATH, which otherwise exits 1 with a traceback.
        print(str(err) or repr(err), file=sys.stderr)
        return EXIT_ERROR

    code, lines = evaluate(expected, runs)

    note = ""
    if facts is not None:
        # `diagnose` may REVISE the code: a green set on a CONFLICTING pull
        # request is EXIT_STALE, not EXIT_OK. So it has to run before the
        # stream is chosen, or the one state a human misreads would be printed
        # to stdout looking like a pass.
        code, note = diagnose(code, facts)

    stream = sys.stdout if code == EXIT_OK else sys.stderr
    print("\n".join(lines), file=stream)
    if note:
        print("\n" + note, file=stream)

    return code


if __name__ == "__main__":
    sys.exit(main())
