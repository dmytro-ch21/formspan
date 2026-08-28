#!/usr/bin/env python3
"""Fail when an autolinkable native dependency never reached the iOS project.

## The failure this prevents (H9, split from #432 / N91)

`apps/mobile/ios/` is generated (CNG) and gitignored, so nothing in the repo
knows whether it matches `apps/mobile/package.json`. A merge that adds a
native dependency updates the JS; only a human running `pod install` updates
the native project, and nothing fails when they don't.

Measured 2026-08-20 on the primary checkout: `expo-camera` (landed in #320)
was present in the JS bundle, in `apps/mobile/package.json`, and in the
Metro-bundled `main.jsbundle` inside a built `.app` — and absent from
`ios/Podfile.lock`, the generated autolinking manifest, and the built
binary's frameworks. The consequence on a Release build is an **instant,
no-dialog termination**: `expo-camera` calls `requireNativeModule` at module
scope, that throws, an ESM import cannot be caught, and an unhandled JS error
is fatal in Release. This script is the fifteen-line comparison that was run
by hand to find that; it does not fix the fleet (that is device work, tracked
on #441 separately) — it stops the next one from going unnoticed.

## Why this cannot be a naive name transform

The obvious heuristic — PascalCase the package name (`expo-camera` ->
`ExpoCamera`) and grep for that in `Podfile.lock` — is wrong for real
dependencies already in this repo's own `package.json`:

- `expo-constants` ships pod `EXConstants` (pre-unification naming), not
  `ExpoConstants`.
- `expo-dev-client` ships pod `expo-dev-client`, verbatim, not
  `ExpoDevClient`.
- `expo-auth-session` and `expo-status-bar` ship **no iOS pod at all** —
  the former is a pure-JS wrapper over `expo-web-browser`, the latter is
  Android-only (`"platforms": ["android"]` in its `expo-module.config.json`).
  Flagging either as "missing" would be a false positive on every clean
  install, and a check that cries wolf gets disabled — see CLAUDE.md's
  "verify that it can PASS".

So this reads the ACTUAL pod name(s) each package ships, from its own
`expo-module.config.json` (`apple.podspecPath`, when the package declares one
explicitly — `expo-camera` is an example) or, when that key is absent, from
whatever `*.podspec` files live under the package's own `ios/` directory
(`expo-constants`, `expo-dev-client`, `expo-linking` are examples — each has
exactly one). A package with no `expo-module.config.json`, or one whose
`platforms` list excludes `apple`/`ios`, ships no iOS native code and is
skipped — never flagged.

## Scope: `expo-*` packages only

Deliberately narrower than "every autolinkable dependency". `@clerk/expo` and
`react-native-*` packages are also autolinked and are out of scope here. Two
reasons: the incident this guards against was an `expo-*` package, and it is
the class most native regressions in this repo come from; and every `expo-*`
package agrees on where to look (`expo-module.config.json`), while a general
solution would need to introspect arbitrary third-party podspecs with no
shared convention, multiplying the false-positive surface this guard is
built to avoid. If a non-`expo-*` native dependency regresses this way, that
is a real gap — but a wider check that flags clean installs is worse than a
narrower one that doesn't, and this repo has already had that argument once
(see the docstring's naive-heuristic section above).

## Two run modes, split the way `check-ci-checks.py` splits (N65)

- **No flags** — the real check, against the actual `apps/mobile/ios/`. This
  is deliberately a *local-only* tool: `ios/` is gitignored, CI never builds
  it (CI installs from the lockfile and never runs `pod install`, so a CI job
  here would be a permanent, silent no-op — the exact failure mode CLAUDE.md's
  "verify that it can PASS" warns about), and `ios/` may not even exist in a
  fresh worktree that has never run `pod install`. **No-ops (exit 0) when
  `apps/mobile/ios/Podfile.lock` does not exist** — this is not a gap, it is
  every worktree and every CI run, by design.
- **`--self-test`** — builds synthetic fixtures in a temp directory and
  exercises the comparison logic itself: the no-op path, a clean pass, a
  failure when a required pod is missing, and the three false-positive traps
  above (`EXConstants`, `expo-dev-client`, and a platforms-excludes-apple
  package). This half needs no real `ios/` directory, so unlike the real
  check it CAN run in CI and in `verify` — same relationship `check:ci-detector`
  has to `ci:checks`. Wired as `check:native-deps-guard`, in the `verify`
  chain and in the `Scripts (Python)` CI job. The real check is wired as
  `native-deps:check` — a pnpm script name deliberately outside
  `check-verify-chain.py`'s `GATE_PREFIXES`, so it is not mistaken for a gate
  that has gone silently unwired; that script's own docstring says as much:
  "If it joins `verify`, it also joins `check:verify-chain`," which is
  exactly the trap a `check:` prefix on the real, ios/-dependent script would
  reopen.
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "apps" / "mobile"


def expo_dependencies(package_json: dict) -> list[str]:
    """`expo-*` names in `dependencies` (not `devDependencies`) — see docstring scope note."""
    deps = package_json.get("dependencies", {})
    return sorted(name for name in deps if name.startswith("expo-"))


def ios_pod_names(pkg_dir: Path) -> list[str] | None:
    """Pod name(s) `pkg_dir` ships for iOS, or None if it ships no native iOS code.

    None covers two cases deliberately treated the same: no
    `expo-module.config.json` at all (pure JS, e.g. `expo-auth-session`), and
    one whose `platforms` excludes `apple`/`ios` (e.g. `expo-status-bar`,
    Android-only). Both mean "nothing to check for this package", not
    "missing".
    """
    config_path = pkg_dir / "expo-module.config.json"
    if not config_path.is_file():
        return None
    try:
        config = json.loads(config_path.read_text())
    except json.JSONDecodeError:
        return None
    platforms = config.get("platforms", [])
    if "apple" not in platforms and "ios" not in platforms:
        return None

    apple = config.get("apple", {}) or config.get("ios", {})
    podspec_paths = apple.get("podspecPath")
    if isinstance(podspec_paths, str):
        podspec_paths = [podspec_paths]
    if not podspec_paths:
        ios_dir = pkg_dir / "ios"
        podspec_paths = (
            sorted(str(p.relative_to(pkg_dir)) for p in ios_dir.glob("*.podspec"))
            if ios_dir.is_dir()
            else []
        )

    names: list[str] = []
    for rel in podspec_paths:
        spec_file = pkg_dir / rel
        if not spec_file.is_file():
            continue
        match = re.search(r"s\.name\s*=\s*['\"]([^'\"]+)['\"]", spec_file.read_text())
        if match:
            names.append(match.group(1))
    return names or None


def podfile_lock_pod_names(text: str) -> set[str]:
    """Top-level pod names from the `PODS:` section.

    A top-level entry is exactly two spaces of indent (`  - Name (1.2.3):` or
    `  - Name (1.2.3)`); a pod's own sub-dependencies are indented four spaces
    (`    - OtherPod`) and must not be mistaken for top-level entries — this
    regex requires the dash at column 2 exactly, which a 4-space line fails.
    """
    names: set[str] = set()
    in_pods = False
    for line in text.splitlines():
        if line.strip() == "PODS:":
            in_pods = True
            continue
        if not in_pods:
            continue
        if line and not line.startswith(" "):
            break  # next top-level YAML section (DEPENDENCIES:, SPEC REPOS:, ...)
        match = re.match(r"^  - ([^\s(]+)", line)
        if match:
            names.add(match.group(1))
    return names


def run_check(mobile_dir: Path) -> int:
    podfile_lock = mobile_dir / "ios" / "Podfile.lock"
    if not podfile_lock.is_file():
        try:
            shown = podfile_lock.relative_to(ROOT)
        except ValueError:
            shown = podfile_lock
        print(
            f"check-native-deps: no-op — {shown} does not exist. `ios/` is "
            "generated and gitignored; this is expected in a fresh worktree "
            "that has never run `pod install`, and in CI, which never builds it."
        )
        return 0

    package_json = json.loads((mobile_dir / "package.json").read_text())
    expo_pkgs = expo_dependencies(package_json)
    pod_names = podfile_lock_pod_names(podfile_lock.read_text())

    node_modules = mobile_dir / "node_modules"
    missing: list[tuple[str, list[str]]] = []
    unknown: list[str] = []
    skipped_no_native = 0
    checked = 0

    for pkg in expo_pkgs:
        pkg_dir = node_modules / pkg
        if not pkg_dir.is_dir():
            unknown.append(pkg)
            continue
        names = ios_pod_names(pkg_dir)
        if names is None:
            skipped_no_native += 1
            continue
        checked += 1
        if not any(name in pod_names for name in names):
            missing.append((pkg, names))

    if unknown:
        print(
            "check-native-deps: WARNING — these expo-* packages are in "
            "package.json but missing from node_modules, so their iOS pod "
            "could not be determined (run `pnpm install`): "
            + ", ".join(unknown),
            file=sys.stderr,
        )

    if missing:
        print(
            "check-native-deps: these native dependencies are in "
            "apps/mobile/package.json but their pod is absent from "
            "apps/mobile/ios/Podfile.lock:\n",
            file=sys.stderr,
        )
        for pkg, names in missing:
            expected = " or ".join(names)
            print(f"  {pkg}  (expected pod: {expected})", file=sys.stderr)
        print(
            "\nThis is the exact failure mode measured on #432/N91 with "
            "expo-camera: present in the JS bundle, absent from the native "
            "project, and an instant no-dialog termination on a Release "
            "build. Run `pnpm --dir apps/mobile run prebuild` (or `pod "
            "install` in apps/mobile/ios) to bring the native project back "
            "in sync.",
            file=sys.stderr,
        )
        return 1

    print(
        f"check-native-deps: ok — {checked} native dependencies present in "
        f"Podfile.lock, {skipped_no_native} expo-* package(s) skipped (no iOS "
        "native component)"
        + (f", {len(unknown)} skipped (node_modules missing)" if unknown else "")
    )
    return 0


# --------------------------------------------------------------------------
# --self-test: synthetic fixtures, no real ios/ required. See docstring.
# --------------------------------------------------------------------------


def _write_pkg(root: Path, pkg: str, *, config: dict | None, podspecs: dict[str, str]) -> None:
    """Build a fake node_modules/<pkg>/ with an optional expo-module.config.json
    and the given {relative_path: pod_name} podspec files."""
    pkg_dir = root / "node_modules" / pkg
    pkg_dir.mkdir(parents=True, exist_ok=True)
    if config is not None:
        (pkg_dir / "expo-module.config.json").write_text(json.dumps(config))
    for rel, pod_name in podspecs.items():
        spec_path = pkg_dir / rel
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(f"Pod::Spec.new do |s|\n  s.name = '{pod_name}'\nend\n")


def _build_fixture(tmp: Path) -> Path:
    """A mobile/ dir exercising every case this check has to get right."""
    mobile = tmp / "apps" / "mobile"
    mobile.mkdir(parents=True)

    (mobile / "package.json").write_text(json.dumps({
        "dependencies": {
            # Normal case: PascalCase(name) matches the podspec's s.name.
            "expo-camera": "~57.0.3",
            # EXConstants — defeats the naive PascalCase heuristic.
            "expo-constants": "~57.0.9",
            # expo-dev-client — verbatim pod name, also defeats it.
            "expo-dev-client": "~57.0.10",
            # No expo-module.config.json at all: pure JS, must not be flagged.
            "expo-auth-session": "~57.0.6",
            # platforms excludes apple: Android-only, must not be flagged.
            "expo-status-bar": "~57.0.1",
            # Not an expo-* package: out of scope, must not be considered at all.
            "react-native-svg": "15.15.4",
        },
    }))

    _write_pkg(
        mobile, "expo-camera",
        config={"platforms": ["apple", "android"], "apple": {"podspecPath": ["ios/ExpoCamera.podspec"]}},
        podspecs={"ios/ExpoCamera.podspec": "ExpoCamera"},
    )
    _write_pkg(
        mobile, "expo-constants",
        config={"platforms": ["apple", "android"], "apple": {}},
        podspecs={"ios/EXConstants.podspec": "EXConstants"},
    )
    _write_pkg(
        mobile, "expo-dev-client",
        config={"platforms": ["apple", "android"], "apple": {}},
        podspecs={"ios/expo-dev-client.podspec": "expo-dev-client"},
    )
    _write_pkg(mobile, "expo-auth-session", config=None, podspecs={})
    _write_pkg(mobile, "expo-status-bar", config={"platforms": ["android"]}, podspecs={})

    return mobile


def _podfile_lock(pod_names: list[str]) -> str:
    body = "\n".join(f"  - {name} (1.0.0)" for name in pod_names)
    return f"PODS:\n{body}\nDEPENDENCIES:\n  - Expo (from `../node_modules/expo`)\n"


def self_test() -> int:
    failures: list[str] = []

    def check(label: str, condition: bool) -> None:
        if not condition:
            failures.append(label)

    # 1. No Podfile.lock at all -> no-op, exit 0.
    with tempfile.TemporaryDirectory() as tmp_str:
        mobile = _build_fixture(Path(tmp_str))
        rc = run_check(mobile)
        check("no-op when Podfile.lock is absent", rc == 0)

    # 2. Complete Podfile.lock -> exit 0, and the three false-positive traps
    #    (EXConstants, expo-dev-client, no-native-code packages) do not fire.
    with tempfile.TemporaryDirectory() as tmp_str:
        mobile = _build_fixture(Path(tmp_str))
        (mobile / "ios").mkdir()
        (mobile / "ios" / "Podfile.lock").write_text(
            _podfile_lock(["ExpoCamera", "EXConstants", "expo-dev-client", "ExpoModulesCore"])
        )
        rc = run_check(mobile)
        check("passes when every native dependency's pod is present", rc == 0)

    # 3. Mutate: drop ExpoCamera from Podfile.lock -> must go red. This is the
    #    acceptance criterion's actual demonstration, reproduced hermetically
    #    so it re-runs on every `verify` rather than needing a hand rerun.
    with tempfile.TemporaryDirectory() as tmp_str:
        mobile = _build_fixture(Path(tmp_str))
        (mobile / "ios").mkdir()
        (mobile / "ios" / "Podfile.lock").write_text(
            _podfile_lock(["EXConstants", "expo-dev-client", "ExpoModulesCore"])  # ExpoCamera missing
        )
        rc = run_check(mobile)
        check("fails when a required pod is missing from Podfile.lock", rc == 1)

    # 4. Same mutation, but confirm restoring the entry makes it pass again —
    #    not by re-reading the file, by re-running the check (CLAUDE.md: "a
    #    restore is confirmed by re-running the thing that fails").
    with tempfile.TemporaryDirectory() as tmp_str:
        mobile = _build_fixture(Path(tmp_str))
        (mobile / "ios").mkdir()
        podfile_lock_path = mobile / "ios" / "Podfile.lock"
        podfile_lock_path.write_text(
            _podfile_lock(["EXConstants", "expo-dev-client", "ExpoModulesCore"])
        )
        rc_broken = run_check(mobile)
        podfile_lock_path.write_text(
            _podfile_lock(["ExpoCamera", "EXConstants", "expo-dev-client", "ExpoModulesCore"])
        )
        rc_restored = run_check(mobile)
        check("mutation goes red then a genuine restore goes green again", rc_broken == 1 and rc_restored == 0)

    # 5. A package with no node_modules entry at all -> warns, does not fail
    #    the whole check on its own (bias toward no false positives).
    with tempfile.TemporaryDirectory() as tmp_str:
        mobile = _build_fixture(Path(tmp_str))
        (mobile / "node_modules" / "expo-camera").rename(mobile / "node_modules" / "_expo-camera-moved")
        (mobile / "ios").mkdir()
        (mobile / "ios" / "Podfile.lock").write_text(
            _podfile_lock(["EXConstants", "expo-dev-client", "ExpoModulesCore"])
        )
        rc = run_check(mobile)
        check("a package missing from node_modules is skipped, not treated as failing", rc == 0)

    if failures:
        print("check-native-deps self-test FAILED:\n", file=sys.stderr)
        for label in failures:
            print(f"  - {label}", file=sys.stderr)
        return 1

    print("check-native-deps self-test ok — 5/5 cases correct")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Exercise the comparison logic against synthetic fixtures. Runs "
             "anywhere (no real ios/ needed); wired into `verify` and CI.",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    return run_check(MOBILE)


if __name__ == "__main__":
    sys.exit(main())
