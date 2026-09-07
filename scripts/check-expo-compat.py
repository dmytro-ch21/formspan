#!/usr/bin/env python3
"""Fail when an installed `expo-*`/`react-native` version has drifted from
what the pinned Expo SDK expects (N133, #537).

## The incident this closes

2026-08-09 (`docs/decisions/history.md`, and the `vola-mobile-build` skill's
"expo install --check drift is COSMETIC under Expo Go and FATAL under a dev
client" entry): `expo-image-manipulator@57.0.8` called a symbol
`expo-modules-core` only exports from 57.0.8 onward, but the lockfile had
resolved `expo`'s own `expo-modules-core` dependency at 57.0.7. Every
Release build crashed at launch — `EXC_CRASH (SIGABRT)`, a `dyld`
symbol-not-found abort, before any JS ever ran. `npx expo install --check`
had been printing this exact mismatch for weeks; nothing in `verify` or CI
ever ran it, so the warning was cosmetic until a device build made it fatal.

## What this wraps, and why as a wrapper rather than a bare package.json line

`pnpm --dir apps/mobile exec expo install --check` already does the real
work — it exits non-zero the moment ANY dependency is outdated relative to
the installed Expo SDK's compatibility matrix, and prints every mismatch by
name (confirmed against this repo's real, current dependency set — see the
N133 history.md entry for the exact transcript of a real, then-current drift
across ~24 packages that this check caught immediately upon being wired in).
This script exists only to give that failure a clear, check-specific header
and to fail loudly on a missing `apps/mobile` rather than silently no-op —
matching this repo's other `check:*` scripts' error-reporting convention
(see `check-expo-config.py`, `check-expo-native-config.py`, its siblings).

## Network requirement — measured, not assumed

`expo install --check` resolves Expo's compatibility matrix over the
network. Confirmed by hand: pointed at an unreachable proxy, it fails fast
(under a second) with `ECONNREFUSED`, exit 1 — a clear network error, not a
false "up to date". It does NOT silently pass when offline. CI already
requires network for `pnpm install --frozen-lockfile` in the same job, and a
developer running `verify` before a `git push` already needs network for the
push itself — so this adds no new requirement in practice, and fails
distinguishably (a connection error, not a compatibility report) on the rare
occasion it doesn't have one.

## Mutation-checked

Confirmed by hand (exact transcript in the N133 history.md entry):
pinning `expo-camera` to an exact, older version than the installed Expo
SDK expects reproduces the 2026-08-09 incident's shape — a single `expo-*`
package desynced from the SDK's compatibility matrix — and this check fails,
naming exactly that package and its expected version. Restoring the correct
version and reinstalling makes it pass again, confirmed by re-running (not
by re-reading the file).
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "apps" / "mobile"


def main() -> int:
    if not (MOBILE / "package.json").is_file():
        print(f"check-expo-compat: {MOBILE} has no package.json — nothing to check", file=sys.stderr)
        return 1

    result = subprocess.run(
        ["pnpm", "exec", "expo", "install", "--check"],
        cwd=MOBILE,
    )
    if result.returncode != 0:
        print(
            "\ncheck-expo-compat: apps/mobile has an expo-*/react-native "
            "version drift — see the report above. This is the exact "
            "failure class that crashed every installed device on "
            "2026-08-09 (dyld symbol-not-found abort, before any JS ran). "
            "Run `pnpm --dir apps/mobile exec expo install --fix` to bring "
            "dependencies back in line with the pinned Expo SDK version.",
            file=sys.stderr,
        )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
