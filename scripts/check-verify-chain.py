#!/usr/bin/env python3
"""Fail if a gate exists that neither `verify` nor CI runs.

## The failure this prevents

`verify` is one ~1,300-character line in `package.json` that every task appends
to. Two branches touching it always conflict — and always in a way where taking
one side looks like a correct resolution while silently deleting the other's
link.

**A dropped link is not a broken build. It is a gate that stops running while
`verify` still exits 0.** Nothing goes red. Nothing is missing from the tree.
The script is still there, still passing when invoked by hand. The next person
to find out is whoever ships the bug it existed to catch.

That is worse than the `README.md` merge trap it resembles: that one loses a
sentence, this one loses a guarantee. It happened for real on N50, where `main`
had added `check:tasks` at the front of the chain and the branch had added
`check:telemetry-parity` in the middle — either side taken wholesale drops the
other.

## What it asserts

Every **gate** — a script whose name starts with one of `GATE_PREFIXES` — must
be reachable from `verify`, unless it is named in `ALLOWED_OUTSIDE` with a
reason. Each allowed-outside gate must additionally be run **by CI**, so an
exclusion cannot quietly become a gate that runs nowhere at all.

"Reachable from `verify`" is TRANSITIVE: `typecheck:mobile` runs
`routes:mobile`, so a gate invoked inside another gate counts without being its
own link. Checking only the top-level chain would cry wolf on a correct setup,
and a checker that cries wolf is one somebody eventually silences.

### The version of this that did not work, because it is the obvious one

The first draft asserted "reachable from `verify` **or** from CI". It passed
every one of its own motivating cases: deleting `check:telemetry-parity` from
the chain, deleting `check:tasks`, deleting `lint:web` — all green, because **CI
independently runs each of them**, and CI mirrors `verify` almost exactly. The
`or CI` clause swallowed precisely the failure this script exists to detect.

It was caught by running the check in the failing direction rather than by
reading it, which is the only reason it is not in the repo. Recorded because the
reasoning that produced it is seductive: `build:web` really is deliberately
outside `verify`, so "or CI" looks like the tolerant, correct generalisation.
It is the escape hatch that makes the check unable to fail.

The exclusion list is the right shape instead: three names, each with a reason
somebody had to write, and each still required to run in CI.

## What it does not promise

Stdlib-only and syntactic, matching its siblings. **It reads names, not
behaviour**, and that limit is wider than it first looks:

- A link present but neutered — `|| true` appended — passes.
- A gate's BODY replaced with `true` passes. `"lint:web": "true"` is green
  here, and that form is likelier than the one above because it is shorter.
- It cannot know a gate is *meaningful*, only that something invokes it.

What it now does catch, after review found each of these defeating the first
version: a `#` truncating the chain, a commented-out CI step counting as CI
coverage, a bare `node …` link that is in the chain but is not a script and so
was protected by nothing, a renamed gate silently leaving the gate set, and a
generator prerequisite (`routes:mobile`) being dropped from inside another gate.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "package.json"
CI = ROOT / ".github/workflows/ci.yml"

# What counts as a gate. Deliberately broad: the finding was about ANY gate
# silently disappearing, and `lint:web` vanishing is exactly as bad as
# `check:python` vanishing. `dev:*` and one-off tools are not gates.
GATE_PREFIXES = (
    "check:", "lint:", "typecheck:", "test:", "fmt:", "vet:", "build:",
    # `routes:` is a GENERATOR, not a check — and it is load-bearing anyway.
    # `typecheck:mobile` runs it first, and without it Expo Router's typed
    # routes are never generated, so route literals type-check against a loose
    # `Href` and everything passes (N32 shipped a button pointing at a route
    # that never existed, exactly this way). Deleting that prerequisite leaves
    # `typecheck:mobile` present, green and silently weaker. Found in review.
    "routes:",
)

# The gate count may not silently fall. Renaming a gate out of GATE_PREFIXES —
# `check:python` to `python:syntax`, say — and dropping its link retires it
# with nothing objecting, because the check only ever sees the gates that are
# still named like gates. Same floor `check-tasks-integrity.py` puts on ids.
# Raise this deliberately when a gate is genuinely retired.
MIN_GATES = 27

# A CI command shorter than this substring-matches by accident.
MIN_CI_COMMAND_LEN = 12

# Gates that legitimately run in neither place need a REASON, not just an
# entry. An exclusion list you can append to silently is the same hole this
# script exists to close, one level up — so every entry is a sentence somebody
# had to write, and there are none today.
ALLOWED_OUTSIDE: dict[str, str] = {
    "test:api": "needs TEST_DATABASE_URL; skips silently without it, so it would "
                "pass vacuously in `verify`. CI provisions Postgres and runs it.",
    "build:web": "slow, and CI runs it. `verify` is the fast local gate.",
    "build:admin": "slow, and CI runs it. `verify` is the fast local gate.",
}


def script_deps(body: str) -> set[str]:
    """Script names a body invokes, so coverage can be transitive."""
    return set(re.findall(r"pnpm run ([\w:.-]+)", body))


def reachable_from(entry: str, scripts: dict[str, str]) -> set[str]:
    """Every script `entry` runs, directly or through another script."""
    seen: set[str] = set()
    stack = [entry]
    while stack:
        name = stack.pop()
        for dep in script_deps(scripts.get(name, "")):
            if dep not in seen:
                seen.add(dep)
                stack.append(dep)
    return seen


def strip_comments(text: str) -> str:
    """Drop whole-line YAML comments before matching.

    The first version substring-matched the RAW workflow, so a step commented
    out still counted as CI running it — meaning `build:web` could be removed
    from CI entirely and this check would stay green, because the words were
    still on the page. That is failing OPEN, and the docstring claimed it
    failed safe. Both are fixed. Found in review.
    """
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def gate_runs_in_ci(gate: str, body: str, ci_text: str) -> bool:
    """Whether CI runs this gate — by alias OR by the command behind it.

    CI mostly says `pnpm run <gate>`, but not always: the backend job runs
    `go test -p 1 -timeout 3m ./...` directly, which IS `test:api` — it just
    never names it. Matching only the alias reports that as an orphan, and a
    checker that cries wolf on a correct setup is one somebody eventually
    silences. Found on this script's very first run.

    The command comparison strips a leading `cd <dir> &&`, since CI sets a
    working directory instead. It is a heuristic and it fails SAFE: a command
    it cannot match produces a loud orphan report rather than a silent pass.
    """
    if f"pnpm run {gate}" in ci_text:
        return True
    command = re.sub(r"^\s*cd\s+\S+\s*&&\s*", "", body).strip()
    # A short body substring-matches too easily — `true`, `go vet ./...` and
    # `go build ./...` all appear in this workflow already, so a future
    # placeholder-length exclusion would match for free.
    return len(command) >= MIN_CI_COMMAND_LEN and command in ci_text


def main() -> int:
    scripts: dict[str, str] = json.loads(PKG.read_text())["scripts"]
    if "verify" not in scripts:
        print("package.json has no `verify` script — see this script's docstring.", file=sys.stderr)
        return 1

    covered = reachable_from("verify", scripts)
    ci_text = strip_comments(CI.read_text()) if CI.exists() else ""
    if not ci_text:
        print(f"{CI} is missing or empty; cannot check CI coverage.", file=sys.stderr)
        return 1

    # A `#` makes the rest of a shell line a comment, so the chain stops there
    # and exits 0 — while `script_deps` regexes over the raw string and still
    # reports every name after it as covered. One inserted character turns
    # twenty-six gates into five with nothing red anywhere, and it is the most
    # plausible artifact of a hand-edit on a 1,300-character line. Categorically
    # worse than the `|| true` case, which neuters one link rather than all of
    # them. Found in review.
    commented = sorted(n for n in covered | {"verify"} if "#" in scripts.get(n, ""))
    if commented:
        print("these scripts contain a `#`, which silently truncates the rest "
              "of the command:\n", file=sys.stderr)
        for name in commented:
            print(f"  {name}  ->  {scripts[name][:70]}", file=sys.stderr)
        print("\nEverything after it stops running while the script still exits 0.",
              file=sys.stderr)
        return 1

    gates = sorted(n for n in scripts if n.startswith(GATE_PREFIXES))
    if len(gates) < MIN_GATES:
        print(
            f"only {len(gates)} gates found, expected at least {MIN_GATES}.\n"
            "A gate renamed out of GATE_PREFIXES is retired silently — the check "
            "stops seeing it rather than reporting it.\nIf a gate was deliberately "
            "removed, lower MIN_GATES in the same commit.",
            file=sys.stderr,
        )
        return 1

    if not gates:
        # Never correct, and it would otherwise pass vacuously — the same
        # empty-comparison hole the telemetry parity check closes.
        print("no gates found in package.json, which is never right.", file=sys.stderr)
        return 1

    missing: list[str] = []
    unrun: list[str] = []
    for gate in gates:
        if gate in covered:
            continue
        if gate not in ALLOWED_OUTSIDE:
            missing.append(gate)
        elif not gate_runs_in_ci(gate, scripts[gate], ci_text):
            # Excluded from `verify` AND absent from CI: the exclusion has
            # become the hole. This is what stops ALLOWED_OUTSIDE turning into
            # the place inconvenient gates go to die.
            unrun.append(gate)

    stale = sorted(g for g in ALLOWED_OUTSIDE if g not in scripts)

    if missing or unrun or stale:
        if missing:
            print("these gates are NOT in the `verify` chain:\n", file=sys.stderr)
            for gate in missing:
                print(f"  {gate}  ->  {scripts[gate][:70]}", file=sys.stderr)
            print(
                "\nA gate missing from the chain is not a failing build — it is a "
                "check that silently stopped running, while `verify` still exits 0."
                "\nAdd it to `verify`, or add it to ALLOWED_OUTSIDE with a reason "
                "(and make sure CI runs it).",
                file=sys.stderr,
            )
        if unrun:
            print("\nthese gates are excluded from `verify` but CI does not run them "
                  "either:\n", file=sys.stderr)
            for gate in unrun:
                print(f"  {gate}  ({ALLOWED_OUTSIDE[gate]})", file=sys.stderr)
        if stale:
            # An entry for a script nobody has is a silent weakening: it looks
            # like a considered exclusion and guards nothing.
            print("\nALLOWED_OUTSIDE names scripts that do not exist:\n", file=sys.stderr)
            for gate in stale:
                print(f"  {gate}", file=sys.stderr)
        return 1

    outside = sorted(g for g in gates if g not in covered)
    print(
        f"verify chain ok — {len(gates)} gates, {len(gates) - len(outside)} in the chain, "
        f"{len(outside)} excluded and run by CI"
        + (f" ({', '.join(outside)})" if outside else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
