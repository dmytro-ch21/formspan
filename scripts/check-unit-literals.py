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

## The blind spot, stated plainly, because it is not obvious

**The quoted/JSX heuristic is SAME-LINE and positional**, keyed on a `}` before
the token or a `<` after it. That makes it good at
`{p.kg_to_go} kg to go` — `goals.tsx`'s shape — and **blind to bare JSX text
that opens on one line and closes on another**, which is most multi-line JSX.

That blindness was measured, not assumed, and it covered the headline bug: the
verbatim original line

    Target weight (kg){kind === 'making_weight' ? '' : ' — optional'}

was appended to a file and this check exited **0**. A guard whose docstring
implies it prevents a class of bug, and which cannot catch the very instance
that motivated it, is carrying a false claim.

So a **second pattern** was added for the one shape that covers it: a
PARENTHESISED unit — `(kg)`, `(lb)`, `(cm)`, `(ft)` — in a non-attribute
position, matched wherever it appears rather than only inside a string. That is
how unit labels are actually written on a field, and it is unambiguous enough
not to need the positional heuristic. `Math.abs(kg)` and
`distanceInputUnit(units)` do not match, because the `(` must be preceded by
whitespace or `>` rather than by an identifier character.

**What is still not seen.** This list was WRONG when first written — it named
one class and there are two, found by review probing the matchers rather than
reading them. Both need real parsing (element-body tracking, or multi-line
string state) which is a bigger change than this check justified:

1. **A bare, unparenthesised unit in multi-line JSX text** — a `<Text>` whose
   content is `Weight` on one line and `kg` on the next. Neither pattern fires:
   the positional heuristic is same-line, and there are no parentheses.
2. **The interior of a multi-line template literal** — a line reading
   `You are 3 kg from your goal` inside a backtick string spanning several
   lines has no quote character *on that line*, so the quoted heuristic never
   fires. Realistic for `Alert.alert` bodies and long accessibility labels.
   Single-line strings and multi-line JSX *attributes* are both caught; this is
   specifically the multi-line backtick interior.

The self-test vectors below pin what IS caught, so shrinking that set fails
rather than passes quietly. If you widen the matchers to cover either class,
add its vector to `MUST_MATCH` first and watch it fail.

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

#: Units that are unambiguous ONCE PARENTHESISED. `in`, `ft`, `mi`, `L` and
#: `m` are excluded from `UNITS` because they are English words, SVG path
#: commands and duration suffixes — but `(in)` and `(ft)` on a field label are
#: none of those things, so the paren form can afford a wider vocabulary.
PAREN_UNITS = (
    r"kgs?|lbs?|cm|mm|km|mi|yd|ft|in|ml|L|fl oz"
    r"|kilograms?|pounds?|inches|feet|centimet(?:er|re)s?|met(?:er|re)s?"
)

#: The subset that is unambiguous even with COMPANION WORDS after it. `in`,
#: `ft`, `mi` and `L` are excluded here though they appear in `PAREN_UNITS`
#: above: `(in progress)` is real English and would match a widened pattern,
#: which is the wolf-cry that gets a check ignored.
PAREN_UNAMBIGUOUS = (
    r"kgs?|lbs?|cm|mm|km|yd|ml|fl oz"
    r"|kilograms?|pounds?|inches|centimet(?:er|re)s?"
)

#: Two alternatives, and the split is deliberate.
#:
#: 1. **Exact** — `(kg)`, `( kg )` — for the full vocabulary, ambiguous tokens
#:    included, because `(in)` alone is a unit and `(in progress)` is not.
#: 2. **With companion words** — `(kg, optional)`, `(kg per side)` — for the
#:    unambiguous subset only. That second form is the near-relative of the
#:    bug this pattern was built for: `perSide` is a real concept in the
#:    session logger, so `Weight (kg per side)` is a label somebody will write.
#:
#: Case-insensitive so `(Kg)` at the start of a label is caught.
#:
#: The `(` must follow whitespace, `>`, or the start of the line — that is what
#: separates a LABEL, `Target weight (kg)`, from a CALL, `Math.abs(kg)` or
#: `distanceInputUnit(units)`, where an identifier character precedes it.
#: The companion text is restricted to LETTERS, SPACES AND COMMAS — not
#: `[^)]*`. That was tried and immediately flagged
#: `(1 - (kg - wLo) / wSpan)` in `NutritionChart.tsx`: parenthesised arithmetic
#: on a variable named `kg`. A label reads `(kg per side)` or `(kg, optional)`;
#: an expression contains operators, colons or digits. Excluding those is what
#: separates the two without needing to know which is which.
PAREN = re.compile(
    rf"(?:(?<=[\s>])|^)\(\s*(?:(?:{PAREN_UNITS})\s*\)"
    rf"|(?:{PAREN_UNAMBIGUOUS})\b(?:[,\s][A-Za-z ,]{{0,22}})?\))",
    re.IGNORECASE,
)

#: `(` preceded by one of these is a CONDITION or a return, not a label —
#: `if (kg)`, `switch (cm) {`, `return (ml);`. A variable named `kg` is
#: commonplace in this codebase (`Math.abs(kg)` is itself a self-test vector),
#: so this is the likeliest first false positive rather than a hypothetical.
#:
#: A guard in code rather than a lookbehind because Python's `re` requires
#: fixed-width lookbehind, and these are not.
PAREN_NOT_A_LABEL = re.compile(r"\b(?:if|while|switch|return|for|catch|await|typeof)\s*$")

