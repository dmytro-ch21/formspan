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


# `numberWords`, `wordSplit` and `spokenNumber` in
# backend/internal/modules/bjj/reflect.go, ported so the eval floors an unspoken
# count the way `ResolveDraft` does (F29, #785). Without it `run.py` scored a
# draft carrying an invented multiplier (count 6 when nobody said six) that the
# app would have floored to 1 before the athlete saw it.
#
# A port is a second copy of Go logic, which is exactly the drift this file
# argues against, so it is held in step two ways. `reflect_parity_test.go`
# parses NUMBER_WORDS and WORD_SPLIT out of THIS file and compares them with the
# Go values entry for entry; order matters, because the compound rule reads each
# list's FIRST form. And both languages answer the same vectors in
# evals/bjj-dictation/spoken_numbers.json. Keep NUMBER_WORDS one entry per line:
# the Go test's parser reads it that way, and fails rather than guessing.
NUMBER_WORDS = {
    0: ["zero", "no"],
    1: ["one", "once", "a", "an", "single"],
    2: ["two", "twice", "couple", "pair", "double"],
    3: ["three", "thrice", "few", "several", "couple"],
    4: ["four"],
    5: ["five", "handful"],
    6: ["six"],
    7: ["seven"],
    8: ["eight"],
    9: ["nine"],
    10: ["ten"],
    11: ["eleven"],
    12: ["twelve", "dozen"],
    13: ["thirteen"],
    14: ["fourteen"],
    15: ["fifteen"],
    16: ["sixteen"],
    17: ["seventeen"],
    18: ["eighteen"],
    19: ["nineteen"],
    20: ["twenty"],
    30: ["thirty", "half an hour", "half hour"],
    40: ["forty"],
    45: ["forty five", "fortyfive"],
    50: ["fifty"],
    60: ["sixty", "hour"],
    90: ["ninety", "hour and a half"],
}
WORD_SPLIT = re.compile(r"[^a-z0-9]+")
#: `maxTagCount` in backend/internal/modules/bjj/session.go. `ResolveDraft`
#: floors a count above it even when it WAS spoken. The Go parity test pins it.
MAX_TAG_COUNT = 1000
SPOKEN_VECTORS = ROOT / "evals" / "bjj-dictation" / "spoken_numbers.json"


