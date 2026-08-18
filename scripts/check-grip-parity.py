#!/usr/bin/env python3
"""Fail if the grip vocabulary drifts between its three copies.

One rule, three implementations: `GripsFor` in
`backend/internal/modules/session/session.go`, `gripsFor` in
`apps/mobile/lib/sessions.ts`, and `gripsFor` in `apps/web/src/lib/api.ts`.

Nobody chose that. There is no shared TypeScript package between `apps/web` and
`apps/mobile` — the pnpm workspace globs `packages/*` and no such package
exists — so the alternative to copying was inventing a shared library and
rewiring two apps' builds. This script is the cheaper half of that trade: the
copies are allowed to exist because drift fails a check rather than reaching an
athlete.

The failure it prevents is quiet in both directions. A picker offering a grip
the server refuses produces a 400 the athlete cannot explain; a picker hiding a
grip the server accepts means a deadlifter still cannot say how they pull,
which is the bug N9 was filed for.

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

GO = ROOT / "backend/internal/modules/session/session.go"
MOBILE = ROOT / "apps/mobile/lib/sessions.ts"
WEB = ROOT / "apps/web/src/lib/api.ts"

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
    consts = go_const_values(src)
    if not consts:
        raise SystemExit("check-grip-parity: parsed no Grip constants from Go — the parser needs updating, not deleting")
    body = _body(src, r"func GripsFor\([^)]*\)[^{]*\{")
    table: dict[str, list[str]] = {}
    pending: list[str] = []
    for line in body.splitlines():
        case = re.search(r"case ([^:]+):", line)
        if case:
            pending = [x.strip().strip('"') for x in case.group(1).split(",")]
        ret = re.search(r"return \[\]Grip\{(.*?)\}", line)
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
        tail = re.search(r"\n\treturn (nil|\[\]Grip\{\s*\})\s*$", body)
        if not tail:
            raise SystemExit(
                "check-grip-parity: Go's GripsFor has neither a `default:` nor a "
                "trailing `return nil` — the parser needs updating, not deleting"
            )
        table[DEFAULT_KEY] = []
    return table


def _unknown(name: str) -> str:
    raise SystemExit(f"check-grip-parity: Go names {name} in GripsFor but no `{name} Grip = \"...\"` const — parser or code out of step")


def _body(src: str, header: str) -> str:
    m = re.search(header + r"(.*?)\n\}", src, re.S)
    if not m:
        raise SystemExit(f"check-grip-parity: could not find {header!r} — the parser needs updating, not deleting")
    return m.group(1)


def main() -> int:
    tables = {"go": parse_go(GO), "mobile": parse_ts(MOBILE), "web": parse_ts(WEB)}

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
        print("check-grip-parity: the grip vocabulary has drifted between its three copies.\n")
        for p, got in drift:
            print(f"  {p}:")
            for name, v in got.items():
                print(f"      {name:7} {v}")
        print("\nUpdate all three: backend session.go, apps/mobile/lib/sessions.ts,")
        print("apps/web/src/lib/api.ts. The backend is the authoritative one — it is")
        print("the copy with a CHECK constraint behind it.")
        return 1

    print(f"grip vocabulary identical across go/mobile/web ({len(patterns)} movement patterns)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
