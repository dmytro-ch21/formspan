#!/usr/bin/env python3
"""Capture a REAL dictation and turn it into a scored case.

    python3 evals/bjj-dictation/record.py add "um so tonight was gi, five rounds..."
    python3 evals/bjj-dictation/record.py add --file ~/Desktop/monday.txt
    python3 evals/bjj-dictation/record.py resolve "the knee cut"
    python3 evals/bjj-dictation/record.py promote
    python3 evals/bjj-dictation/record.py stats

WHY THIS EXISTS. The corpus's whole claim on being trusted is the `source`
field: `authored` cases were written by reasoning about how an athlete talks,
`recorded` ones came out of one actually talking. Fifty recorded is the target
and thirty-three authored ones are scaffolding — because a corpus written by the
same process that writes the prompt tests self-consistency, and will happily
report a high score for a model that is confidently wrong about real speech.

So this tool deliberately CANNOT invent a case. It takes words you actually said
and helps you write down what the draft should have been. Two rules it enforces
rather than suggests:

  * IT NEVER CALLS A MODEL. Not to draft the expectation, not to suggest tags,
    not to resolve a technique. Filling `expect` from model output is the
    rubber-stamp failure the README names — the eval stops measuring the model
    and starts measuring its agreement with itself.

  * IT WILL NOT PROMOTE AN INVALID CASE. Everything goes through
    check-dictation-evals.py first, so a recorded case cannot enter the corpus
    naming a technique that does not exist or a position the tag cannot store.

WHAT IT CANNOT DO FOR YOU: say the words. That part is the data.

Pending cases live in `pending/`, which is gitignored — your raw speech about
your own body does not enter git until you promote it deliberately. Redact
before promoting if you want to; the dictation is the case's whole input, so
edit it as a whole sentence rather than blanking a word out of it.
"""

import argparse
import importlib.util
import json
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CASES = HERE / "cases.json"
PENDING = HERE / "pending"
TECHNIQUES = ROOT / "backend" / "internal" / "modules" / "technique" / "techniques.json"
TARGET_RECORDED = 50