#: `(ml) => …` is an untyped single-parameter arrow function, not a label.
PAREN_IS_ARROW = re.compile(r"^\s*=>")
ATTR = re.compile(r"(className|style|testID|href|key|id|data-testid)\s*=\s*[\"'{][^\"']*$")


#: Lines that MUST be reported, and lines that must NOT be.
#:
#: Run on every invocation rather than behind a flag — there is no expensive
#: half to separate out, and a self-test nobody runs is the thing this file's
#: docstring is about. The cost is microseconds.
#:
#: The first vector is the **verbatim original bug line** from
#: `app/phase/index.tsx`, which the positional heuristic could not see. If a
#: future refactor of the matching drops it, this fails rather than quietly
#: covering less.
MUST_MATCH = [
    "          Target weight (kg){kind === 'making_weight' ? '' : ' — optional'}",
    '        label="Height (cm)"',
    "        You are already at {p.target_weight_kg} kg. This phase has done its job.",
    "      hint={`${b.weight_kg} kg on ${b.weight_measured_on}`}",
    "  <Text>Waist (cm)</Text>",
    '  <span>Distance (yd)</span>',
    # Parenthesised WITH companion words — the near-relative of the bug line
    # above, and realistic: `perSide` is a real concept in the session logger.
    "          Target weight (kg, optional)",
    "          <Text>Weight (kg per side)</Text>",
    "          <Text>Height ( cm )</Text>",
    "          <Text>Weight (Kg)</Text>",
]

#: Lines that must stay silent. Every one of these is a shape that a careless
#: widening of the patterns would start reporting — and a check that cries wolf
#: is one somebody eventually silences.
MUST_NOT_MATCH = [
    "    return `${kg > 0 ? '+' : '−'}${formatWeight(Math.abs(kg), units)}`;",
    "    const label = f === 'distance' ? distanceInputUnit(units) : FIELD_LABEL[f];",
    "    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;",
    "    parts.push(m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`);",
    '    <span className="ml-2 text-text-dim">',
    "    return `${minutes}m ago`;",
    "  const cm = toFeetInches(cm);",
    '    <path d="M 0 0 L 8 4 L 0 8 z" />',
    # Parenthesised, and NOT labels. Every one of these was either found in the
    # repo or named by review as the likeliest first false positive; a check
    # that shouts at correct code is one somebody eventually silences.
    "    yWeight: (kg: number) => PAD.top + plotH * (1 - (kg - wLo) / wSpan),",
    "    if (kg) return null;",
    "    if (cm == null) return '—';",
    "    switch (cm) {",
    "    return (kg);",
    "    const toOz = (ml) => ml / 29.5735295625;",
    "    while (ml > 0) {",
    "    const scaled = (kg * 2) / total;",
]


def _reports(line: str) -> bool:
    """Whether the matchers would flag one line, ignoring the allowlist."""
    stripped = strip_noise(line)
    for pm in PAREN.finditer(stripped):
        before, after = stripped[: pm.start()], stripped[pm.end() :]
        if ATTR.search(before):
            continue
        if PAREN_NOT_A_LABEL.search(before) or PAREN_IS_ARROW.match(after):
            continue
        return True
    for m in PAT.finditer(stripped):
        before, after = stripped[: m.start()], stripped[m.end() :]
        quoted = before.count("'") % 2 or before.count('"') % 2 or before.count("`") % 2
        jsx = before.rstrip().endswith("}") or after.lstrip().startswith("<")
        if (quoted or jsx) and not ATTR.search(before):
            return True
    return False


def self_test() -> list[str]:
    problems = []
    for line in MUST_MATCH:
        if not _reports(line):
            problems.append(f"  MISSED (should be reported): {line.strip()!r}")
    for line in MUST_NOT_MATCH:
        if _reports(line):
            problems.append(f"  FALSE POSITIVE (should be silent): {line.strip()!r}")
    return problems


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
                # The parenthesised form first: it needs no positional
                # heuristic, so it sees the multi-line JSX the one below
                # cannot. See "The blind spot" in the module docstring.
                for pm in PAREN.finditer(line):
                    tok = pm.group(0).strip("() ")
                    before, after = line[: pm.start()], line[pm.end() :]
                    if ATTR.search(before):
                        continue
                    if PAREN_NOT_A_LABEL.search(before) or PAREN_IS_ARROW.match(after):
                        continue
                    if excused(rel, tok, line):
                        continue
                    found.append((rel, ln, tok, line.strip()[:100]))
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
    # Before anything else: can this check still detect what it claims to?
    failures = self_test()
    if failures:
        print(
            "check-unit-literals: the matchers no longer behave as specified.\n"
            + "\n".join(failures)
            + "\n\nThe vectors are in MUST_MATCH / MUST_NOT_MATCH in this file. A miss "
            "means the check has silently stopped covering a shape it is supposed to "
            "catch; a false positive means it will be ignored by the next person it "
            "shouts at. Fix the matcher, not the vector — unless the vector is genuinely "
            "wrong, in which case say why in the commit."
        )
        return 1

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

    print(
        f"no hardcoded unit literals "
        f"({len(ALLOW)} allowed exceptions, {len(MUST_MATCH) + len(MUST_NOT_MATCH)} self-test vectors)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
