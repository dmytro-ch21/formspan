#!/usr/bin/env python3
"""H21 (#1005) — a package BOTH the Expo app and a Next app declare must be
`ignore`d by Dependabot, because Dependabot cannot bump one without the other.

**The bug this exists to prevent, which shipped and reached a PR.** #928
arrived titled "Bump the web-and-admin-dependencies group" while editing
`apps/mobile/package.json`: `react` 19.2.3 -> 19.2.8. Expo SDK 57 pins React
at 19.2.3, so it failed `check-expo-compat` — the check that exists because of
the 2026-08-09 dyld symbol-not-found abort that killed every installed build
before any JS evaluated.

**Why grouping cannot fix it, and why this check is about `ignore` instead.**
`apps/web`, `apps/mobile` and `apps/admin` are ONE pnpm workspace with ONE root
lockfile, so `.github/dependabot.yml` has one npm entry. Dependabot groups a
DEPENDENCY, not a (dependency, directory) pair — a `react` update is a single
update rewriting every package.json that declares react. Sorting it into a
different group only relabels that one PR; the mobile edit still rides along.

So the invariant is not "the groups are tidy". It is:

    every dependency name declared by BOTH apps/mobile and one of
    apps/web / apps/admin is in the npm entry's `ignore` list

`.github/dependabot.yml` previously carried a COMMENT asserting the separation
held ("named distinctly enough"). Nothing read it, so it was wrong for months.
This is that assertion turned into something that fails.

Stdlib only, per CLAUDE.md — package.json is JSON, and the `ignore` list is
read with a narrow line scanner rather than a YAML parser. The scanner refuses
to guess: if it cannot locate the npm entry or its `ignore:` block it fails
loudly rather than reporting success on nothing parsed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".github" / "dependabot.yml"
MOBILE = ROOT / "apps" / "mobile" / "package.json"
NEXT_APPS = [ROOT / "apps" / "web" / "package.json", ROOT / "apps" / "admin" / "package.json"]

DEP_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")

# Shared, but SAFE to let Dependabot bump — and each needs a reason, because
# "shared" alone is not the hazard. The hazard is shared AND pinned by the
# Expo SDK: `expo install --check` (see `check-expo-compat.py`) validates
# react, react-dom, react-native and the expo-* packages against the SDK, and
# nothing else. A bump to something outside that set cannot produce the
# version drift that aborts a build at launch.
#
# A package added to BOTH apps in future is NOT silently allowed — it fails
# this check until somebody puts it here with a reason or ignores it in
# `.github/dependabot.yml`. That is the point: the decision gets made once,
# visibly, rather than arriving inside a grouped dependency PR named after
# the other app.
ALLOWED_SHARED = {
    "typescript": "not validated by `expo install --check`; the apps deliberately "
                  "sit on different majors (mobile ~6.0.3, web/admin ^5)",
    "eslint": "lint-only, never reaches a build; not validated by `expo install --check`",
    "@types/node": "types-only, never reaches a build; not validated by `expo install --check`",
}


def declared(pkg_json: Path) -> set[str]:
    data = json.loads(pkg_json.read_text(encoding="utf-8"))
    names: set[str] = set()
    for field in DEP_FIELDS:
        names.update(data.get(field, {}))
    return names


def npm_ignore_list(text: str) -> set[str]:
    """The `ignore:` names under the npm ecosystem entry.

    Deliberately narrow. It walks to the `- package-ecosystem: "npm"` entry,
    then to that entry's `ignore:` key, then reads `- dependency-name:` lines
    until the indentation says the block ended. Anything it cannot find is an
    error, never an empty set — an empty set would make this check pass
    vacuously, which is the exact failure mode it exists to end.
    """
    lines = text.splitlines()

    start = None
    for i, line in enumerate(lines):
        if re.match(r'\s*-\s*package-ecosystem:\s*["\']?npm["\']?\s*$', line):
            start = i
            break
    if start is None:
        raise SystemExit('check-dependabot-scope: no `- package-ecosystem: "npm"` entry found')

    entry_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(lines[i]) - len(lines[i].lstrip())
        if indent <= entry_indent and stripped.startswith("-"):
            end = i
            break
    block = lines[start:end]

    ig = None
    for i, line in enumerate(block):
        if re.match(r"\s*ignore:\s*$", line):
            ig = i
            break
    if ig is None:
        raise SystemExit(
            "check-dependabot-scope: the npm entry has no `ignore:` block.\n"
            "  Shared packages (react, react-dom, ...) must be ignored — see H21/#1005."
        )

    ignore_indent = len(block[ig]) - len(block[ig].lstrip())
    names: set[str] = set()
    for line in block[ig + 1 :]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= ignore_indent:
            break
        m = re.match(r'-\s*dependency-name:\s*["\']?([^"\'\s]+)["\']?\s*$', stripped)
        if m:
            names.add(m.group(1))
    return names


def self_test() -> int:
    """The parser must find a real list, and must REFUSE a config with none."""
    good = '\n'.join([
        'version: 2',
        'updates:',
        '  - package-ecosystem: "gomod"',
        '    directory: "/backend"',
        '  - package-ecosystem: "npm"',
        '    directory: "/"',
        '    ignore:',
        '      - dependency-name: "react"',
        '      - dependency-name: "react-dom"',
        '    labels: ["dependencies"]',
        '  - package-ecosystem: "github-actions"',
        '    directory: "/"',
    ])
    got = npm_ignore_list(good)
    assert got == {"react", "react-dom"}, got

    # The gomod entry above also has no `ignore:` — the scanner must not
    # wander into it, or into the github-actions entry below, and report a
    # neighbouring block's contents as the npm one.
    missing = good.replace('    ignore:\n      - dependency-name: "react"\n      - dependency-name: "react-dom"\n', '')
    try:
        npm_ignore_list(missing)
    except SystemExit:
        pass
    else:  # pragma: no cover
        raise AssertionError("a config with no npm `ignore:` block must FAIL, not return empty")

    print("check-dependabot-scope self-test ok (finds the list; refuses a missing one)")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()

    mobile = declared(MOBILE)
    shared: set[str] = set()
    for app in NEXT_APPS:
        shared |= mobile & declared(app)

    if not shared:
        raise SystemExit(
            "check-dependabot-scope: found NO packages shared between apps/mobile and "
            "apps/web / apps/admin.\n  That is almost certainly this check reading the "
            "wrong files rather than a genuinely disjoint workspace — refusing to pass."
        )

    ignored = npm_ignore_list(CONFIG.read_text(encoding="utf-8"))
    unguarded = sorted(shared - ignored - set(ALLOWED_SHARED))

    if unguarded:
        print("check-dependabot-scope: shared dependencies neither ignored nor classified:")
        for name in unguarded:
            print(f"  {name}")
        print()
        print(
            "  Each is declared by BOTH apps/mobile and a Next app. Dependabot groups a\n"
            "  dependency, not a (dependency, directory) pair, so ONE update rewrites\n"
            "  every package.json declaring it — a web/admin bump silently edits the Expo\n"
            "  app too. That is how #928 came to move `react` off the Expo SDK's pin\n"
            "  under a title saying it touched neither app (H21/#1005).\n"
            "\n"
            "  Decide which this is, once, and record it:\n"
            "    - pinned by the Expo SDK (react, react-dom, react-native, expo-*)\n"
            "      -> add to the npm entry's `ignore:` in .github/dependabot.yml\n"
            "    - not pinned by Expo, safe to bump everywhere\n"
            "      -> add to ALLOWED_SHARED in this script, WITH a reason"
        )
        return 1

    stale = sorted(set(ALLOWED_SHARED) - shared)
    if stale:
        print("check-dependabot-scope: ALLOWED_SHARED lists packages that are no longer shared:")
        for name in stale:
            print(f"  {name}")
        print()
        print(
            "  An exception nobody needs is an exception nobody re-reads. Remove it, so\n"
            "  the list keeps describing the workspace rather than its history."
        )
        return 1

    print(
        f"check-dependabot-scope: {len(shared)} package(s) shared between the Expo app and a "
        f"Next app — {len(shared & ignored)} ignored by Dependabot, "
        f"{len(shared & set(ALLOWED_SHARED))} classified safe"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
