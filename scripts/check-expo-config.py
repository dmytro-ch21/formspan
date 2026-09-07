#!/usr/bin/env python3
"""Fail when `apps/mobile`'s Expo config cannot be resolved.

## What this catches (N133, #537)

`expo config --type public` and `--type introspect` both walk
`app.config.js`, resolve every entry in `plugins`, and merge the whole tree —
without writing anything to disk (see `check-expo-native-config.py`'s
docstring for why that matters: these two types stop BEFORE a plugin's
file-writing "mods" run, so this check is deliberately narrower and faster
than that one). What it catches on its own: a plugin name that cannot
resolve at all (`PluginError: Failed to resolve plugin for module "..."`,
exactly the failure mode `vola-mobile-build`'s known-gotchas section
documents for a native dependency landing in `package.json` without a
matching install), a malformed plugin config shape, or any other structural
break in the config tree — all of which currently throw and exit non-zero,
and currently pass silently because nothing in `verify` or CI ever ran this
command.

`--type public` is what a running app and EAS's manifest serving actually
resolve down to. `--type introspect` additionally exercises `expo config`'s
'introspection' resolution path (a superset used by `expo prebuild` and EAS
Build internally) — cheap enough to run both rather than assume they always
agree.

## Confirmed by hand (see docs/decisions/history.md's N133 entry for the
exact transcript): a deliberately corrupted plugin name
(`"expo-router-does-not-exist-plugin"`) makes both commands exit 1 with a
`PluginError` naming the broken module; restoring the correct name makes
both exit 0 again.

## No native toolchain, no filesystem writes

Both commands only read `app.config.js`/`package.json` and resolve modules
from `node_modules` — no Xcode, no Android SDK, nothing written to disk. Runs
in a fraction of a second, so it costs nothing to run in every `verify` and
every CI run of the `Mobile (Expo)` job, rather than only on
`package.json`/`app.config.js` diffs.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "apps" / "mobile"

CONFIG_TYPES = ("public", "introspect")

# No network, no native toolchain — this normally finishes in a fraction of
# a second (see module docstring). The bound exists only as a backstop
# against something unexpected hanging (e.g. an interactive prompt from a
# misconfigured plugin), not because this is ever expected to be slow.
SUBPROCESS_TIMEOUT_SECONDS = 30


def main() -> int:
    if not (MOBILE / "package.json").is_file():
        print(f"check-expo-config: {MOBILE} has no package.json — nothing to check", file=sys.stderr)
        return 1

    overall_rc = 0
    for config_type in CONFIG_TYPES:
        try:
            result = subprocess.run(
                ["pnpm", "exec", "expo", "config", "--type", config_type],
                cwd=MOBILE,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            overall_rc = 1
            print(
                f"check-expo-config: `expo config --type {config_type}` did not "
                f"finish within {SUBPROCESS_TIMEOUT_SECONDS}s — this command "
                "does no I/O and should be near-instant, so a hang here means "
                "something is unexpectedly wrong (e.g. a plugin blocking on "
                "stdin).",
                file=sys.stderr,
            )
            continue
        if result.returncode != 0:
            overall_rc = result.returncode
            print(f"check-expo-config: `expo config --type {config_type}` failed:\n", file=sys.stderr)
            sys.stderr.write(result.stderr)
            print(
                "\nThis means apps/mobile's Expo config cannot be resolved at "
                "all — a broken plugin reference, a malformed plugin config "
                "shape, or a schema error. This is caught here instead of at "
                "`expo prebuild`/EAS Build time, or worse, not at all until a "
                "device build dies.",
                file=sys.stderr,
            )
        else:
            print(f"check-expo-config: ok — `expo config --type {config_type}` resolves cleanly")

    return overall_rc


if __name__ == "__main__":
    sys.exit(main())
