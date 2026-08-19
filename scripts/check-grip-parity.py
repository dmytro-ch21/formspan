#!/usr/bin/env python3
"""Fail if mobile's OFFLINE FALLBACK drifts from the table the server serves.

This used to police three hand-maintained copies of one rule. It now polices
one, and the promise it makes is smaller and worth stating precisely (N16).

The subsets are **served**: `GET /v1/exercises` carries `offered_grips` per row,
derived from `movement_pattern` by `exercise.OfferedGrips` in
`backend/internal/modules/exercise/grips.go`. `apps/web` reads that and nothing
else — its copy was deleted, because web fetches on render and has no cached row
that could predate the field.

`apps/mobile` keeps `gripsFor` in `lib/sessions.ts` as the fallback for
exercises cached before `offered_grips` existed. `exercise_cache` stores the
whole API object, so the field arrives on the next catalog fetch — but an
athlete who last synced before it shipped, then walked into a basement gym, has
a catalog without it. That copy is therefore deliberate, and this script is what
keeps it from becoming a second opinion.

What this can no longer prevent, and did not before either: a fallback that is
merely STALE. It matches the served table at the moment the check runs; after a
release changes the server's mind, phones on the old build fall back to the old
answer until they re-sync. That is inherent to an offline fallback and is
accepted — the server does not refuse a grip outside a movement's subset
(`ValidGrip` checks the vocabulary and stops), so over- or under-offering never
produces a 400.

Stdlib-only and syntactic on purpose, matching `check-python-syntax.py`: it
parses the three case tables rather than importing anything, so `verify` needs
no Go toolchain, no Node, and no Python packages. That also bounds what it can
promise — it compares the TABLES, not the behaviour around them, and a copy
that reformats its switch beyond these patterns will fail here as drift even
when it is correct. Fix the parser then; do not delete the check.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GO = ROOT / "backend/internal/modules/exercise/grips.go"
MOBILE = ROOT / "apps/mobile/lib/sessions.ts"

#: Sentinel for the `default:` branch, compared like any movement pattern.
DEFAULT_KEY = "<default>"


def parse_ts(path: Path) -> dict[str, list[str]]:
    body = _body(path.read_text(), r"export function gripsFor\([^)]*\)[^{]*\{")
    table: dict[str, list[str]] = {}
    pending: list[str] = []
    for line in body.splitlines():
        case = re.search(r"case ['\"](\w+)['\"]", line)
        if case:
            pending.append(case.group(1))
        ret = re.search(r"return \[(.*?)\]", line)
        if ret:
            vals = [v.strip().strip("\"'") for v in ret.group(1).split(",") if v.strip()]
            for p in pending:
                table[p] = vals
            pending = []
        if "default:" in line:
            # NOT discarded. The default decides what EVERY unlisted movement
            # pattern offers, so one app "helpfully" returning the full four
            # there while the others return nothing is real, athlete-visible
            # drift across every pattern outside the eight — and the first
            # version of this script could not see it. Found by review.
            pending = [DEFAULT_KEY]
    return table


def go_const_values(src: str) -> dict[str, str]:
    """Map `GripMixed` -> "mixed" from the const block.

    Resolved rather than assumed. The first version lowercased the constant
    NAME, so a constant whose wire value differed from its name (`GripHook Grip
    = "hook_grip"`) would have been reported as agreeing with TS while the two
    genuinely disagreed on the wire — and a legitimately snake_case value
    (`GripMixedLeft = "mixed_left"`) would have been reported as false drift.
    Found by review.
    """
    return dict(re.findall(r"\b(Grip\w+)\s+Grip\s*=\s*\"([^\"]+)\"", src))


def parse_go(path: Path) -> dict[str, list[str]]:
    src = path.read_text()
    # The table names its values as plain string literals now: it lives in the
    # catalog package, which must not import the logging module for a `Grip`
    # type. Constants are still resolved if present, so this keeps working if
    # the table ever moves back beside them.
    consts = go_const_values(src)
    body = _body(src, r"func OfferedGrips\([^)]*\)[^{]*\{")
    table: dict[str, list[str]] = {}
    pending: list[str] = []
    for line in body.splitlines():
        case = re.search(r"case ([^:]+):", line)
        if case:
            pending = [x.strip().strip('"') for x in case.group(1).split(",")]
        ret = re.search(r"return \[\]string\{(.*?)\}", line)
        if ret:
            inner = ret.group(1)
            names = re.findall(r"\bGrip\w+", inner)
            if names:
                vals = [consts.get(n) or _unknown(n) for n in names]
            else:
                vals = [v.strip().strip('"') for v in inner.split(",") if v.strip()]
            for p in pending:
                table[p] = vals
            pending = []
        if "default:" in line:
            pending = [DEFAULT_KEY]
    # Go writes its fallback as a trailing `return nil` AFTER the switch, not as
    # a `default:` — so the sentinel has to be filled from there or Go reports
    # None while both TS copies report [], and the check fails on a difference
    # in SPELLING rather than in behaviour. `nil` and `[]` are the same answer:
    # this movement offers no grips.
    if DEFAULT_KEY not in table:
        tail = re.search(r"\n\treturn (nil|\[\]string\{\s*\})\s*$", body)
        if not tail:
            raise SystemExit(
                "check-grip-parity: Go's OfferedGrips has neither a `default:` nor a "
                "trailing `return nil` — the parser needs updating, not deleting"
            )
        table[DEFAULT_KEY] = []
    return table


def _unknown(name: str) -> str:
    raise SystemExit(f"check-grip-parity: Go names {name} in OfferedGrips but no `{name} Grip = \"...\"` const — parser or code out of step")


def _body(src: str, header: str) -> str:
    m = re.search(header + r"(.*?)\n\}", src, re.S)
    if not m:
        raise SystemExit(f"check-grip-parity: could not find {header!r} — the parser needs updating, not deleting")
    return m.group(1)


def main() -> int:
    tables = {"go": parse_go(GO), "mobile": parse_ts(MOBILE)}

    for name, t in tables.items():
        if not t:
            print(f"check-grip-parity: parsed NO entries from {name} — refusing to pass vacuously")
            return 1

    patterns = sorted(set().union(*(set(t) for t in tables.values())))
    drift = []
    for p in patterns:
        got = {name: t.get(p) for name, t in tables.items()}
        if len({repr(v) for v in got.values()}) != 1:
            drift.append((p, got))

    if drift:
        print(
            "check-grip-parity: mobile's offline fallback no longer matches the "
            "table the server serves.\n"
        )
        for p, got in drift:
            print(f"  {p}:")
            for name, v in got.items():
                print(f"      {name:7} {v}")
        print(
            "\nThe SERVER is authoritative: backend/internal/modules/exercise/grips.go "
            "is what\nevery online client reads via `offered_grips`. Fix "
            "apps/mobile/lib/sessions.ts to\nmatch it — that copy exists only so a "
            "phone holding exercises cached before the\nfield existed still shows a "
            "grip picker offline."
        )
        return 1

    print(
        f"mobile’s offline grip fallback matches the served table "
        f"({len(patterns)} movement patterns)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
