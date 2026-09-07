#!/usr/bin/env python3
"""Run the backend integration test gate — `test:api:integration` / `test:api:all`.

## The failure this closes (#546)

`go test ./...` and `TEST_DATABASE_URL` unset are, from the outside, silent —
`backend/internal/platform/testdb.Main` (every Postgres-backed package's
`TestMain` routes through it) just calls `m.Run()` and every Postgres test
inside it skips itself. The package still prints `ok`. The overall exit code
is still 0. That is the RIGHT default for a human running one package's tests
without Postgres set up locally, and it is exactly the WRONG thing for an
autonomous run to read as "the integration suite passed" — a worker that only
checks the exit code cannot tell "verified against a real database" from
"never touched one."

CI has never hit this: the `Backend (Go)` job provisions a real Postgres and
sets `TEST_DATABASE_URL` at job level, so its `go test` runs have always
exercised the real thing. This script exists for every OTHER caller — an
autonomous agent, a fresh checkout, a future runbook — which cannot assume
that the way a human contributor safely can.

## What each mode does

  --mode integration   Fails immediately, naming the missing variable, if
                        TEST_DATABASE_URL is unset — no `go test` invocation
                        at all. With it set, runs the full suite once, with
                        REQUIRE_TEST_DATABASE=1 for defense in depth (see
                        below), and passes its exit code straight through.

  --mode all            Everything `integration` does, PLUS: parses `go
                        test`'s own `-json` event stream and fails if any
                        test skipped other than the one this repo's suite
                        has always had — `TestLiveComplete`, gated on
                        LLM_LIVE=1 because it spends real money on a live API
                        call (see CLAUDE.md "Verify that a check can fail"
                        and the vola-testing skill — this is the documented,
                        measured "exactly one legitimate skip" invariant).
                        This is the "did an integration test silently skip
                        for some OTHER reason" half of the ticket: renaming
                        one Postgres test to skip must turn this red, not
                        leave it green.

There is no `--mode unit`: `test:api:unit` is unchanged from the original
`test:api` (`cd backend && go test -p 1 -timeout 3m ./...`) and needs none of
this — skipping without a database is exactly what it is for.

## Why a wrapper script rather than only the Go-side REQUIRE_TEST_DATABASE env

Both exist, and they check different things. `testdb.RequireEnv`
(`REQUIRE_TEST_DATABASE`) is real defense in depth — every Postgres-backed
package's `TestMain` honours it, so a `go test` invoked directly with that
variable set still fails loudly. But it only fires from INSIDE a package's
`TestMain`, and this repo has exactly one Postgres-testing package that
deliberately has none: `internal/platform/testdb` itself, which needs raw,
uncoordinated connections to test the lock apparatus directly (see its own
"Deliberately NO TestMain here" comment) and so checks TEST_DATABASE_URL
per-test like every package did before #454. Relying solely on the Go-side
check would let THAT package's tests skip silently under `--mode all` with no
database configured. The wrapper's own precondition check, run before `go
test` starts at all, has no such gap — it is one process-wide check that
applies before any package gets a chance to skip anything.

## Why "did anything skip beyond the one exception" rather than a hardcoded count

A hardcoded expected-test-count is brittle against the ordinary churn of
adding tests, and this repo's own tests grow constantly. Counting SKIPS
instead is far more stable: the backend suite has had exactly one legitimate
skip for a long time (measured repeatedly in the vola-testing skill), so any
second skip is already an anomaly worth investigating regardless of this
ticket. Matching by the ALLOWED test name (not just a bare count) also means
a NEW skip cannot hide behind TestLiveComplete's own skip going away for
some unrelated reason — the two are independent.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"

DB_ENV = "TEST_DATABASE_URL"
REQUIRE_ENV = "REQUIRE_TEST_DATABASE"

# The one skip this repo's backend suite has always had, measured repeatedly
# (see CLAUDE.md "Verify that a check can fail" and the vola-testing skill).
# Matched against the TOP-LEVEL test name (a Go subtest reports as
# "TestFoo/case", so this strips at the first "/") because a *new* skip
# nested under an already-allowed top-level test would otherwise slip
# through unnoticed. If you deliberately add another legitimate skip, add it
# here with a comment explaining why — the same way this one is documented —
# rather than loosening the check that finds one.
ALLOWED_SKIP_TESTS = {"TestLiveComplete"}

GO_TEST_ARGS = ["go", "test", "-p", "1", "-timeout", "3m"]


def fail_fast_if_no_database() -> None:
    """The literal ask in #546's acceptance criteria: fail immediately, by
    name, rather than let `go test` start and skip its way to a green exit.
    """
    if os.environ.get(DB_ENV):
        return
    print(
        f"{DB_ENV} is not set.\n\n"
        "test:api:integration and test:api:all REQUIRE a real Postgres — they\n"
        "exist so an autonomous run can never mistake \"no database\" for \"all\n"
        f"green\" (see #546). Provision one and set {DB_ENV}, e.g.:\n\n"
        "  docker compose exec postgres createdb -U vola vola_test\n"
        "  cd backend && DATABASE_URL=postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable \\\n"
        "      go run ./cmd/migrate up\n"
        f"  export {DB_ENV}=postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable\n\n"
        "Run `pnpm run test:api:unit` instead if you deliberately want to run "
        "without one.",
        file=sys.stderr,
    )
    sys.exit(1)


def run_integration() -> int:
    env = {**os.environ, REQUIRE_ENV: "1"}
    return subprocess.call([*GO_TEST_ARGS, "./..."], cwd=BACKEND, env=env)


def run_all() -> int:
    env = {**os.environ, REQUIRE_ENV: "1"}
    proc = subprocess.Popen(
        [*GO_TEST_ARGS, "-json", "./..."],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    skips: list[tuple[str, str]] = []  # (package, test)
    saw_any_line = False
    assert proc.stdout is not None
    for line in proc.stdout:
        saw_any_line = True
        line = line.rstrip("\n")
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # `go test -json` is documented to emit this on a build failure
            # that happens before JSON framing can start — surface it as-is
            # rather than silently dropping a line we can't parse.
            print(line)
            continue
        output = event.get("Output")
        if output is not None:
            sys.stdout.write(output)
        if event.get("Action") == "skip" and event.get("Test"):
            skips.append((event.get("Package", "?"), event["Test"]))

    code = proc.wait()

    # A `go test` invocation that produced literally nothing is not evidence
    # of anything — see CLAUDE.md "Verify that a check can fail" / "absence
    # is not evidence". Treat a silent, empty stream as a failure rather than
    # trusting whatever exit code came with it.
    if not saw_any_line:
        print(
            "go test produced no output at all — refusing to treat that as a "
            "pass. Something upstream (a build, the go toolchain itself) "
            "likely never ran.",
            file=sys.stderr,
        )
        return 1

    unexpected = [
        (pkg, test)
        for pkg, test in skips
        if test.split("/", 1)[0] not in ALLOWED_SKIP_TESTS
    ]

    if unexpected:
        print(
            f"\ntest:api:all requires zero skips beyond {sorted(ALLOWED_SKIP_TESTS)} "
            f"(TestLiveComplete, gated on LLM_LIVE=1 — spends real money) — found "
            f"{len(unexpected)} unexpected skip(s):\n",
            file=sys.stderr,
        )
        for pkg, test in unexpected:
            print(f"  {pkg}  {test}", file=sys.stderr)
        print(
            "\nAn integration test that skips for any other reason silently drops "
            "coverage while the run still looks green — see #546. If this is a "
            "genuinely new, deliberate skip, add it to ALLOWED_SKIP_TESTS in "
            "scripts/check-api-tests.py with a reason, the way TestLiveComplete is "
            "documented there — don't just widen this message away.",
            file=sys.stderr,
        )
        return 1

    if code != 0:
        return code

    seen_names = sorted({test for _, test in skips})
    print(f"\ntest:api:all: {len(skips)} skip(s), all accounted for ({seen_names}).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["integration", "all"], required=True)
    args = parser.parse_args()

    fail_fast_if_no_database()

    if args.mode == "integration":
        return run_integration()
    return run_all()


if __name__ == "__main__":
    sys.exit(main())
