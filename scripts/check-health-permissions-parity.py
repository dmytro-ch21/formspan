#!/usr/bin/env python3
"""Fail if Health Connect's read list and the Android manifest's health permissions drift.

Two hand-kept lists, one rule: every record type the app reads needs exactly one
`android.permission.health.READ_*` entry in the manifest, and the manifest
declares no health permission the app does not read.

  - `READ_RECORD_TYPES` in `apps/mobile/lib/healthConnect.ts`
  - `android.permissions` in `apps/mobile/app.config.js`

# Why it exists (H16, #951)

W15 (#944) is what drift looked like. `ExerciseSession` joined the read list for
N479 (walk/hike detection) and `READ_EXERCISE` never joined the manifest. On
Android every read of it threw a SecurityException that the query caught and
returned as "no records", so the feature was dead while Settings said it worked.
A manifest missing a permission prebuilds and builds cleanly, and no test can see
a manifest, so nothing in the build had an opinion.

W15's own fix makes that drift self-reporting at runtime: a refused read now
throws `HealthConnectPermissionError`. That needs somebody to run an Android dev
build first. This check says it in `verify`, before anybody does.

# The mapping is a TABLE, not a derivation

Health Connect's permission names are not mechanical: `HeartRate` is
`READ_HEART_RATE` and `Vo2Max` is `READ_VO2_MAX`, but `ExerciseSession` is
`READ_EXERCISE`, not `READ_EXERCISE_SESSION`. A CamelCase-to-SNAKE derivation
would be right twice and wrong once, and the wrong one is W15. So
`PERMISSION_FOR` names each type explicitly, and a type missing from it fails
here, asking for its real name from the Health Connect docs, rather than being
guessed.

# What this cannot promise

It reads the two literals syntactically, stdlib only, like its sibling parity
checks. So it compares the LISTS, not what the Health Connect library actually
requests at runtime, and not the permission-rationale activity the manifest
also needs. (`react-native-health-connect`'s config plugin was read when this was
written: it adds the rationale intent filter and activity alias, and no
`android.permission.health.*` entry, so `app.config.js` is the only source.) A
list reformatted beyond these patterns fails here as unparseable rather than
passing; fix the parser then, and do not delete the check.

**Known gap: permissions that belong to no record type.** Health Connect has
some, e.g. `READ_HEALTH_DATA_IN_BACKGROUND` and `READ_HEALTH_DATA_HISTORY`. The
app declares neither today, so this check rejects both as "declared but no
record type needs it". If a feature needs one, add it to
`PERMISSIONS_WITHOUT_RECORD_TYPE` with the reason, rather than loosening the
one-for-one rule.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TS = ROOT / "apps/mobile/lib/healthConnect.ts"
CONFIG = ROOT / "apps/mobile/app.config.js"

HEALTH_PREFIX = "android.permission.health."

#: Health Connect permissions that are not tied to one record type and that the
#: app legitimately declares. Empty today; see "Known gap" above.
PERMISSIONS_WITHOUT_RECORD_TYPE: dict[str, str] = {}

#: Health Connect's own permission name for each record type the app reads.
#: Explicit on purpose: see "The mapping is a TABLE" above.
PERMISSION_FOR = {
    "HeartRate": "READ_HEART_RATE",
    "Vo2Max": "READ_VO2_MAX",
    "ExerciseSession": "READ_EXERCISE",
    # N569/#1130. Read off `HealthPermission`'s own constant in
    # androidx.health.connect:connect-client 1.1.0 (the version the package
    # resolves), not derived from the type name.
    "Steps": "READ_STEPS",
}

TS_RE = re.compile(
    r"^(?:export\s+)?const\s+READ_RECORD_TYPES\s*=\s*\[(.*?)\]\s*as\s+const\s*;",
    re.MULTILINE | re.DOTALL,
)
#: Where Android's config starts. The permissions array is searched for only
#: inside this object, so a plugin option that is also named `permissions`
#: elsewhere in the file cannot be mistaken for the manifest's list.
ANDROID_RE = re.compile(r"^\s*android:\s*\{", re.MULTILINE)
PERMISSIONS_RE = re.compile(r"^\s*permissions:\s*\[(.*?)\]", re.MULTILINE | re.DOTALL)


def fail(msg: str) -> None:
    print(f"check-health-permissions-parity: {msg}", file=sys.stderr)
    sys.exit(1)


def strip_line_comments(text: str) -> str:
    # A permission commented out of the array is not declared. Without this, a
    # `// "android.permission.health.READ_VO2_MAX",` line would count. A `//`
    # INSIDE a string (a URL in a plugin option) is not a comment, so quotes are
    # tracked rather than cutting every line at its first `//`.
    out = []
    for line in text.splitlines():
        quote = None
        cut = len(line)
        i = 0
        while i < len(line):
            ch = line[i]
            if quote:
                if ch == "\\":
                    i += 1
                elif ch == quote:
                    quote = None
            elif ch in "\"'`":
                quote = ch
            elif line.startswith("//", i):
                cut = i
                break
            i += 1
        out.append(line[:cut])
    return "\n".join(out)


def android_block(text: str) -> str:
    """The text of the `android: { ... }` object, by brace depth."""
    m = ANDROID_RE.search(text)
    if not m:
        fail(f"could not find `android: {{` in {CONFIG.relative_to(ROOT)}.")
    depth = 0
    for j in range(m.end() - 1, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[m.end():j]
    fail(f"the `android: {{` object in {CONFIG.relative_to(ROOT)} never closes.")
    return ""


def read_record_types() -> list[str]:
    m = TS_RE.search(TS.read_text())
    if not m:
        # Finding nothing must fail: an empty list on both sides would compare
        # equal and pass this check forever.
        fail(
            f"could not find `const READ_RECORD_TYPES = [...] as const;` in "
            f"{TS.relative_to(ROOT)}. It was renamed, moved or reformatted. Fix "
            f"this parser rather than deleting the check."
        )
    types = re.findall(r"['\"](\w+)['\"]", strip_line_comments(m.group(1)))
    if not types:
        fail(f"READ_RECORD_TYPES in {TS.relative_to(ROOT)} parsed as empty.")
    return types


def health_permissions() -> list[str]:
    text = android_block(strip_line_comments(CONFIG.read_text()))
    blocks = PERMISSIONS_RE.findall(text)
    if len(blocks) != 1:
        fail(
            f"expected exactly one `permissions: [...]` array inside `android: {{`"
            f" in {CONFIG.relative_to(ROOT)}, found {len(blocks)}."
        )
    declared = re.findall(r"['\"]([^'\"]+)['\"]", blocks[0])
    return [p[len(HEALTH_PREFIX):] for p in declared if p.startswith(HEALTH_PREFIX)]


def main() -> None:
    for path in (TS, CONFIG):
        if not path.exists():
            fail(f"{path.relative_to(ROOT)} does not exist")

    types = read_record_types()
    declared = health_permissions()
    problems: list[str] = []

    unmapped = [t for t in types if t not in PERMISSION_FOR]
    for t in unmapped:
        problems.append(
            f"record type `{t}` has no entry in PERMISSION_FOR. Add its Health "
            f"Connect permission name, taken from the Health Connect docs and not "
            f"derived from the type name (ExerciseSession is READ_EXERCISE)."
        )

    wanted = {PERMISSION_FOR[t]: t for t in types if t in PERMISSION_FOR}
    for perm, t in wanted.items():
        if perm not in declared:
            problems.append(
                f"`{t}` is in READ_RECORD_TYPES but `{HEALTH_PREFIX}{perm}` is not "
                f"in app.config.js's android.permissions. On Android every read of "
                f"it is refused. This is W15 (#944)."
            )
    for perm in declared:
        if perm not in wanted and perm not in PERMISSIONS_WITHOUT_RECORD_TYPE:
            problems.append(
                f"`{HEALTH_PREFIX}{perm}` is declared in app.config.js but no "
                f"record type in READ_RECORD_TYPES needs it. The manifest asks the "
                f"athlete for access the app never reads."
            )
    dupes = sorted({p for p in declared if declared.count(p) > 1})
    for perm in dupes:
        problems.append(f"`{HEALTH_PREFIX}{perm}` is declared more than once.")

    if problems:
        fail(
            "the Health Connect read list and the Android manifest disagree:\n  - "
            + "\n  - ".join(problems)
            + f"\n\n  {TS.relative_to(ROOT)}: {types}\n  {CONFIG.relative_to(ROOT)}: {declared}"
        )

    pairs = ", ".join(f"{t}→{PERMISSION_FOR[t]}" for t in types)
    print(
        f"check-health-permissions-parity: {len(types)} record types, "
        f"{len(declared)} health permissions, one each ({pairs})"
    )


if __name__ == "__main__":
    main()
