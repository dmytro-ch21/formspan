#!/usr/bin/env python3
"""Scan a wanted-technique list against the existing VOLA library.

The whole point: a technique is (MOVE x POSITION), not just a name. "Armbar"
already exists five times — from closed guard, side control, mount, north-south
and collar-sleeve. An "Armbar from Knee-on-Belly" is still a genuine addition.
Matching on name alone reports it as a duplicate and the gap never gets filled.

Input: one wanted technique per line, on stdin or a file. Either form works:
    Armbar from Knee on Belly
    Knee on Belly | Armbar          (explicit position before the pipe)

Verdicts:
    HAVE            same move, same position    -> skip, it's already there
    HAVE-ELSEWHERE  same move, different place  -> genuine addition
    CLOSE           near-miss names             -> a human decides
    NEW             nothing resembling it       -> write it
"""
import json
import math
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

LIB = Path(__file__).resolve().parents[0]
SRC = Path(__file__).resolve().parents[1] / "backend/internal/modules/technique"

# Same fold as apps/mobile/lib/techniques.ts foldForSearch — en dashes and
# diacritics are why "north-south pass" and "sao paulo" used to find nothing.
DASHES = re.compile(r"[-‐-―−]+")


def fold(value: str) -> str:
    value = unicodedata.normalize("NFD", value)
    value = "".join(c for c in value if not (0x300 <= ord(c) <= 0x36F))
    value = DASHES.sub(" ", value)
    return re.sub(r"\s+", " ", value).lower().strip()


# Words that carry no identity. "Armbar from Closed Guard" and "Armbar, Closed
# Guard" are the same technique; the joiner is noise when comparing moves.
STOP = {"from", "the", "a", "to", "of", "and", "or", "in", "on", "at", "into", "with"}

# Position vocabulary, folded. Order matters: longest first, so "closed guard"
# wins over "guard" and "knee on belly" is never read as "knee".
POSITIONS = [
    "knee on belly", "closed guard", "open guard", "half guard", "butterfly guard",
    "de la riva", "reverse de la riva", "single leg x", "x guard", "k guard",
    "collar sleeve", "spider guard", "lasso guard", "shin to shin", "sit up guard",
    "deep half", "knee shield", "lockdown", "dogfight", "side control", "scarf hold",
    "north south", "back control", "turtle", "mount", "s mount", "technical mount",
    "high mount", "low mount", "leg entanglement", "50/50", "standing", "clinch",
    "front headlock", "guard",
]


def tokens(name: str) -> set:
    return {t for t in fold(name).split() if t and t not in STOP}


def find_positions(text: str) -> set:
    """Every position named in the text, longest match first.

    A set, not one value: "Standing Guard Break" names two ("standing" and the
    guard it is breaking) and picking either alone misreads the technique. This
    started as a single return and reported `Standing Closed-Guard Break` as a
    brand-new technique — the exact duplicate-authoring failure the whole
    scanner exists to prevent.
    """
    f = fold(text)
    found = set()
    for p in POSITIONS:
        if p in f:
            found.add(p)
            f = f.replace(p, " ")  # consume, so "guard" can't re-match inside
    return found


def move_tokens(name: str) -> set:
    """Tokens with the position words removed — what the technique DOES."""
    f = fold(name)
    for p in POSITIONS:
        f = f.replace(p, " ")
    return {t for t in f.split() if t and t not in STOP}


IDF = {}


def load():
    items = json.loads((SRC / "techniques.json").read_text())
    add = SRC / "techniques.additions.json"
    if add.exists():
        items += json.loads(add.read_text())
    for t in items:
        # A row's position lives in two places; the structured column and the
        # name often disagree in specificity ("Armbar from Closed Guard" vs
        # position "Guard - Bottom"), so take the union of both.
        t["_pos"] = find_positions(t["position"]) | find_positions(t.get("position_detail") or "")
        t["_pos"] |= find_positions(t["name"])
        t["_move"] = move_tokens(t["name"])
        t["_names"] = [fold(t["name"])] + [fold(a) for a in t.get("aliases", [])]

    # Token rarity. Without it every escape matches every other escape, because
    # they share the single token "escape" and Jaccard reads that as identity.
    df = {}
    for t in items:
        for tok in t["_move"]:
            df[tok] = df.get(tok, 0) + 1
    n = len(items)
    for tok, c in df.items():
        IDF[tok] = math.log(n / c)
    return items