def validator():
    path = ROOT / "scripts" / "check-dictation-evals.py"
    spec = importlib.util.spec_from_file_location("check_dictation_evals", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


V = validator()
TECH = {t["id"]: t for t in json.loads(TECHNIQUES.read_text())}


def candidates_in(dictation: str) -> dict:
    """Every phrase in the dictation that could name a catalog technique.

    Runs the validator's own `resolve` over the dictation's n-grams. This is the
    542-entry problem solved: nobody filling a case remembers whether it is
    `armbar-closed-guard` or `closed-guard-armbar`, and getting it wrong is a
    scoring error that outlives the mistake.

    A phrase resolving to MANY entries is shown too, and is the more important
    half — it is the signal that the honest expectation is `unresolved` rather
    than a pick. Six of the authored cases had that wrong until a live run
    caught them.
    """
    words = re.sub(r"[^a-z0-9 ]", " ", dictation.lower().replace("-", " ")).split()
    seen, out = set(), {}
    for n in (4, 3, 2, 1):
        for i in range(len(words) - n + 1):
            phrase = " ".join(words[i:i + n])
            if phrase in seen:
                continue
            seen.add(phrase)
            # A phrase that is only stopwords, or one short word, matches half
            # the catalog on a substring and tells you nothing.
            meaningful = [w for w in words[i:i + n] if w not in V.STOPWORDS]
            if not meaningful or (len(meaningful) == 1 and len(meaningful[0]) < 5):
                continue
            hits = V.resolve(phrase, TECH)
            if not hits or len(hits) > 30:
                continue
            # A longer phrase that already resolved subsumes its own fragments.
            if any(phrase in longer and out[longer] == hits for longer in out):
                continue
            out[phrase] = hits
    return dict(sorted(out.items(), key=lambda kv: (len(kv[1]), -len(kv[0]))))


def template(dictation: str, case_id: str) -> dict:
    cands = candidates_in(dictation)
    return {
        "id": case_id,
        "source": "recorded",
        "recorded_on": date.today().isoformat(),
        "dictation": dictation,
        "why": "",
        "expect": {
            "kind": None, "gi": None, "rounds": None, "round_minutes": None,
            "session_rpe": None, "note": None, "body_note": None,
            "tags": [], "unresolved": [],
        },
        "must_not": [],
        "_help": {
            "README": "Fill `expect` with what the draft SHOULD be, from the words alone. "
                      "Do not run a model first. Delete this _help block or leave it; "
                      "promote strips it.",
            "why": "Required. One or two sentences on what this case pins down.",
            "tag": {"category": V.__dict__["CATEGORIES"] and sorted(V.CATEGORIES),
                    "event": sorted(V.EVENTS),
                    "shape": {"category": "", "event": "", "position": "",
                              "technique_id": None, "count": 1,
                              "resolved_by": "the words that identify it, required when technique_id is set"}},
            "must_not": "fields that must stay EMPTY: scalar names, 'tags', or 'tags[0].technique_id'",
            "catalog_candidates": {
                p: (ids if len(ids) <= 6 else ids[:6] + [f"...and {len(ids)-6} more"])
                for p, ids in cands.items()
            },
            "reading_candidates": "One id means the words pick it out — use it, with resolved_by. "
                                  "Several means they do not: leave technique_id null and add an "
                                  "`unresolved` entry. That is the answer the spec wants and the "
                                  "one a good model gives.",
        },
    }


def slug(text: str, n: int = 4) -> str:
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", text.lower()).split() if len(w) > 2]
    return "-".join(words[:n]) or "untitled"


def cmd_add(args) -> int:
    text = Path(args.file).read_text().strip() if args.file else (args.text or "").strip()
    if not text:
        sys.exit("nothing to record. Pass the dictation, or --file.")
    PENDING.mkdir(exist_ok=True)
    existing = json.loads(CASES.read_text())["cases"]
    n = sum(1 for c in existing if c.get("source") == "recorded") + len(list(PENDING.glob("*.json"))) + 1
    case_id = f"rec-{n:02d}-{slug(text)}"
    path = PENDING / f"{case_id}.json"
    path.write_text(json.dumps(template(text, case_id), indent=2, ensure_ascii=False) + "\n")
    cands = template(text, case_id)["_help"]["catalog_candidates"]
    print(f"stashed  {path.relative_to(ROOT)}")
    if cands:
        print("\nphrases the catalog recognises:")
        for p, ids in list(cands.items())[:8]:
            mark = "->" if len(ids) == 1 else "  "
            print(f"  {mark} {p:<28} {ids if len(ids) <= 3 else str(len(ids)) + ' entries — leave unresolved'}")
    print(f"\nFill `expect` from the words alone, then: record.py promote")
    return 0


def cmd_resolve(args) -> int:
    hits = V.resolve(args.phrase, TECH)
    if not hits:
        print(f"{args.phrase!r} matches nothing in the catalog — `unresolved`, "
              f"and worth checking whether the catalog is missing it.")
        return 0
    for h in hits[:12]:
        print(f"  {h:<38} {TECH[h]['name']}  ({TECH[h].get('position','')})")
    if len(hits) > 12:
        print(f"  ... and {len(hits)-12} more")
    print(f"\n{len(hits)} match(es). " + ("Resolvable — set technique_id and resolved_by."
          if len(hits) == 1 else "The words do not pick one out: leave technique_id null "
          "and add an `unresolved` entry."))
    return 0


def cmd_promote(args) -> int:
    if not PENDING.exists() or not list(PENDING.glob("*.json")):
        print("nothing pending.")
        return 0
    corpus = json.loads(CASES.read_text())
    have = {c["id"] for c in corpus["cases"]}
    promoted, held = [], []
    for path in sorted(PENDING.glob("*.json")):
        case = json.loads(path.read_text())
        case.pop("_help", None)
        if case["id"] in have:
            held.append((path, "id already in the corpus"))
            continue
        if not case.get("why", "").strip():
            held.append((path, "`why` is empty — an unexplained case cannot be maintained"))
            continue
        errors: list[str] = []
        V.check_case(case, TECH, V.parse_positions(
            (ROOT / "apps" / "mobile" / "lib" / "bjjSession.ts").read_text()), errors)
        if errors:
            held.append((path, "; ".join(errors)))
            continue
        promoted.append((path, case))

    for path, case in promoted:
        corpus["cases"].append(case)
    if promoted:
        CASES.write_text(json.dumps(corpus, indent=2, ensure_ascii=False) + "\n")
        for path, case in promoted:
            path.unlink()
            print(f"promoted  {case['id']}")
    for path, why in held:
        print(f"HELD      {path.name}: {why}")
    if promoted:
        print()
        cmd_stats(args)
    return 1 if held and not promoted else 0


def cmd_stats(args) -> int:
    cases = json.loads(CASES.read_text())["cases"]
    rec = sum(1 for c in cases if c.get("source") == "recorded")
    auth = len(cases) - rec
    pend = len(list(PENDING.glob("*.json"))) if PENDING.exists() else 0
    bar = "#" * int(28 * min(1, rec / TARGET_RECORDED))
    print(f"recorded  {rec:>3}/{TARGET_RECORDED}  [{bar:<28}]")
    print(f"authored  {auth:>3}      (scaffolding — see the README on why this is not the same thing)")
    if pend:
        print(f"pending   {pend:>3}      in {PENDING.relative_to(ROOT)}/, not yet filled in or not yet valid")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="stash a dictation you actually said")
    a.add_argument("text", nargs="?")
    a.add_argument("--file", help="read the dictation from a file instead")
    a.set_defaults(fn=cmd_add)
    r = sub.add_parser("resolve", help="what could these words mean in the catalog?")
    r.add_argument("phrase")
    r.set_defaults(fn=cmd_resolve)
    sub.add_parser("promote", help="validate pending cases and move them into the corpus").set_defaults(fn=cmd_promote)
    sub.add_parser("stats", help="progress toward fifty recorded").set_defaults(fn=cmd_stats)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
