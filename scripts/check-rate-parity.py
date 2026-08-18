#!/usr/bin/env python3
"""Fail if the evidence-based rate bands drift between their two copies.

One rule, two implementations: `RATE_TARGETS` in
`apps/mobile/lib/anthropometry.ts`, which judges an observed rate against the
athlete's phase, and `RateTargets` in
`backend/internal/modules/nutrition/target.go`, which turns the same band into a
calorie target.

Nobody chose that either. The mobile copy has to work with no signal — a
bathroom scale is where the connection is worst — and the backend copy has to
aggregate four weeks of training the phone does not hold. Neither can be deleted
in favour of the other, so this script is the same trade `check-grip-parity`
makes: the copies are allowed to exist because drift fails a check rather than
reaching an athlete.

The failure it prevents is worse than the grip one, because both halves stay
plausible. If the cut band moves in Go but not in TypeScript, the app tells you
that you are on target while the target itself was derived from a different
number — and a rate band is what decides how much somebody eats. Nothing on
either screen would look wrong.

Also compared: `TREND_DAYS`, `MIN_TREND_READINGS` and `MIN_RATE_DAYS`. Those are
the trend's own shape rather than the bands, and they matter here because the
weekly adjustment rule reads a trend the client drew — if the two disagree about
how many readings make a trend, the server can propose an adjustment from a
number the client refused to display.

Stdlib-only and syntactic on purpose, matching `check-grip-parity.py`: it parses
the two tables rather than importing anything, so `verify` needs no Go toolchain
and no Node. That bounds what it can promise — it compares the TABLES, not the
behaviour around them, and a copy that reformats beyond these patterns will fail
here as drift even when it is correct. Fix the parser then; do not delete the
check.

**The sign lives in neither table.** Both store positive magnitudes and apply
the sign per phase — `judgeRate` in TypeScript, `targetRate` in Go — because a
cut's rate is negative and writing that comparison inline is what gets it
inverted. This script therefore cannot catch a sign error; the Go table test and
`anthropometry.test.ts` each cover their own side.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TS = ROOT / "apps/mobile/lib/anthropometry.ts"
GO = ROOT / "backend/internal/modules/nutrition/target.go"

#: Phases with no band. `making_weight` has a deadline, so its rate is computed
#: from the gap rather than prescribed — both copies must agree it is absent,
#: because a band appearing on one side would silently override the deadline.
NO_BAND = "<none>"


def _num(raw: str) -> str:
    """Normalise a numeric literal so 0.005 and .005 and 0.0050 compare equal."""
    return repr(round(float(raw), 10))


def parse_ts_bands(text: str) -> dict[str, str]:
    body = _block(text, r"export const RATE_TARGETS[^=]*=\s*\{")
    table: dict[str, str] = {}
    for line in body.splitlines():
        line = line.split("//")[0]
        m = re.search(r"(\w+):\s*\{\s*min:\s*(-?[\d.]+),\s*max:\s*(-?[\d.]+)\s*\}", line)
        if m:
            table[m.group(1)] = f"{_num(m.group(2))}..{_num(m.group(3))}"
            continue
        m = re.search(r"(\w+):\s*null", line)
        if m:
            table[m.group(1)] = NO_BAND
    return table


def parse_go_bands(text: str) -> dict[str, str]:
    body = _block(text, r"var RateTargets = map\[PhaseKind\]\*RateBand\{")
    # The Go table is keyed by constant (PhaseCut), so the constant names have
    # to be resolved to the strings the TypeScript table uses.
    consts = dict(re.findall(r'(Phase\w+)\s+PhaseKind = "([\w]+)"', text))
    table: dict[str, str] = {}
    for line in body.splitlines():
        line = line.split("//")[0]
        m = re.search(r"(Phase\w+):\s*\{Min:\s*(-?[\d.]+),\s*Max:\s*(-?[\d.]+)\}", line)
        if m:
            key = consts.get(m.group(1), m.group(1))
            table[key] = f"{_num(m.group(2))}..{_num(m.group(3))}"
            continue
        m = re.search(r"(Phase\w+):\s*nil", line)
        if m:
            table[consts.get(m.group(1), m.group(1))] = NO_BAND
    return table


def parse_ts_consts(text: str) -> dict[str, str]:
    out = {}
    for name in ("TREND_DAYS", "MIN_TREND_READINGS", "MIN_RATE_DAYS"):
        m = re.search(rf"export const {name}\s*=\s*(\d+)", text)
        if m:
            out[name] = m.group(1)
    return out


def parse_go_consts(text: str) -> dict[str, str]:
    #: The Go names are idiomatic Go, so they are mapped rather than matched.
    names = {
        "TrendDays": "TREND_DAYS",
        "MinTrendReadings": "MIN_TREND_READINGS",
        "MinRateDays": "MIN_RATE_DAYS",
    }
    out = {}
    for go_name, ts_name in names.items():
        m = re.search(rf"\b{go_name}\s*=\s*(\d+)", text)
        if m:
            out[ts_name] = m.group(1)
    return out


def _block(text: str, opener: str) -> str:
    """Return the brace-balanced body following the first match of `opener`."""
    m = re.search(opener, text)
    if not m:
        raise SystemExit(
            f"check-rate-parity: could not find `{opener}`.\n"
            "The declaration was renamed or reformatted. Fix this parser rather "
            "than deleting the check — the tables it compares decide how much "
            "somebody eats."
        )
    depth, start = 0, m.end() - 1
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i]
    raise SystemExit("check-rate-parity: unbalanced braces after " + opener)


def compare(what: str, ts: dict[str, str], go: dict[str, str]) -> list[str]:
    problems = []
    for key in sorted(set(ts) | set(go)):
        a, b = ts.get(key), go.get(key)
        if a != b:
            problems.append(f"  {what} {key}:\n      mobile {a}\n      go     {b}")
    return problems


def main() -> int:
    ts_text = TS.read_text()
    go_text = GO.read_text()

    ts_bands = parse_ts_bands(ts_text)
    go_bands = parse_go_bands(go_text)
    # EXPECTED_PHASES is a floor, not decoration. The first version of this
    # script matched `[\d.]+`, which silently skipped `recomposition` and
    # `maintenance` — whose bands sit AROUND zero and therefore have a negative
    # min — on both sides at once. It reported "3 phases" and passed, which is
    # exactly the vacuous pass the docstring warns about. A count that can only
    # go up is what turns that from a quiet weakening into a failure.
    EXPECTED_PHASES = 5
    for name, table in (("mobile", ts_bands), ("go", go_bands)):
        if len(table) < EXPECTED_PHASES:
            print(
                f"check-rate-parity: only parsed {len(table)} phases from the {name} "
                f"table, expected at least {EXPECTED_PHASES}: {sorted(table)}.\n"
                "The parser has stopped matching some of them, so this check is no "
                "longer comparing what it claims to. Fix the parser."
            )
            return 1

    problems = compare("rate band", ts_bands, go_bands)
    problems += compare("constant", parse_ts_consts(ts_text), parse_go_consts(go_text))

    if problems:
        print("check-rate-parity: the rate bands have drifted between their two copies.\n")
        print("\n".join(problems))
        print(
            "\nUpdate both: apps/mobile/lib/anthropometry.ts (RATE_TARGETS) and\n"
            "backend/internal/modules/nutrition/target.go (RateTargets). Neither is\n"
            "authoritative — the mobile copy judges an observed rate, the Go copy\n"
            "derives a calorie target from the same band, and a disagreement means\n"
            "the app reports 'on target' against a number the target never used."
        )
        return 1

    print(
        f"rate bands identical across mobile/go "
        f"({len(ts_bands)} phases, {len(parse_ts_consts(ts_text))} constants)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
