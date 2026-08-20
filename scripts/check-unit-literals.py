#!/usr/bin/env python3
"""Fail if a screen renders a hardcoded unit instead of asking the units module.

    python3 scripts/check-unit-literals.py
    python3 scripts/check-unit-literals.py --list   # print the allowlist and exit 0

Runs as `check:unit-literals` in `verify` and in the `Scripts (Python)` CI job.

## What it is for

N105 replaced two hand-maintained units modules with one source and a
generator, but a single source of truth is worth nothing if screens print `kg`
themselves — which is exactly what was happening. `app/(tabs)/goals.tsx` called
`useUnits()` on line 186 and then wrote a literal `kg` in eight places further
down, including the goal weight, the gap to it and the shortfall against a
competition deadline. The module was not being bypassed out of ignorance; it was
being bypassed a few hundred lines below a call to itself.

Four tickets queued behind N105 (#485, #487, #486, #447) rebuild the very
screens that were worst affected. Without this, the natural thing to type while
rebuilding a weight row is the thing that caused the bug.

## How it decides

A unit token counts as *rendered* when it appears inside a string, a template
literal's text, or JSX text — the places a user can read it. Three things are
deliberately NOT counted, because each produced false positives that would have
made this check noise:

1. **Template EXPRESSIONS are stripped before matching.** `${kg > 0 ? …}` is a
   variable named `kg`, not the word "kg" on a screen, and this codebase names
   such variables constantly. Without the strip, correct code that already calls
   `formatWeight` reports as a violation — the single fastest way to get a
   check ignored.
2. **Comments are stripped.** This file's own siblings are full of prose about
   kilograms.
3. **Ambiguous tokens are not in the vocabulary at all**: `in`, `ft`, `mi`, `L`,
   `m`, `s`, `h`. `in` is an English word, `L` is an SVG path command, and `m`
   and `s` are how this app renders MINUTES and SECONDS in a dozen places. A
   vocabulary that needs a paragraph of exceptions is the wrong vocabulary; the
   unambiguous tokens catch the bug that actually occurred.

That bounds what it promises. It catches `kg`, `lb`, `cm`, `km`, `yd`, `ml`,
`fl oz` and their spelled-out forms sitting where a reader will see them. It
cannot catch a unit rendered from a variable, or one the SERVER sends in a
message, or a wrong-but-converted number. Those need tests, and have them.

## The allowlist

Every entry names a file, a token and a REASON. They fall into two kinds:

- copy that names both systems in order to describe the choice between them
  ("Kilograms or pounds" on the setting that switches them), and
- storage unit TAGS in a data model, where `'ml'` is a value the code branches
  on rather than a word anybody reads — `trackerModel.ts` converts it through
  `fluidUnit()` at the point of display, which is correct.

Deliberately NOT allowlisted, and the distinction matters: the `g/kg` and
`kcal/kg` coefficients in the nutrition derivation. Those are a **product
decision** — sports nutrition states protein in g/kg universally, including in
the US, and the reference designs pair `2.2 g per kg` with a weight in `lb` —
so they are recorded here as an exception with the ticket that owns the
decision (N111, #494), rather than silently blessed.

Stdlib-only, like its siblings, so `verify` needs no toolchain and the
`Scripts (Python)` CI job — which installs neither Node nor pnpm — runs it
directly.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROOTS = ["apps/mobile", "apps/web/src", "apps/admin/src"]

#: Unambiguous unit tokens only. See the docstring for what is left out and why.
UNITS = r"kgs?|lbs?|cm|km|yd|ml|fl oz|kilograms?|pounds?|centimet(?:er|re)s?"

#: (path, token, SNIPPET) -> reason.
#:
#: The snippet is the load-bearing third element, and it was added because the
#: first version of this table keyed on (path, token) alone — which excuses the
#: WHOLE FILE for that token. Mutation-testing found it immediately: putting a
#: literal `kg` back into `goals.tsx`'s feasibility copy, the exact regression
#: this check exists to prevent, passed clean, because the same file has a
#: legitimate `g per kg` elsewhere. An allowlist entry must excuse one line's
#: worth of text, never a file.
ALLOW: list[tuple[str, str, str, str]] = [
    (
        "apps/mobile/app/settings.tsx",
        "pounds",
        "Kilograms or pounds",
        "Names both systems to describe the choice the row opens — correct whichever "
        "one is active.",
    ),
    (
        "apps/mobile/lib/trackerModel.ts",
        "ml",
        "'ml'",
        "A storage unit TAG in the tracker data model, not rendered copy. `unitNoun` "
        "converts it through `fluidUnit(units)` for display, which is the right place.",
    ),
    (
        "apps/mobile/app/trackers/[id].tsx",
        "ml",
        "'ml'",
        "Branches on the same storage tag as trackerModel.ts, to decide whether the "
        "increment needs converting at all.",
    ),
    (
        "apps/mobile/components/nutrition/AdjustmentCard.tsx",
        "kg",
        "kcal per kg",
        "A scientific coefficient in a derivation, not a measurement the athlete owns. "
        "Left in kcal/kg deliberately — the decision is N111 (#494).",
    ),
    (
        "apps/web/src/app/dashboard/nutrition/targets/AdjustmentCard.tsx",
        "kg",
        "kcal per kg",
        "Same coefficient as the mobile card above, same deliberate exception.",
    ),
    (
        "apps/mobile/app/(tabs)/goals.tsx",
        "kg",
        "g per kg",
        "`protein_g_per_kg` and `fat_g_per_kg` — the mobile mirror of the web "
        "derivation below, and the same product decision — N111 (#494).",
    ),
    (
        "apps/web/src/app/dashboard/nutrition/targets/Derivation.tsx",
        "kg",
        "kcal per kg",
        "The same energy-per-kilogram coefficient as the two adjustment cards, in the "
        "line that shows how the rate becomes a calorie delta.",
    ),
    (
        "apps/web/src/app/dashboard/nutrition/targets/Derivation.tsx",
        "kg",
        "g/kg",
        "`protein_g_per_kg` and `fat_g_per_kg`. Sports nutrition states these in g/kg "
        "universally, including in the US, and the reference designs pair them with a "
        "weight in lb. Product decision, tracked as N111 (#494).",
    ),
    (
        "apps/mobile/app/checkin/[date].tsx",
        "centimetres",
        "in centimetres",
        "The nine check-in GIRTH fields, which N105 deliberately left in centimetres: "
        "the length primitives now exist (`formatGirth`, `girthUnit`) but the screen "
        "has not been converted, and relabelling it 'inches' while still showing "
        "centimetres would be worse. Tracked as N112 (#495); remove this entry when\n"
        "that lands.",
    ),
]


def excused(rel: str, tok: str, line: str) -> bool:
    return any(
        rel == path and tok == token and snippet in line for path, token, snippet, _ in ALLOW
    )


def strip_noise(src: str) -> str:
    """Blank out comments and template EXPRESSIONS, preserving line structure."""
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", src[i:j]))
            i = j
        elif src.startswith("${", i):
            # Blank the expression but keep the braces, so the surrounding
            # template text still reads as a string to the matcher below.
            depth, j = 0, i + 1
            while j < n:
                if src[j] == "{":
                    depth += 1
                elif src[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            j = min(j + 1, n)
            out.append("${" + re.sub(r"[^\n]", " ", src[i + 2 : j - 1]) + "}")
            i = j
        else:
            out.append(src[i])
            i += 1
    return "".join(out)


PAT = re.compile(rf"(?<![\w-])({UNITS})(?![\w-])")
ATTR = re.compile(r"(className|style|testID|href|key|id|data-testid)\s*=\s*[\"'{][^\"']*$")


def violations() -> list[tuple[str, int, str, str]]:
    found: list[tuple[str, int, str, str]] = []
    for root in ROOTS:
        base = ROOT / root
        if not base.exists():
            continue
        for f in sorted(base.rglob("*.ts*")):
            rel = str(f.relative_to(ROOT))
            if "node_modules" in rel or "__tests__" in rel:
                continue
            # The units module is where units are ALLOWED to be spelled out —
            # both the source and the file generated from it.
            if rel.endswith("lib/units.ts"):
                continue
            for ln, line in enumerate(strip_noise(f.read_text()).split("\n"), 1):
                for m in PAT.finditer(line):
                    tok, before, after = m.group(1), line[: m.start()], line[m.end() :]
                    quoted = (
                        before.count("'") % 2 or before.count('"') % 2 or before.count("`") % 2
                    )
                    jsx = before.rstrip().endswith("}") or after.lstrip().startswith("<")
                    if not (quoted or jsx):
                        continue
                    if ATTR.search(before):
                        continue
                    if excused(rel, tok, line):
                        continue
                    found.append((rel, ln, tok, line.strip()[:100]))
    return found


def main() -> int:
    if "--list" in sys.argv[1:]:
        for path, tok, snippet, why in sorted(ALLOW):
            print(f"{path}  [{tok}]  matching {snippet!r}\n    {why}\n")
        return 0

    # The allowlist is a floor, not decoration. If an entry stops matching
    # anything, the file was refactored and the exception is now hiding
    # nothing — but a shrinking allowlist that nobody notices is how a check
    # quietly stops covering what it claims to.
    stale = []
    for path, tok, snippet, _ in ALLOW:
        f = ROOT / path
        if not f.exists():
            stale.append(f"{path} (file is gone)")
            continue
        if not any(snippet in ln for ln in strip_noise(f.read_text()).split("\n")):
            stale.append(f"{path} [{tok}] (nothing matching {snippet!r} left in it)")
    if stale:
        print(
            "check-unit-literals: allowlist entries no longer match anything:\n  "
            + "\n  ".join(stale)
            + "\n\nRemove them from ALLOW in scripts/check-unit-literals.py. An "
            "exception that guards nothing makes the list read as longer than the "
            "real one."
        )
        return 1

    bad = violations()
    if bad:
        print(
            "check-unit-literals: a screen is printing a unit instead of asking the "
            "units module.\n"
        )
        for path, ln, tok, text in bad:
            print(f"  {path}:{ln}  [{tok}]\n      {text}")
        print(
            "\nUse the units module rather than a literal — `formatWeight`, "
            "`formatHeight`, `formatDistance`, `formatFluid`, `formatGirth`, or "
            "`weightUnit`/`heightUnit`/`girthUnit` for a bare label, and "
            "`weightUnitName` for an accessibility label a screen reader has to say.\n"
            "\nIf the literal is genuinely correct — copy that names both systems to "
            "describe the choice between them, or a storage unit tag the code branches "
            "on — add it to ALLOW in scripts/check-unit-literals.py with a reason."
        )
        return 1

    print(f"no hardcoded unit literals ({len(ALLOW)} allowed exceptions, each with a reason)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
