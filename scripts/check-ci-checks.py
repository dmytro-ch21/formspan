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
so no workflow run is created at all** — silently, with no failure, no
annotation and no check.

Measured on the branch in #368: it merged cleanly at 22:09Z and got its run; six
minutes later `main` moved and the branch began conflicting in `docs/TASKS.md`
and `docs/testing/functional-scenarios.md`; from there every push and the
close/reopen produced nothing; the force-push that rebased it onto current
`main` produced a full five within four seconds. Confirmed prospectively on a
deliberately conflicting throwaway pull request (#393), which received zero runs
while `mergeable` read `CONFLICTING`.

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
3. Nothing has failed, and nothing is still running. A pending check is not a
   pass, so it exits non-zero too, with its own code.

Expected checks are derived from the workflow files rather than hardcoded, so a
new CI job raises the bar automatically. `EXPECTED_CHECK_RUNS` is a literal
somebody measured, cross-checked against that derivation: if they disagree the
script fails loudly rather than trusting either. A parser that silently found
one job would otherwise make this whole check vacuous.

## What it does not promise

- **It cannot tell you a check was meaningful**, only that it ran and concluded.
  A job whose steps were all deleted still reports `success`.
- **It is not a gate in `verify`.** `verify` runs before a pull request exists
  and must work offline; this needs the network and an authenticated `gh`. Its
  `--self-test` mode is the part that runs in `verify`, and that mode proves the
  decision logic still rejects the zero-run case rather than proving anything
  about any pull request.
- **Re-runs are not a failure.** A re-run adds a second run with the same name,
  so the raw count can exceed the expected one legitimately; the name set is
  what has to be complete.
- It reads `mergeable` for the diagnosis, and GitHub computes that lazily — an
  `UNKNOWN` immediately after a push means "ask again in a moment", not "fine".
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
EXPECTED_CHECK_RUNS = 5

# A check run that has concluded acceptably. `skipped` and `neutral` are here
# because GitHub uses them for a job that legitimately did not need to do work;
# neither means "failed".
GOOD_CONCLUSIONS = {"success", "neutral", "skipped"}

EXIT_OK = 0
EXIT_NOT_CHECKED = 1  # zero runs, or a declared check missing — the N65 case
EXIT_FAILED = 2  # the checks ran and something is red
EXIT_PENDING = 3  # the checks ran and have not finished

REMEDY = (
    "  git fetch origin && git rebase origin/main && git push --force-with-lease"
)


# --------------------------------------------------------------------------
# What CI declares
# --------------------------------------------------------------------------


def strip_comments(text: str) -> str:
    """Drop whole-line YAML comments.

    Same reason as `check-verify-chain.py`: a commented-out job must not count
    as a job CI runs. `ci.yml` in this repo carries long comment blocks whose
    prose contains the word `pull_request`, so this is load-bearing here, not
    defensive habit.
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
        if re.search(r"^\s+matrix:\s*$", text, re.MULTILINE):
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
    payload = json.loads(
        gh(["api", f"repos/{slug}/commits/{sha}/check-runs?per_page=100"])
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


FIVE = ["Backend (Go)", "Web (Next.js)", "Admin (Next.js)", "Scripts (Python)", "Mobile (Expo)"]


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
        ("four of five", FIVE, [_run(n) for n in FIVE[:4]], EXIT_NOT_CHECKED, "MISSING"),
        (
            "one failed",
            FIVE,
            [_run(n) for n in FIVE[:4]] + [_run(FIVE[4], conclusion="failure")],
            EXIT_FAILED,
            "FAILED",
        ),
        (
            "one still running",
            FIVE,
            [_run(n) for n in FIVE[:4]] + [_run(FIVE[4], status="in_progress", conclusion=None)],
            EXIT_PENDING,
            "STILL RUNNING",
        ),
        # A re-run legitimately duplicates a name; that is not a failure.
        ("a re-run", FIVE, [_run(n) for n in FIVE] + [_run(FIVE[0])], EXIT_OK, "passed"),
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

    # And the workflow parser, against the real files rather than a fixture —
    # the constant it cross-checks is the thing that stops a broken parser
    # silently lowering the bar.
    names, problems = expected_check_names()
    for problem in problems:
        failures.append("  workflow parsing: " + problem.splitlines()[0])

    if failures:
        print("check-ci-checks self-test FAILED:", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1

    print(
        f"ci-check detector ok — {len(vectors)} decision vectors, "
        f"{len(names)} check(s) declared by the workflows ({', '.join(names)})"
    )
    return EXIT_OK


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert a pull request's head commit really was checked."
    )
    parser.add_argument("--pr", help="pull request number (default: the current branch's)")
    parser.add_argument(
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
        return EXIT_NOT_CHECKED

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
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return EXIT_NOT_CHECKED

    code, lines = evaluate(expected, runs)
    stream = sys.stdout if code == EXIT_OK else sys.stderr
    print("\n".join(lines), file=stream)

    if facts is not None:
        mergeable = facts.get("mergeable")
        if code == EXIT_NOT_CHECKED and mergeable == "CONFLICTING":
            print(
                "\nCONFIRMED CAUSE: `mergeable` is CONFLICTING. GitHub cannot "
                "build this pull request's merge ref, so no workflow run exists. "
                "Rebase (above) and the checks appear within seconds.",
                file=sys.stderr,
            )
        elif code == EXIT_NOT_CHECKED and mergeable == "UNKNOWN":
            print(
                "\n`mergeable` is UNKNOWN — GitHub computes it lazily. Re-run "
                "this in a few seconds before concluding anything; UNKNOWN is "
                "not the same as MERGEABLE.",
                file=sys.stderr,
            )
        elif code != EXIT_OK:
            print(f"\nmergeable={mergeable} mergeStateStatus={facts.get('mergeStateStatus')}",
                  file=sys.stderr)

    return code


if __name__ == "__main__":
    sys.exit(main())
