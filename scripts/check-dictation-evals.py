#!/usr/bin/env python3
"""Fail if a dictation eval case expects something the app could never produce.

`evals/bjj-dictation/cases.json` pairs a dictated sentence with the draft a
correct extraction returns. It is hand-authored, and a hand-authored expectation
is exactly as capable of being wrong as the model it grades — an expected tag
naming a technique id that does not exist, or a position family the app spells
differently, silently converts into a permanent scoring error that looks like a
model failure forever after.

So every expected draft is checked against the real vocabularies:

  * `backend/internal/modules/technique/techniques.json` — all 542 ids, and each
    one's library category and position.
  * `apps/mobile/lib/bjjSession.ts` — POSITIONS, and the `toCategory` mapping
    from the library's nine categories onto the tag vocabulary's six.

The second is the check worth having. A technique's tag category and position
are DERIVED, not chosen: `toCategory('Transition')` is `control`, and
`familyOf('Guard - Bottom')` is `Guard`. An expectation that writes `transition`
or `Guard - Bottom` describes a row the app cannot write, so a model producing
the correct row would be scored wrong. Nothing else in the repo would notice.

Stdlib-only and syntactic, matching `check-grip-parity.py` and
`check-rate-parity.py`: it parses the TypeScript rather than importing it, so
`verify` needs no Node and no Go toolchain. That bounds the promise — it checks
the tables, not the behaviour around them, and a reformat beyond these patterns
fails here as drift. Fix the parser then; do not delete the check.

**It cannot tell you the corpus is any good.** It proves every case is
*writable*, not that any case is *realistic* — see the README on why an authored
corpus scores self-consistency rather than reality.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "evals" / "bjj-dictation" / "cases.json"
TECHNIQUES = ROOT / "backend" / "internal" / "modules" / "technique" / "techniques.json"
POSITIONS_JSON = ROOT / "backend" / "internal" / "modules" / "technique" / "positions.json"
BJJ_SESSION_TS = ROOT / "apps" / "mobile" / "lib" / "bjjSession.ts"

# The tag vocabulary, from migration 000025 and `bjjSession.ts`. Kept here as a
# literal on purpose: if somebody adds a seventh category, this check should
# fail until a human decides what the eval set expects of it.
CATEGORIES = {"submission", "sweep", "pass", "escape", "takedown", "control"}
EVENTS = {"drilled", "attempted", "scored", "conceded", "defended"}
KINDS = {"class", "drilling", "positional", "rolling"}

# `toCategory` in bjjSession.ts. Five named cases; everything else is `control`.
LIBRARY_TO_TAG = {
    "Submission": "submission",
    "Sweep": "sweep",
    "Pass": "pass",
    "Escape": "escape",
    "Takedown": "takedown",
}


def parse_positions(text: str) -> list[str]:
    """POSITIONS from bjjSession.ts — the list `familyOf` actually matches on."""
    m = re.search(r"export const POSITIONS = \[(.*?)\] as const;", text, re.S)
    if not m:
        return []
    return re.findall(r"'([^']+)'", m.group(1))


def family_of(position: str, families: list[str]) -> str:
    """`familyOf` in bjjSession.ts, verbatim: exact match or a ' - ' prefix."""
    for fam in families:
        if position == fam or position.startswith(f"{fam} - "):
            return fam
    return ""


def to_tag_category(library_category: str) -> str:
    return LIBRARY_TO_TAG.get(library_category, "control")


def check_case(case, techniques, families, errors):
    cid = case.get("id", "<no id>")

    def err(msg):
        errors.append(f"{cid}: {msg}")

    for key in ("id", "source", "dictation", "why", "expect"):
        if key not in case:
            err(f"missing required key {key!r}")
    if case.get("source") not in ("authored", "recorded"):
        err(f"source must be 'authored' or 'recorded', got {case.get('source')!r}")
    if not case.get("why", "").strip():
        err("every case states why it exists — an unexplained case cannot be maintained")

    exp = case.get("expect", {})
    if exp.get("kind") is not None and exp["kind"] not in KINDS:
        err(f"kind {exp['kind']!r} is not one of {sorted(KINDS)}")
    if exp.get("gi") is not None and not isinstance(exp["gi"], bool):
        err("gi is three-state: true, false or null")
    for field in ("rounds", "round_minutes"):
        v = exp.get(field)
        if v is not None and (not isinstance(v, int) or v < 1):
            err(f"{field} must be a positive integer or null, got {v!r}")
    rpe = exp.get("session_rpe")
    if rpe is not None and (not isinstance(rpe, int) or not 1 <= rpe <= 10):
        err(f"session_rpe must be 1-10 or null, got {rpe!r}")

    for i, tag in enumerate(exp.get("tags", [])):
        where = f"tags[{i}]"
        cat, event = tag.get("category"), tag.get("event")
        if cat not in CATEGORIES:
            err(f"{where}: category {cat!r} is not one of {sorted(CATEGORIES)}")
        if event not in EVENTS:
            err(f"{where}: event {event!r} is not one of {sorted(EVENTS)}")
        count = tag.get("count")
        if not isinstance(count, int) or count < 1:
            err(f"{where}: count must be a positive integer, got {count!r}")

        pos = tag.get("position", "")
        if pos != "" and pos not in families:
            err(
                f"{where}: position {pos!r} is not a family the app can write. "
                f"The tag stores the FAMILY ({sorted(families)}), not the library's "
                f"detailed position — 'Guard - Bottom' becomes 'Guard'."
            )

        tid = tag.get("technique_id")
        if tid is None:
            continue
        lib = techniques.get(tid)
        if lib is None:
            err(
                f"{where}: technique_id {tid!r} is not in the catalog. An expectation "
                f"naming a technique that does not exist can never be met."
            )
            continue
        # The derived-consistency check — the one worth having.
        want_cat = to_tag_category(lib["category"])
        if cat != want_cat:
            err(
                f"{where}: {tid!r} is library category {lib['category']!r}, which "
                f"toCategory() derives as {want_cat!r}, but the case expects {cat!r}. "
                f"The app inherits the category from the technique; it is not chosen."
            )
        want_fam = family_of(lib.get("position", ""), families)
        if pos != want_fam:
            err(
                f"{where}: {tid!r} sits at {lib.get('position')!r}, whose family is "
                f"{want_fam!r}, but the case expects position {pos!r}. A mismatch here "
                f"splits the technique's evidence in the funnel."
            )

    for i, u in enumerate(exp.get("unresolved", [])):
        if not u.get("phrase", "").strip():
            err(f"unresolved[{i}]: needs the phrase that could not be resolved")
        if u.get("category") not in CATEGORIES:
            err(f"unresolved[{i}]: category {u.get('category')!r} is not in the vocabulary")
        if u.get("event") not in EVENTS:
            err(f"unresolved[{i}]: event {u.get('event')!r} is not in the vocabulary")
    if exp.get("unresolved") and all(t.get("technique_id") for t in exp.get("tags", [])):
        err(
            "declares an unresolved phrase but every expected tag already names a "
            "technique — an unresolved case must leave one for the athlete to pick"
        )


def main() -> int:
    for path in (CASES, TECHNIQUES, POSITIONS_JSON, BJJ_SESSION_TS):
        if not path.exists():
            print(f"missing {path.relative_to(ROOT)}", file=sys.stderr)
            return 1

    corpus = json.loads(CASES.read_text())
    cases = corpus.get("cases", [])
    techniques = {t["id"]: t for t in json.loads(TECHNIQUES.read_text())}
    ts_text = BJJ_SESSION_TS.read_text()
    families = parse_positions(ts_text)

    errors: list[str] = []
    if not families:
        errors.append(
            "could not parse POSITIONS out of bjjSession.ts — the parser has drifted "
            "from the source, which would make every position check vacuous"
        )
        families = []

    # POSITIONS against the seeded families. CLAUDE.md records this list falling
    # behind twice; a family the app cannot spell is a tag nothing can filter.
    seeded = sorted({p["family"] for p in json.loads(POSITIONS_JSON.read_text())})
    if families and sorted(families) != seeded:
        missing = sorted(set(seeded) - set(families))
        extra = sorted(set(families) - set(seeded))
        errors.append(
            f"POSITIONS in bjjSession.ts disagrees with positions.json families — "
            f"missing {missing}, unknown {extra}. familyOf() returns '' for a family "
            f"it does not carry, so those tags are written with no position at all."
        )

    seen: set[str] = set()
    for case in cases:
        cid = case.get("id")
        if cid in seen:
            errors.append(f"{cid}: duplicate id — ids are how a score attributes to a case")
        seen.add(cid)
        check_case(case, techniques, families, errors)

    if errors:
        print(f"{len(errors)} problem(s) in the dictation eval corpus:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    authored = sum(1 for c in cases if c["source"] == "authored")
    recorded = len(cases) - authored
    cats = {c for case in cases for c in (t["category"] for t in case["expect"].get("tags", []))}
    evs = {e for case in cases for e in (t["event"] for t in case["expect"].get("tags", []))}
    uncovered_cat = sorted(CATEGORIES - cats)
    uncovered_ev = sorted(EVENTS - evs)

    print(
        f"dictation evals valid: {len(cases)} cases "
        f"({authored} authored, {recorded} recorded), "
        f"{len(cats)}/{len(CATEGORIES)} categories, {len(evs)}/{len(EVENTS)} events"
    )
    if uncovered_cat or uncovered_ev:
        print(f"  not yet exercised: categories {uncovered_cat}, events {uncovered_ev}")
    if recorded == 0:
        print(
            "  NOTE: every case is authored. The corpus proves the format works; it "
            "does not yet tell you how a model performs on real speech."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