def weight(toks: set) -> float:
    # An unseen token is maximally distinctive — it is why the query is new.
    return sum(IDF.get(t, math.log(len(IDF) or 2)) for t in toks)


def score(want: set, have: set) -> tuple:
    """Rarity-weighted containment, plus the absolute weight of what matched.

    The ratio alone says "all of the query's words appear"; the absolute weight
    says whether those words meant anything. {escape} vs {escape} scores 1.0 on
    ratio and near-nothing on weight, which is the correct reading — sharing
    only a common word is not evidence of being the same technique.
    """
    if not want or not have:
        return 0.0, 0.0
    shared = want & have
    if not shared:
        return 0.0, 0.0
    w = weight(shared)
    # BIDIRECTIONAL. Forward alone ("how much of the query is present") punishes
    # a query that is MORE specific than the library row: "Standing Guard Break
    # with Cross Sleeve" against the stored "Standing Closed-Guard Break" scores
    # 0.36 forward and 1.0 reverse, and forward-only filed it as brand new.
    fwd = w / max(weight(want), 1e-9)
    rev = w / max(weight(have), 1e-9)
    return max(fwd, rev), w


# A shared token must carry at least this much rarity to count as evidence.
#
# Measured over the 482-row library rather than guessed. The category words a
# hundred techniques share sit just below it — escape 2.25, sweep 2.33,
# control 2.54, pass 2.57, choke 2.71 — and the words that actually name a
# technique sit just above: armbar 3.29, kimura 3.78, break 4.57, sleeve 5.08.
# Below this line two techniques share a noun; above it they share an identity.
FLOOR = 2.9


def scan(wanted: str, lib: list) -> tuple:
    if "|" in wanted:
        pos_hint, wanted = (s.strip() for s in wanted.split("|", 1))
        want_pos = find_positions(pos_hint)
    else:
        want_pos = find_positions(wanted)
    want_move = move_tokens(wanted)
    wf = fold(wanted)

    # A bare position name ("Side Control", "Knee on Belly") has no move in it.
    # It is a request for the position's control/pin entry, not a technique
    # lookup, and scoring it as a technique matches everything or nothing.
    if not want_move:
        here = [t for t in lib if want_pos and want_pos & t["_pos"]]
        return "POSITION", here[:4], want_pos

    scored = []
    for t in lib:
        if wf in t["_names"]:
            scored.append((99.0, 99.0, t))
            continue
        ratio, w = score(want_move, t["_move"])
        if w >= FLOOR and ratio >= 0.45:
            scored.append((ratio, w, t))
    scored.sort(key=lambda x: (-x[0], -x[1]))

    same = [t for r, w, t in scored if not want_pos or (want_pos & t["_pos"])]
    other = [t for r, w, t in scored if want_pos and not (want_pos & t["_pos"])]

    if same:
        return "HAVE", same[:3], want_pos
    if other:
        return "HAVE-ELSEWHERE", other[:3], want_pos
    return "NEW", [], want_pos


def main():
    lib = load()
    src = open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin
    lines = [ln.strip() for ln in src if ln.strip() and not ln.startswith("#")]

    buckets = {"HAVE": [], "HAVE-ELSEWHERE": [], "POSITION": [], "CLOSE": [], "NEW": []}
    for ln in lines:
        verdict, hits, pos = scan(ln, lib)
        buckets[verdict].append((ln, hits, pos))

    order = ["NEW", "HAVE-ELSEWHERE", "POSITION", "CLOSE", "HAVE"]
    blurb = {
        "NEW": "write these — nothing resembling them exists",
        "HAVE-ELSEWHERE": "the move exists, but not from this position — genuine additions",
        "CLOSE": "near-miss names — you decide",
        "POSITION": "a position, not a technique — here is what already lives there",
        "HAVE": "already in the library — skip",
    }
    for b in order:
        rows = buckets[b]
        if not rows:
            continue
        print(f"\n{'='*72}\n{b}  ({len(rows)})  — {blurb[b]}\n{'='*72}")
        for ln, hits, pos in rows:
            shown = ", ".join(sorted(pos)) if pos else "?"
            print(f"  {ln}" + (f"   [position: {shown}]" if b != "HAVE" else ""))
            for h in hits:
                print(f"        ~ {h['name']}  ({h['position']} / {h.get('position_detail','')})")

    print(f"\n{'-'*72}")
    print(f"{len(lines)} wanted | "
          + " | ".join(f"{b}: {len(buckets[b])}" for b in order))


if __name__ == "__main__":
    main()
