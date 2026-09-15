#!/usr/bin/env python3
"""Fail when `apps/mobile`'s native config cannot actually be generated.

## The gap this closes (N133, #537)

`expo config --type public`/`--type introspect` (the other half of this
ticket's checks — see `check-expo-compat.py`'s sibling wiring in `verify`)
only resolve and merge the JS config. They stop before running a config
plugin's file-writing half (`withInfoPlist`, `withAndroidManifest`,
`withEntitlementsPlist`, ...) — those "mods" only run against a real,
on-disk native project, which `expo config` never creates. So a plugin that
resolves fine but writes a broken Info.plist key, or a plugin ordering bug
that silently drops an entitlement, passes `expo config` cleanly and is only
ever caught by actually generating the native project.

That is exactly the shape of the 2026-08-09/04 HealthKit incident
(`docs/decisions/history.md`, N465/N477): `ios/VOLA.entitlements` stayed
`<dict/>` — empty — because the on-disk `ios/` predated the plugin's addition
to the config and nothing had regenerated it. That specific incident was
machine-local (a stale `ios/` a human had already prebuilt), not something CI
would ever see (CI always starts from zero) — but the class of bug it
represents, a config plugin that silently fails to write what it claims to,
is exactly what actually running `expo prebuild`'s mod-compiler catches and
`expo config` cannot.

## Why this is safe to run in `verify`, unattended, on a developer's machine

`expo prebuild` writes (and by default RECREATES) `ios/` and `android/` in
place. Those directories are gitignored, but a developer mid-iteration on a
device build has a real, working native project there — Xcode may have it
open, `pod install` may have just run, a Simulator build may be installed
from it. A naive `cd apps/mobile && expo prebuild` here would silently
destroy that.

So this script never touches `apps/mobile/ios` or `apps/mobile/android` at
all. It builds a throwaway scratch directory, symlinks in exactly the inputs
`expo prebuild` needs to resolve config plugins (`package.json`,
`app.config.js`/`app.json`, `assets/`, the `.env*` files apps/mobile's config
reads via `process.env`, `eas.json`, `tsconfig.json`, and `node_modules`),
and points `expo prebuild <scratch-dir> --no-install` at THAT directory. Expo
writes the generated `ios/`/`android/` inside the scratch directory, which is
deleted (`tempfile.TemporaryDirectory`) the moment the check finishes —
succeed or fail. Confirmed by hand: this produces byte-identical output to a
real `apps/mobile` prebuild (same `VOLA.entitlements`, same AndroidManifest
permissions) without ever writing inside the real `apps/mobile/` tree.

## Why `--no-install` and no native toolchain requirement

`--no-install` skips `pod install`/npm install; prebuild otherwise only
templates files from `node_modules` and runs config-plugin `mods` in Node.
Measured: this runs in well under a second, needs no Xcode, no Android SDK,
no CocoaPods, and produces the same `ios/`/`android/` file trees whether run
on macOS or Linux — so it runs in the existing `Mobile (Expo)` CI job
(`ubuntu-latest`) exactly as cheaply as `expo config` does. This is
deliberately NOT the Android-compile or iOS-build gate the parent ticket
scopes out (#516/#517 follow-ups) — it validates that the CONFIG resolves
into real native project files, not that those files then compile.

## Self-test

`--self-test` proves the check can fail: it copies (never symlinks — the
mutation must never touch the real file) `app.config.js` into two scratch
projects, corrupts one plugin entry into a name that cannot resolve
(reproducing the exact `PluginError` class from the `vola-mobile-build`
skill's known gotchas), confirms that one goes red, and confirms the
unmodified copy still goes green in the same run. No native toolchain needed
here either, so it runs in `verify` and in CI alongside the real check.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "apps" / "mobile"

# Everything `expo prebuild` might read while resolving config plugins.
# Directories are symlinked whole; files are symlinked individually. Anything
# not present in `apps/mobile` is simply skipped — `metro.config.js` and
# `babel.config.js` don't exist there today (SDK defaults cover both), and a
# future project without `eas.json` shouldn't fail this for an unrelated
# reason.
CANDIDATE_ENTRIES = [
    "package.json",
    "app.config.js",
    "app.config.ts",
    "app.json",
    "eas.json",
    "tsconfig.json",
    "metro.config.js",
    "babel.config.js",
    ".env",
    ".env.local",
    ".env.example",
    "assets",
    "node_modules",
]


def _build_scratch_project(scratch: Path, *, app_config_override: Path | None = None) -> None:
    """Populate `scratch` with symlinks to MOBILE's inputs.

    `app_config_override`, when given, is COPIED (not symlinked) over
    whichever of `app.config.js`/`app.config.ts`/`app.json` MOBILE has, so
    `--self-test` can corrupt a config without ever touching the real file.
    """
    scratch.mkdir(parents=True, exist_ok=True)
    config_names = {"app.config.js", "app.config.ts", "app.json"}
    for name in CANDIDATE_ENTRIES:
        src = MOBILE / name
        if not src.exists():
            continue
        if app_config_override is not None and name in config_names:
            continue  # overridden below instead
        os.symlink(src, scratch / name)

    if app_config_override is not None:
        # Copy under the same name the real project uses, so expo's config
        # resolution (which tries app.config.js, then app.config.ts, then
        # app.json, in that order) picks it up identically.
        for name in ("app.config.js", "app.config.ts", "app.json"):
            if (MOBILE / name).exists():
                shutil.copy(app_config_override, scratch / name)
                break


# No network (`--no-install` skips CocoaPods/Gradle dependency resolution)
# and no native toolchain — this is pure JS config-plugin/mod evaluation, so
# it's normally fast. The bound is a backstop against an unexpected hang
# (a plugin blocking on stdin, say), not an expectation that this is slow.
PREBUILD_TIMEOUT_SECONDS = 120


def _run_prebuild(scratch: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["LANG"] = "en_US.UTF-8"
    env["LC_ALL"] = "en_US.UTF-8"
    try:
        return subprocess.run(
            [
                "pnpm", "exec", "expo", "prebuild", str(scratch),
                "--no-install", "--platform", "all",
            ],
            cwd=MOBILE,
            env=env,
            capture_output=True,
            text=True,
            timeout=PREBUILD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        # Synthesize a failed CompletedProcess so every call site's existing
        # returncode/stdout/stderr handling works unchanged.
        return subprocess.CompletedProcess(
            args=exc.cmd,
            returncode=1,
            stdout=(exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            stderr=(
                (exc.stderr or b"").decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            )
            + f"\ncheck-expo-native-config: `expo prebuild` did not finish "
            f"within {PREBUILD_TIMEOUT_SECONDS}s.",
        )


def run_check() -> int:
    if not (MOBILE / "package.json").is_file():
        print(f"check-expo-native-config: {MOBILE} has no package.json — nothing to check", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="expo-native-config-check-") as tmp:
        scratch = Path(tmp) / "project"
        _build_scratch_project(scratch)
        result = _run_prebuild(scratch)
        # Read before the scratch directory is deleted at the end of this block.
        entitlement_problem = _push_entitlement_problem(scratch) if result.returncode == 0 else None

    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)

    if result.returncode != 0:
        print(
            "\ncheck-expo-native-config: `expo prebuild` could not generate the "
            "native project from apps/mobile/package.json + app.config.js. "
            "This is the class of bug that reaches a device as a silent "
            "launch-time failure (a PluginError, a missing entitlement, a "
            "malformed permission string) — see docs/decisions/history.md's "
            "N465/N477 HealthKit entry and the vola-mobile-build skill.",
            file=sys.stderr,
        )
        return result.returncode

    if entitlement_problem:
        print(f"\ncheck-expo-native-config: {entitlement_problem}", file=sys.stderr)
        return 1

    print("check-expo-native-config: ok — native project generates cleanly from the checked-in config")
    return 0


# --------------------------------------------------------------------------
# The push entitlement (N195, #612)
# --------------------------------------------------------------------------

PUSH_ENTITLEMENT = "aps-environment"


def _push_entitlement_problem(scratch: Path) -> str | None:
    """Why the generated iOS project carries the APNs entitlement, or None.

    `expo-notifications` is installed for a LOCAL notification (the rest
    timer's lock-screen alert), which needs no entitlement. Its config plugin
    writes `aps-environment` anyway, and prebuild auto-applies that plugin for
    any installed `expo-notifications`. `app.config.js`'s
    `withoutPushEntitlement` removes it, and only while it sits ABOVE
    `"expo-notifications"` in `plugins`. A free Apple ID cannot sign a build
    that declares Push Notifications, so its return breaks every device build,
    and nothing else in the pipeline would notice: the prebuild succeeds.

    A missing .entitlements file is reported too, rather than read as "absent":
    a check that passes because it found nothing to read is the failure this
    repo's "absence is not evidence" rule is about.
    """
    files = sorted((scratch / "ios").glob("*/*.entitlements"))
    if not files:
        return (
            "no .entitlements file was generated under ios/, so the absence of "
            f"`{PUSH_ENTITLEMENT}` cannot be confirmed."
        )
    for path in files:
        if f"<key>{PUSH_ENTITLEMENT}</key>" in path.read_text():
            return (
                f"{path.relative_to(scratch)} declares `{PUSH_ENTITLEMENT}` (Push "
                "Notifications). VOLA sends no push, and a free Apple ID cannot sign "
                "this capability, so every device build would fail to provision. "
                "`withoutPushEntitlement` must stay in app.config.js's plugins, ABOVE "
                '"expo-notifications" — see N195 (#612) in docs/decisions/history.md.'
            )
    return None


# --------------------------------------------------------------------------
# --self-test
# --------------------------------------------------------------------------

def self_test() -> int:
    if not (MOBILE / "app.config.js").is_file():
        print("check-expo-native-config self-test: apps/mobile/app.config.js not found — cannot self-test", file=sys.stderr)
        return 1

    real_config = (MOBILE / "app.config.js").read_text()
    failures: list[str] = []
    ran: list[str] = []

    def check(label: str, condition: bool) -> None:
        ran.append(label)
        if not condition:
            failures.append(label)

    # 1. An unmodified copy of the real config must still generate cleanly,
    #    and without the push entitlement (N195, #612).
    with tempfile.TemporaryDirectory(prefix="expo-native-config-selftest-good-") as tmp:
        good_config = Path(tmp) / "app.config.js"
        good_config.write_text(real_config)
        scratch = Path(tmp) / "project"
        _build_scratch_project(scratch, app_config_override=good_config)
        result = _run_prebuild(scratch)
        check("an unmodified config generates cleanly", result.returncode == 0)
        check(
            f"an unmodified config generates no `{PUSH_ENTITLEMENT}`",
            _push_entitlement_problem(scratch) is None,
        )

    # 1b. N195 (#612): both ways of losing the push-entitlement guard must be
    #     REPORTED, while prebuild itself still succeeds — which is exactly why
    #     the plain returncode check above could never see it. The strip plugin
    #     removed, and the strip plugin moved below "expo-notifications" (a mod
    #     registered later runs earlier, so below means it runs first and strips
    #     nothing). Each anchor must match exactly once, or the mutation is not
    #     the one this claims to test.
    strip_line = "      withoutPushEntitlement,\n"
    notif_line = '      "expo-notifications",\n'
    check("the real config lists withoutPushEntitlement exactly once", real_config.count(strip_line) == 1)
    check(
        "the strip plugin sits directly above expo-notifications, exactly once",
        real_config.count(strip_line + notif_line) == 1,
    )
    for label, mutated in (
        ("the strip plugin removed", real_config.replace(strip_line, "", 1)),
        (
            "the strip plugin moved below expo-notifications",
            real_config.replace(strip_line + notif_line, notif_line + strip_line, 1),
        ),
    ):
        check(f"the fixture for {label} actually changed the config", mutated != real_config)
        with tempfile.TemporaryDirectory(prefix="expo-native-config-selftest-aps-") as tmp:
            aps_config = Path(tmp) / "app.config.js"
            aps_config.write_text(mutated)
            scratch = Path(tmp) / "project"
            _build_scratch_project(scratch, app_config_override=aps_config)
            result = _run_prebuild(scratch)
            check(f"{label}: prebuild still succeeds", result.returncode == 0)
            problem = _push_entitlement_problem(scratch)
            check(
                f"{label}: reported as declaring `{PUSH_ENTITLEMENT}`",
                problem is not None and "declares" in problem,
            )

    # 2. The same config with one plugin name corrupted must fail with a
    #    PluginError — reproducing the vola-mobile-build skill's known
    #    "PluginError: Failed to resolve plugin" gotcha.
    corrupted = real_config.replace('"expo-router",', '"expo-router-does-not-exist-plugin",', 1)
    check("the fixture actually corrupted a plugin name", corrupted != real_config)
    with tempfile.TemporaryDirectory(prefix="expo-native-config-selftest-bad-") as tmp:
        bad_config = Path(tmp) / "app.config.js"
        bad_config.write_text(corrupted)
        scratch = Path(tmp) / "project"
        _build_scratch_project(scratch, app_config_override=bad_config)
        result = _run_prebuild(scratch)
        check("a corrupted plugin name fails prebuild", result.returncode != 0)
        check("the failure names PluginError", "PluginError" in result.stderr)

    # 3. Prove the real file was never touched by any of the above.
    check(
        "the real apps/mobile/app.config.js was never modified by this self-test",
        (MOBILE / "app.config.js").read_text() == real_config,
    )

    if failures:
        print("check-expo-native-config self-test FAILED:\n", file=sys.stderr)
        for label in failures:
            print(f"  - {label}", file=sys.stderr)
        return 1

    # Counted, not written down: the old "4/4" was a literal, so adding the
    # N195 cases left it saying 4 whether or not they ran.
    print(f"check-expo-native-config self-test ok — {len(ran)}/{len(ran)} cases correct")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Prove the check can fail, against scratch fixtures — never touches the real app.config.js.",
    )
    args = parser.parse_args(argv)
    return self_test() if args.self_test else run_check()


if __name__ == "__main__":
    sys.exit(main())
