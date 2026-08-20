#!/usr/bin/env python3
"""Fail a pull request that is READY FOR REVIEW and contains no work.

## The failure this prevents

**A PR can sit at 5/5 green, `MERGEABLE`, and contain nothing at all.**
Measured 2026-08-19 on #355: `git diff --stat origin/main...origin/feat/n70-navigation`
was **empty**. The branch was one commit — the `--allow-empty` claim commit the
convention asks for. It was green *because there was nothing in it to fail*, and
it was about to be merged into a release build. A peer read the diff and stopped
it.

Nothing in the existing signals separates that from a real green PR. The checks
API says five runs, all successful, in both cases. `mergeStateStatus` says
`CLEAN` in both cases. The PR list shows a title in both cases. **The only
difference lives in the diff, and looking at it is a step that depends on
somebody remembering.**

## Why the obvious fix is wrong

"Reject empty branches" would break the thing it is protecting. **A draft is
allowed to be empty**, and at the time this was written it was *required* to be:
`git commit --allow-empty -m "Claim X"` followed by `gh pr create --draft` was
how every task in this repo was claimed, so every claimed task passed through
green-and-empty. A check that fires on that fires on every claim and is disabled
inside a day.

That convention was retired hours later — #399 moved claiming to GitHub Issues,
where a claim is an assignee and needs no commit at all. **The draft exemption
survives the change and is not a leftover.** A draft PR means "I am working on
this"; an empty one is a branch somebody has pushed early, which is a normal and
useful thing to do and nothing to fail a build over. The signal was never the
emptiness.

So the gate is on the **transition out of draft** with an empty diff — the one
moment a PR stops saying "I am working on this" and starts saying "this is
finished". That is the event nothing marked, and it is the same event under
either convention.

## Not to be confused with N65 (#368)

Same family, different member, and they need different detectors:

| | N65 / #368 | this |
|---|---|---|
| what happened | the checks **did not run** | the checks ran and had **nothing to test** |
| `check_runs \\| length` | `0` | `5` |
| detector | count the runs | diff the contents |

A count check passes this case cleanly, because five checks genuinely did run.
Neither covers the other; both are needed.

**Note for #368: this workflow makes the expected count 6, not 5.** It is a
separate workflow, so it is a separate check run, and it runs on drafts too —
so the count is stable at 6 in both states rather than moving with draftness.

## How it decides

Only from the `pull_request` event payload plus git:

1. `pull_request.draft` is true  -> **pass**, and say so. Work in progress is
   not a fault.
2. otherwise, three-dot-diff `base.sha...head.sha`; empty -> **fail**.

`base.sha` comes from the payload rather than from `origin/main`, so the check
is correct for a PR stacked on another feature branch — which this repo has, and
whose CI trigger is deliberately unfiltered by base branch for exactly that
reason.

## Absence must not read as success

This check exists because an absent signal was read as a passing one, so it must
not commit the same error one level up. **Every unknown is a failure, never a
skip:**

- no event payload, or one that will not parse -> fail
- `draft` missing from the payload -> fail (defaulting it to true would turn a
  payload change into a permanently-disabled gate, silently)
- either sha missing from the local clone -> fail (this is a fetch-depth
  problem, and a shallow clone must not be able to quietly answer "no diff")
- the two shas share no merge base -> fail
- git exiting non-zero anywhere -> fail

There is one deliberate non-failure, and it is a *corroboration* rather than the
check. GitHub puts `changed_files` on the PR object; when it is there it is
compared against what git measured, and a **disagreement fails**, because that
means one of the two is measuring the wrong commits. When the field is absent
the script says so loudly and proceeds on git alone — requiring it would mean a
payload-shape change on GitHub's side turns every PR in the repo red at once,
which is a large blast radius for a second opinion. Git is the ground truth
either way, and git alone still fails the case this exists for.

## Verifying that it can fail

`--self-test` builds **real git repositories** in a temp directory and runs this
script end to end against synthesised payloads — the empty-and-ready case must
come back red, the empty-and-draft case green, and each of the unknown-input
cases above red. It is what `pnpm run verify` runs, since there is no pull
request locally to check. A check whose only evidence is that it went green has
demonstrated that it runs, not that it detects.

Two live runs were also measured on a real PR (see history.md, 2026-08-20) —
the same PR, draft then ready, going green then red on the transition alone.

Stdlib-only, matching its siblings, so `verify` needs no Python toolchain.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Exit codes. Anything that is not a clean pass is a 1; there is no third
# outcome on purpose, because a "warned" state is one nobody looks at.
PASS = 0
FAIL = 1


class CheckError(Exception):
    """Something could not be determined. Always terminal — never a skip."""


def git(repo: Path, *args: str) -> str:
    """Run git, or raise. A non-zero git is never treated as 'no differences'."""
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise CheckError(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout


def commit_exists(repo: Path, sha: str) -> bool:
    proc = subprocess.run(
        ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def changed_files(repo: Path, base_sha: str, head_sha: str) -> list[str]:
    """Files in the three-dot diff `base...head`, with the refs proved first.

    Every step that could make an empty answer mean 'I could not look' is
    checked before the diff is taken, so an empty return means an empty diff
    and nothing else.
    """
    for label, sha in (("base", base_sha), ("head", head_sha)):
        if not sha or len(sha) < 7:
            raise CheckError(f"{label} sha missing or implausible: {sha!r}")
        if not commit_exists(repo, sha):
            raise CheckError(
                f"{label} commit {sha} is not in this clone. "
                "Fetch it (fetch-depth: 0) — a shallow clone must not be able "
                "to answer 'no diff' by not having the commits."
            )

    merge_base = git(repo, "merge-base", base_sha, head_sha).strip()
    if not merge_base:
        raise CheckError(f"no merge base between {base_sha} and {head_sha}")

    # Guard the other direction too. A wrong base makes an empty diff look like
    # real work, which fails OPEN — so assert the merge base really is common
    # ancestry rather than trusting that it is.
    for label, sha in (("base", base_sha), ("head", head_sha)):
        proc = subprocess.run(
            ["git", "merge-base", "--is-ancestor", merge_base, sha],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise CheckError(
                f"merge base {merge_base[:12]} is not an ancestor of {label} "
                f"{sha[:12]} — the refs are not what this check thinks they are."
            )

    out = git(repo, "diff", "--name-only", f"{merge_base}..{head_sha}")
    return [line for line in out.splitlines() if line.strip()]


def load_event(path: Path) -> dict:
    if not path.exists():
        raise CheckError(f"event payload not found at {path}")
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckError(f"event payload at {path} would not parse: {exc}") from exc
    if not isinstance(payload, dict):
        raise CheckError(f"event payload at {path} is not an object")
    return payload


def check(repo: Path, payload: dict, out=None) -> int:
    # `out=None` rather than `out=sys.stdout`: a default argument is bound
    # once, at import, so a `sys.stdout` default captures the REAL stdout and
    # `contextlib.redirect_stdout` silently does nothing to it. The self-test
    # found this by leaking its own fixture output into `verify`.
    out = sys.stdout if out is None else out
    pr = payload.get("pull_request")
    if not isinstance(pr, dict):
        raise CheckError(
            "payload has no `pull_request` object — this check only makes sense "
            "on a pull_request event."
        )

    # Explicit membership test, not `pr.get("draft", True)`. Defaulting a
    # missing field to draft would make a payload change disable the gate with
    # nothing going red, which is the exact shape of bug this file exists for.
    if "draft" not in pr:
        raise CheckError("payload's `pull_request` has no `draft` field")
    draft = pr["draft"]
    if not isinstance(draft, bool):
        raise CheckError(f"`draft` is not a boolean: {draft!r}")

    number = pr.get("number", "?")

    if draft:
        print(
            f"PR #{number} is a draft — not checked. "
            "A draft is work in progress, and an empty one is a branch "
            "pushed early — legal, and nothing to fail a build over.",
            file=out,
        )
        return PASS

    base_sha = (pr.get("base") or {}).get("sha") or ""
    head_sha = (pr.get("head") or {}).get("sha") or ""
    files = changed_files(repo, base_sha, head_sha)

    # Second opinion, when GitHub offers one. A disagreement means one of the
    # two is looking at the wrong commits; that is worth a red build, because
    # the failure it would otherwise hide is this check passing vacuously.
    reported = pr.get("changed_files")
    if isinstance(reported, int):
        if (reported == 0) != (len(files) == 0):
            raise CheckError(
                f"git and GitHub disagree about PR #{number}: git sees "
                f"{len(files)} changed file(s) between {base_sha[:12]}..."
                f"{head_sha[:12]}, GitHub reports {reported}. One of them is "
                "measuring the wrong commits; this check is not trustworthy "
                "until that is resolved."
            )
    else:
        print(
            "note: the payload carries no `changed_files`, so git's answer is "
            "uncorroborated. Proceeding on git alone.",
            file=out,
        )

    if not files:
        print(
            f"PR #{number} is READY FOR REVIEW and its diff is EMPTY.\n"
            f"\n"
            f"  git diff --stat {base_sha[:12]}...{head_sha[:12]}   ->   no changes\n"
            f"\n"
            "Marking a PR ready says the work is finished; there is no work in "
            "it. This is almost always a branch pushed early — an empty commit, "
            "or work that was committed somewhere else — marked ready before "
            "its content arrived. Such a PR is 5/5 green and MERGEABLE "
            "precisely because there is nothing in it to fail.\n"
            "\n"
            "Either push the work, or convert the PR back to draft "
            "(`gh pr ready --undo <n>`), which passes this check.",
            file=out,
        )
        return FAIL

    shown = ", ".join(files[:5]) + (" …" if len(files) > 5 else "")
    print(
        f"PR #{number} is ready and carries {len(files)} changed file(s): {shown}",
        file=out,
    )
    return PASS


# --------------------------------------------------------------------------
# Self-test: the part that proves this can fail.
# --------------------------------------------------------------------------

def _run(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _build_repo(root: Path) -> tuple[Path, str, str, str]:
    """A repo with a base commit, an empty-commit branch, and a real-work branch.

    Returns (repo, base_sha, empty_head_sha, work_head_sha).
    """
    repo = root / "repo"
    repo.mkdir()
    _run(repo, "init", "-q", "-b", "main")
    _run(repo, "config", "user.email", "selftest@example.invalid")
    _run(repo, "config", "user.name", "self test")
    (repo / "README.md").write_text("base\n")
    _run(repo, "add", "README.md")
    _run(repo, "commit", "-q", "-m", "base")
    base_sha = git(repo, "rev-parse", "HEAD").strip()

    # The claim branch: one empty commit, exactly as CLAUDE.md prescribes.
    _run(repo, "checkout", "-q", "-b", "claim")
    _run(repo, "commit", "-q", "--allow-empty", "-m", "Claim X — a task")
    empty_head = git(repo, "rev-parse", "HEAD").strip()

    # The finished branch: the claim commit plus actual work on top.
    _run(repo, "checkout", "-q", "-b", "work")
    (repo / "feature.txt").write_text("real work\n")
    _run(repo, "add", "feature.txt")
    _run(repo, "commit", "-q", "-m", "the work")
    work_head = git(repo, "rev-parse", "HEAD").strip()

    _run(repo, "checkout", "-q", "main")
    return repo, base_sha, empty_head, work_head


def _unparseable(directory: Path) -> Path:
    path = directory / "garbage.json"
    path.write_text("{ this is not json")
    return path


def _payload(draft: bool, base_sha: str, head_sha: str, **over) -> dict:
    pr: dict = {
        "number": 1,
        "draft": draft,
        "base": {"sha": base_sha},
        "head": {"sha": head_sha},
    }
    pr.update(over)
    return {"pull_request": pr}


def self_test() -> int:
    """Run the check against real repos and assert BOTH directions.

    Written as cases with an expected outcome rather than as a happy path,
    because the only interesting property of this file is that the red case
    goes red.
    """
    import contextlib
    import io

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        repo, base, empty_head, work_head = _build_repo(Path(tmp))

        # (name, payload-or-None, expected)
        # `None` payload means "expect a CheckError", i.e. an unknown input.
        cases: list[tuple[str, dict | None, int]] = [
            (
                "empty diff + READY  -> red (the whole point)",
                _payload(False, base, empty_head, changed_files=0),
                FAIL,
            ),
            (
                "empty diff + draft  -> green (a legitimate work-in-progress draft)",
                _payload(True, base, empty_head, changed_files=0),
                PASS,
            ),
            (
                "real diff + READY   -> green",
                _payload(False, base, work_head, changed_files=1),
                PASS,
            ),
            (
                "real diff + draft   -> green",
                _payload(True, base, work_head, changed_files=1),
                PASS,
            ),
            (
                "empty diff + READY, no changed_files field -> still red",
                _payload(False, base, empty_head),
                FAIL,
            ),
            (
                "base == head (nothing at all) + READY -> red",
                _payload(False, base, base, changed_files=0),
                FAIL,
            ),
        ]

        # Built literally rather than through `_payload`, because the point of
        # each is a payload that is the WRONG SHAPE — a helper that normalises
        # them would test the helper instead.
        #
        # The third element is a substring the failure MESSAGE must contain,
        # and it is not decoration. Two of these guards are redundant in their
        # EFFECT — delete the `commit_exists` check and `git merge-base` fails
        # on the same input a moment later, so the case still goes red and the
        # mutation survives, which reads as dead code to the next person.
        # Asserting the message is what makes the specific guard load-bearing.
        # (CLAUDE.md: "a guard whose outcome is redundant still needs a test,
        # on its message if not its effect".)
        errors: list[tuple[str, dict, str]] = [
            ("no pull_request object",
             {"action": "opened"},
             "no `pull_request` object"),
            ("no draft field",
             {"pull_request": {"number": 1, "base": {"sha": base},
                               "head": {"sha": work_head}}},
             "no `draft` field"),
            ("draft is not a boolean",
             {"pull_request": {"number": 1, "draft": "false",
                               "base": {"sha": base},
                               "head": {"sha": work_head}}},
             "not a boolean"),
            ("head sha absent from the clone",
             _payload(False, base, "0" * 40, changed_files=1),
             "is not in this clone"),
            ("base sha absent from the clone",
             _payload(False, "0" * 40, work_head, changed_files=1),
             "is not in this clone"),
            ("head sha missing entirely",
             {"pull_request": {"number": 1, "draft": False,
                               "base": {"sha": base}, "head": {}}},
             "missing or implausible"),
            ("git/GitHub disagree about emptiness",
             _payload(False, base, empty_head, changed_files=7),
             "disagree"),
        ]

        for name, payload, expected in cases:
            assert payload is not None
            buf = io.StringIO()
            try:
                got = check(repo, payload, out=buf)
            except CheckError as exc:
                failures.append(f"{name}: raised CheckError({exc})")
                continue
            if got != expected:
                failures.append(
                    f"{name}: expected exit {expected}, got {got}\n"
                    f"    output: {buf.getvalue().strip()[:200]}"
                )

        for name, payload, expected_message in errors:
            buf = io.StringIO()
            try:
                got = check(repo, payload, out=buf)
            except CheckError as exc:
                if expected_message not in str(exc):
                    failures.append(
                        f"unknown input '{name}' failed, but not for the stated "
                        f"reason — expected {expected_message!r} in the message, "
                        f"got: {exc}"
                    )
                continue
            except Exception as exc:  # noqa: BLE001 - deliberate
                failures.append(
                    f"unknown input '{name}' raised {type(exc).__name__} rather "
                    f"than CheckError: {exc}. Unknowns must be reported, not "
                    "crash — a traceback is a red build for the wrong reason."
                )
                continue
            failures.append(
                f"unknown input '{name}' did NOT fail — returned {got}. "
                "An unknown must be a failure, never a skip."
            )

        # The cases above call `check` directly. `main` is the layer that turns
        # a CheckError into an exit code, and it is the layer that can silently
        # exit 0 on an unverifiable PR — the precise mistake this whole file is
        # about. Exercise it through its real entry point.
        event_dir = Path(tmp) / "events"
        event_dir.mkdir()

        def _write(name: str, payload: dict) -> str:
            path = event_dir / f"{name}.json"
            path.write_text(json.dumps(payload))
            return str(path)

        main_cases: list[tuple[str, list[str], int]] = [
            ("main: empty diff + ready -> exit 1",
             ["--repo", str(repo), "--event",
              _write("ready_empty", _payload(False, base, empty_head, changed_files=0))],
             FAIL),
            ("main: empty diff + draft -> exit 0",
             ["--repo", str(repo), "--event",
              _write("draft_empty", _payload(True, base, empty_head, changed_files=0))],
             PASS),
            ("main: real diff + ready -> exit 0",
             ["--repo", str(repo), "--event",
              _write("ready_work", _payload(False, base, work_head, changed_files=1))],
             PASS),
            ("main: event file does not exist -> exit 1",
             ["--repo", str(repo), "--event", str(event_dir / "nope.json")],
             FAIL),
            ("main: event file is not JSON -> exit 1",
             ["--repo", str(repo), "--event", str(_unparseable(event_dir))],
             FAIL),
            ("main: no event path at all -> exit 1",
             ["--repo", str(repo), "--event", ""],
             FAIL),
        ]
        for name, argv, expected in main_cases:
            sink = io.StringIO()
            try:
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    got = main(argv)
            except SystemExit as exc:  # argparse bailing out is still a failure
                got = int(exc.code or 0)
            except Exception as exc:  # noqa: BLE001 - deliberate
                failures.append(f"{name}: raised {type(exc).__name__}: {exc}")
                continue
            if got != expected:
                failures.append(
                    f"{name}: expected exit {expected}, got {got}\n"
                    f"    output: {sink.getvalue().strip()[:200]}"
                )

        # An apparatus check, in the spirit of CLAUDE.md's rule: prove the
        # fixture really does contain the two states being distinguished, so a
        # future edit that makes both branches identical cannot turn the whole
        # table green by making every case the same case.
        if changed_files(repo, base, empty_head):
            failures.append("fixture broken: the claim branch has a non-empty diff")
        if not changed_files(repo, base, work_head):
            failures.append("fixture broken: the work branch has an empty diff")

    if failures:
        print("self-test FAILED:\n", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return FAIL

    print(
        f"check-pr-has-work self-test ok — {len(cases)} verdict cases, "
        f"{len(errors)} unknown-input cases and {len(main_cases)} through "
        f"main(); both directions exercised."
    )
    return PASS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run the built-in end-to-end tests instead of checking a PR",
    )
    parser.add_argument(
        "--event",
        default=os.environ.get("GITHUB_EVENT_PATH"),
        help="path to the GitHub pull_request event payload",
    )
    parser.add_argument("--repo", default=str(ROOT), help="git repository root")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    try:
        if not args.event:
            raise CheckError(
                "no event payload given and GITHUB_EVENT_PATH is unset. This "
                "check reads a pull_request event; run it from CI, pass "
                "--event, or use --self-test locally."
            )
        return check(Path(args.repo), load_event(Path(args.event)))
    except CheckError as exc:
        # Terminal, and red. The one thing this must never do is decide it
        # cannot tell and exit 0.
        print(f"check-pr-has-work could not verify this PR: {exc}", file=sys.stderr)
        return FAIL


if __name__ == "__main__":
    sys.exit(main())