def spoken_number(dictation: str, n: int) -> bool:
    """`spokenNumber` in reflect.go: does n appear in the dictation, as a digit or a word."""
    words = WORD_SPLIT.split(dictation.lower())
    if str(n) in words:
        return True
    # A compound like "forty five" matches across tokens, as in Go.
    joined = " " + " ".join(words) + " "
    for form in NUMBER_WORDS.get(n, []):
        if f" {form} " in joined:
            return True
    # "twenty five" / "twenty-five": built from each list's FIRST form, as in Go.
    if 20 < n < 100 and n % 10 != 0:
        tens, units = NUMBER_WORDS.get((n // 10) * 10, []), NUMBER_WORDS.get(n % 10, [])
        if tens and units and f" {tens[0]} {units[0]} " in joined:
            return True
    return False


def floor_count(count, dictation: str) -> tuple[int, str | None]:
    """`ResolveDraft`'s count guard: the count that survives, and why it changed.

    All three arms of its switch, in its order:
      - below one (or not an int) becomes 1;
      - above one and not spoken becomes 1, FLOORED, not dropped, because the
        tag itself is evidence it happened once;
      - above MAX_TAG_COUNT becomes 1 even when spoken ("1001 rounds").
    The reasons are eval-local labels, not Go's notice constants.
    """
    # `bool` is a subclass of `int` in Python, so a JSON `true` passes as 1.
    # The model's schema types `count` as an integer, and the line this replaced
    # had the same hole; noted rather than guarded.
    if not isinstance(count, int) or count < 1:
        return 1, "below_one"
    if count > 1 and not spoken_number(dictation, count):
        return 1, "not_spoken"
    if count > MAX_TAG_COUNT:
        return 1, "over_ceiling"
    return count, None


# Words that carry no identifying weight and appear on only one side as often as
# both. "the knee cut" and "knee cut" are the same claim about the catalog; a
# matcher that disagrees reports the first as matching NOTHING, which reads as
# "not in the catalog" — the exact wrong answer, since it is in there seven
# times. Stripped from BOTH the phrase and the catalog name, so an exact match
# on "Armbar from Closed Guard" still holds.
STOPWORDS = {
    "a", "an", "and", "at", "for", "from", "in", "into", "of", "on", "or",
    "the", "to", "with", "my", "his", "her", "their", "its",
}


def _norm(text: str) -> list[str]:
    words = re.sub(r"[^a-z0-9 ]", " ", text.lower().replace("-", " ")).split()
    stripped = [w for w in words if w not in STOPWORDS]
    # An all-stopword phrase keeps its words rather than becoming a match for
    # every entry in the catalog.
    return stripped or words


def resolve(phrase: str, techniques: dict) -> list[str]:
    """Which catalog entries a spoken phrase could mean.

    An exact match on a name or alias wins outright — "scissor sweep" IS
    `Scissor Sweep`, even though seven other entries contain both words.
    Otherwise every entry containing all the phrase's words is a candidate.

    This is deliberately NOT the app's matcher (there are already three of
    those, which is the drift this repo keeps arguing about). It is a coarse
    upper bound on ambiguity, and that is all the check below needs.
    """
    words = _norm(phrase)
    joined = " ".join(words)
    exact = [
        t["id"] for t in techniques.values()
        if " ".join(_norm(t["name"])) == joined
        or any(" ".join(_norm(a)) == joined for a in (t.get("aliases") or []))
    ]
    if len(exact) == 1:
        return exact
    if len(exact) > 1:
        return exact
    return [
        t["id"] for t in techniques.values()
        if all(w in _norm(t["name"] + " " + " ".join(t.get("aliases") or [])) for w in words)
    ]


def check_resolution(case, techniques, errors):
    """Every expected `technique_id` must be one the DICTATION actually names.

    This is the check the first live run should have had. Three cases claimed a
    resolution the athlete's words do not support — "swept two people with
    butterfly" expecting `butterfly-sweep-basic` when twenty-six entries match
    "butterfly", "drilled the knee cut" expecting `headquarters-knee-cut` when
    seven match — and one case asserted a technique was absent from the catalog
    when it was present all along. All four scored a CORRECT model as wrong, and
    nothing in the repo noticed, because the expectations were each perfectly
    writable: the old checks only ask whether a tag could exist, never whether
    the sentence earns it.

    So a resolved tag now has to say which phrase resolved it, and that phrase
    has to appear in the dictation and to pick out the expected entry.
    """
    cid = case.get("id", "<no id>")
    dictation = case.get("dictation", "").lower()

    for i, tag in enumerate(case.get("expect", {}).get("tags", [])):
        tid = tag.get("technique_id")
        if tid is None or tid not in techniques:
            continue  # a bad id is already reported by check_case
        phrase = tag.get("resolved_by")
        if not phrase:
            errors.append(
                f"{cid}: tags[{i}] resolves to {tid!r} but does not say which words "
                f"did it. Add 'resolved_by' — an expectation nobody can check is one "
                f"nobody can correct."
            )
            continue
        if " ".join(_norm(phrase)) not in " ".join(_norm(dictation)):
            errors.append(
                f"{cid}: tags[{i}] claims {phrase!r} resolved it, but the dictation "
                f"does not contain those words. The model only has the dictation."
            )
            continue
        cands = resolve(phrase, techniques)
        if tid not in cands:
            errors.append(
                f"{cid}: tags[{i}] expects {tid!r}, but {phrase!r} matches "
                f"{cands[:4] if cands else 'nothing in the catalog'}. A model that "
                f"answered correctly would be scored wrong."
            )
            continue
        # More than one candidate is allowed only when the athlete said the BASE
        # technique and the alternatives are qualified variants of it. Bounded at
        # three because past that the phrase is simply not a resolution.
        if len(cands) > 1:
            shortest = min(cands, key=lambda c: len(_norm(techniques[c]["name"])))
            if len(cands) > 3 or tid != shortest:
                errors.append(
                    f"{cid}: tags[{i}] expects {tid!r}, but {phrase!r} matches "
                    f"{len(cands)} entries ({cands[:4]}). The athlete's words do not "
                    f"pick one out — this belongs in 'unresolved', which is what the "
                    f"spec says and what a well-behaved model will do."
                )

    # The mirror: a case whose premise is that the catalog LACKS something has to
    # be told when that stops being true. `d-technique-not-in-catalog` named a
    # technique the catalog had carried all along.
    absent = case.get("expect_absent_from_catalog")
    if absent:
        cands = resolve(absent, techniques)
        if cands:
            errors.append(
                f"{cid}: claims the catalog has no {absent!r}, but it matches "
                f"{cands[:4]}. The case's whole premise has expired."
            )


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

    # `accept` is how a tolerance is stated — machine-readable, never inferred
    # from the prose of `why`. A scorer reading a range out of an English
    # sentence is guessing at the corpus; an unreadable path here would make the
    # tolerance silently vanish and score a correct model as wrong.
    for path, allowed in (case.get("accept") or {}).items():
        if not isinstance(allowed, list) or not allowed:
            err(f"accept[{path!r}]: needs a non-empty list of acceptable values")
        if path in ("kind", "gi", "rounds", "round_minutes", "session_rpe"):
            continue
        if not re.fullmatch(r"tags\[\d+\]\.\w+", path):
            err(
                f"accept[{path!r}]: not a path the scorer can resolve. Use a scalar "
                f"field name or 'tags[N].field'."
            )

    check_resolution(case, techniques, errors)

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

    # F29: the spoken-number port answers the shared vectors the way Go does,
    # and the count floor keeps, floors and explains the three shapes it meets.
    vectors = json.loads(SPOKEN_VECTORS.read_text()).get("vectors", []) if SPOKEN_VECTORS.exists() else []
    if not vectors:
        errors.append(
            "no vectors in evals/bjj-dictation/spoken_numbers.json — the spoken-number "
            "port would be checked against nothing"
        )
    for v in vectors:
        if spoken_number(v["dictation"], v["n"]) != v["want"]:
            errors.append(
                f"spoken_number({v['dictation']!r}, {v['n']}) is {not v['want']}, want "
                f"{v['want']} — the port has drifted from spokenNumber in reflect.go"
            )
    for count, dictation, want in (
        (5, "rolled five rounds", (5, None)),
        (6, "rolled five rounds", (1, "not_spoken")),
        (0, "rolled five rounds", (1, "below_one")),
        (1, "rolled five rounds", (1, None)),
        (1001, "did 1001 rounds", (1, "over_ceiling")),
        (1000, "did 1000 rounds", (1000, None)),
    ):
        if floor_count(count, dictation) != want:
            errors.append(f"floor_count({count}, {dictation!r}) = {floor_count(count, dictation)}, want {want}")

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
        f"{len(cats)}/{len(CATEGORIES)} categories, {len(evs)}/{len(EVENTS)} events, "
        f"{len(vectors)} spoken-number vectors agree"
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
