#!/usr/bin/env python3
"""Fail when an installed `expo-*`/`react-native` version has drifted from
what the pinned Expo SDK expects (N133, #537) — UNLESS the version it wants
is one pnpm will not let this repo install yet (H15, #950).

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

## The second incident, which is the reason this is no longer a thin wrapper

2026-09-08 (H15, #950; H17, #952). Expo published nine patch releases
between 13:47Z and 13:50Z. This check went red on clean `main` within the
hour — correctly, the matrix had moved. But pnpm 11.17 enforces a
`minimumReleaseAge` of 24 hours BY DEFAULT (a bundled `24 * 60` in its own
config schema, not anything this repo set), so those nine packages could not
be installed until the next day: `pnpm install --frozen-lockfile` against a
lockfile containing them fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
naming every one. Two guards this repo relies on contradicted each other for
a day, and the only way to satisfy this one was to defeat the other — which
`expo install --fix` did, silently, by writing a `minimumReleaseAgeExclude`
block into `pnpm-workspace.yaml`. That block came within one `git add -A`
of landing as an unexamined side effect of "fix the red check".

The board owner's decision, recorded on #950: keep the supply-chain guard,
make THIS check tolerate a version it cannot yet install, land the bump the
next day. So:

- `expo install --check --json` says which packages are behind and what
  range each should satisfy.
- For each, the concrete version npm would pick for that range is resolved,
  and its publish time read from the registry.
- If EVERY outdated package's target was published inside pnpm's release-age
  window, that is not a drift anyone can act on today: WARN, name them and
  when they become installable, exit 0.
- If ANY outdated package's target is installable now, that is a real drift
  and this fails exactly as it always did. A same-day Expo release must not
  become cover for an older, genuinely stale dependency.

## The window, and why it is a documented constant rather than a query

pnpm exposes no reliable way to read the EFFECTIVE `minimumReleaseAge`:
`pnpm config get minimum-release-age` prints `undefined` when the value is
pnpm's bundled default, and — measured 2026-09-08 — prints `undefined` even
when a project `.npmrc` sets it. So `PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES`
below is pnpm 11.17.0's own default, read out of its `dist/pnpm.mjs`
(`"minimum-release-age": 24 * 60`) and confirmed against a real refusal
whose printed cutoff was exactly 24 hours before the run. An explicit
`VOLA_MINIMUM_RELEASE_AGE_MINUTES` in the environment overrides it, for a
repo or CI runner that has changed pnpm's setting; `0` disables the
tolerance entirely, matching what a disabled guard means.

If pnpm's default ever changes, this constant is wrong in the direction of
being TOO TOLERANT only if pnpm SHORTENS its window — and then the lockfile
refusal this exists to anticipate simply stops happening earlier, which is
harmless. If pnpm lengthens it, this check fails a day early, which is loud.

## What this wraps, and why as a wrapper rather than a bare package.json line

`pnpm --dir apps/mobile exec expo install --check` still does the real
work — it exits non-zero the moment ANY dependency is outdated relative to
the installed Expo SDK's compatibility matrix, and with `--json` it says
which. This script exists to give that failure a clear, check-specific
header, to fail loudly on a missing `apps/mobile` rather than silently no-op
— matching this repo's other `check:*` scripts' convention — and, since H15,
to apply the release-age tolerance above.

## Network requirement — measured, not assumed

`expo install --check` resolves Expo's compatibility matrix over the
network, and the tolerance adds `npm view` calls to the registry. Pointed at
an unreachable proxy, `expo install --check` fails fast with `ECONNREFUSED`,
exit 1 — a clear network error, not a false "up to date". `npm view`
likewise. CI already requires network for `pnpm install --frozen-lockfile`
in the same job, and a developer running `verify` before a push already
needs it for the push. Every call is bounded by `NETWORK_TIMEOUT_SECONDS`.

## `--self-test`, and what it can and cannot prove

The classification — "given these outdated packages, their target publish
times, the window and now, is this a tolerable drift or a real one" — is a
pure function and `--self-test` pins it against fixtures, including the
2026-09-08 case as measured. Mutation-checked on the way in: inverting the
window comparison, or dropping the "ALL must be inside" quantifier to
"ANY", fails the self-test. What the self-test cannot prove is anything
about the registry or Expo's matrix — those are the real check's job, and
the only proof of those is running it.
"""

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "apps" / "mobile"

# This used to be the one network call in `verify`/CI; the tolerance adds
# `npm view`. A refused connection fails in under a second, but a hung DNS
# lookup or TLS handshake has no other backstop locally — bound every call
# so `verify` can't block indefinitely on a stalled network call.
NETWORK_TIMEOUT_SECONDS = 60

# pnpm 11.17.0's bundled default — see the module docstring for provenance
# and for why this is a constant rather than a query.
PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 24 * 60
OVERRIDE_ENV = "VOLA_MINIMUM_RELEASE_AGE_MINUTES"


@dataclass(frozen=True)
class Outdated:
    name: str
    actual: str
    expected_range: str


@dataclass(frozen=True)
class Target:
    """The concrete version a range resolves to, and when it was published."""

    outdated: Outdated
    version: str
    published: datetime | None  # None: the registry had no time for it


@dataclass(frozen=True)
class Verdict:
    tolerated: bool
    lines: tuple[str, ...]


def release_age_window_minutes() -> int:
    raw = os.environ.get(OVERRIDE_ENV)
    if raw is None or raw.strip() == "":
        return PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES
    try:
        minutes = int(raw)
    except ValueError:
        print(f"check-expo-compat: {OVERRIDE_ENV}={raw!r} is not an integer", file=sys.stderr)
        raise SystemExit(1)
    if minutes < 0:
        print(f"check-expo-compat: {OVERRIDE_ENV} must be >= 0", file=sys.stderr)
        raise SystemExit(1)
    return minutes


def classify(targets: list[Target], window_minutes: int, now: datetime) -> Verdict:
    """The pure decision. Tolerated ONLY when the window is on and EVERY
    target is inside it; a target with no publish time is treated as
    installable (i.e. a real drift) — the conservative reading."""
    if not targets:
        return Verdict(tolerated=False, lines=())
    if window_minutes <= 0:
        return Verdict(
            tolerated=False,
            lines=("release-age tolerance is off (window is 0 minutes)",),
        )
    cutoff = now - timedelta(minutes=window_minutes)

    def stamp(d: datetime) -> str:
        # `2026-09-08T13:50:37Z`, not `…37.144000+00:00` — this line is read by
        # a human in CI output, and the microseconds say nothing they need.
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    inside: list[str] = []
    outside: list[str] = []
    for t in targets:
        label = f"{t.outdated.name}@{t.version} (have {t.outdated.actual}, want {t.outdated.expected_range})"
        if t.published is None:
            outside.append(f"{label} — registry reports no publish time; treated as installable")
        elif t.published > cutoff:
            installable_at = t.published + timedelta(minutes=window_minutes)
            inside.append(
                f"{label} — published {stamp(t.published)}, "
                f"installable after {stamp(installable_at)}"
            )
        else:
            outside.append(f"{label} — published {stamp(t.published)}, installable now")
    if outside:
        return Verdict(tolerated=False, lines=tuple(outside + inside))
    return Verdict(tolerated=True, lines=tuple(inside))


# --- the two registry calls, kept thin so classify() stays pure -------------


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=NETWORK_TIMEOUT_SECONDS)


def expo_check(cwd: Path) -> tuple[int, list[Outdated], str]:
    """(exit code, outdated packages, raw stderr)."""
    result = _run(["pnpm", "exec", "expo", "install", "--check", "--json"], cwd)
    # `--json` puts the report on stdout; Expo's env-loading chatter and the
    # human summary go to stderr. Find the JSON object in stdout defensively.
    text = result.stdout
    start = text.find("{")
    outdated: list[Outdated] = []
    if start != -1:
        try:
            report = json.loads(text[start:])
            for dep in report.get("dependencies", []):
                outdated.append(
                    Outdated(
                        name=str(dep["packageName"]),
                        actual=str(dep["actualVersion"]),
                        expected_range=str(dep["expectedVersionOrRange"]),
                    )
                )
        except (ValueError, KeyError, TypeError):
            pass
    return result.returncode, outdated, result.stderr


def _version_key(v: str) -> tuple[int, ...]:
    parts: list[int] = []
    for piece in v.split("-", 1)[0].split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def resolve_target(o: Outdated, cwd: Path) -> Target:
    """`npm view <name>@<range> version --json` returns one string, or an
    ascending array when several versions satisfy the range — npm would
    install the highest, so that is the one whose age matters."""
    r = _run(["npm", "view", f"{o.name}@{o.expected_range}", "version", "--json"], cwd)
    version: str | None = None
    if r.returncode == 0 and r.stdout.strip():
        try:
            parsed = json.loads(r.stdout)
            candidates = parsed if isinstance(parsed, list) else [parsed]
            candidates = [str(c) for c in candidates if c]
            if candidates:
                version = max(candidates, key=_version_key)
        except ValueError:
            version = None
    if version is None:
        # Could not resolve the range at all — nothing to be tolerant about;
        # the real check's own failure stands.
        return Target(outdated=o, version=o.expected_range, published=None)

    t = _run(["npm", "view", o.name, "time", "--json"], cwd)
    published: datetime | None = None
    if t.returncode == 0 and t.stdout.strip():
        try:
            times = json.loads(t.stdout)
            stamp = times.get(version) if isinstance(times, dict) else None
            if isinstance(stamp, str):
                published = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            published = None
    return Target(outdated=o, version=version, published=published)


def main() -> int:
    if not (MOBILE / "package.json").is_file():
        print(f"check-expo-compat: {MOBILE} has no package.json — nothing to check", file=sys.stderr)
        return 1

    try:
        code, outdated, stderr = expo_check(MOBILE)
    except subprocess.TimeoutExpired:
        print(
            f"\ncheck-expo-compat: `expo install --check` did not finish within "
            f"{NETWORK_TIMEOUT_SECONDS}s — likely a stalled network call to "
            "Expo's compatibility matrix, not a real dependency drift. Retry, "
            "or check connectivity.",
            file=sys.stderr,
        )
        return 1

    if code == 0:
        print("check-expo-compat: apps/mobile dependencies match the pinned Expo SDK")
        return 0

    # Print Expo's own report first, so the human-readable list is never lost
    # behind this script's interpretation of it.
    sys.stderr.write(stderr if stderr.strip() else "")

    if not outdated:
        # Non-zero with nothing parseable: a network error, or a JSON shape
        # this script does not understand. Either way there is nothing to be
        # tolerant about — fail as before.
        print(
            "\ncheck-expo-compat: `expo install --check` failed without a parseable "
            "report — see above. If that is a connection error, retry; otherwise "
            "the JSON shape may have changed and this script needs updating.",
            file=sys.stderr,
        )
        return code

    try:
        targets = [resolve_target(o, MOBILE) for o in outdated]
    except subprocess.TimeoutExpired:
        print(
            f"\ncheck-expo-compat: `npm view` did not finish within {NETWORK_TIMEOUT_SECONDS}s "
            "while resolving the expected versions — treating the drift as real.",
            file=sys.stderr,
        )
        return 1

    verdict = classify(targets, release_age_window_minutes(), datetime.now(timezone.utc))

    if verdict.tolerated:
        print(
            "\ncheck-expo-compat: WARNING — apps/mobile is behind the Expo SDK's "
            "compatibility matrix, but every newer version is still inside pnpm's "
            f"{release_age_window_minutes()}-minute minimumReleaseAge window and "
            "cannot be installed yet (H15/#950). Not failing. Land the bump once "
            "the last of these is installable, and check pnpm-workspace.yaml for a "
            "tool-written `minimumReleaseAgeExclude` block before committing:",
            file=sys.stderr,
        )
        for line in verdict.lines:
            print(f"  {line}", file=sys.stderr)
        return 0

    print(
        "\ncheck-expo-compat: apps/mobile has an expo-*/react-native "
        "version drift — see the report above. This is the exact "
        "failure class that crashed every installed device on "
        "2026-08-09 (dyld symbol-not-found abort, before any JS ran). "
        "Run `pnpm --dir apps/mobile exec expo install --fix` to bring "
        "dependencies back in line with the pinned Expo SDK version — then "
        "check pnpm-workspace.yaml for a tool-written `minimumReleaseAgeExclude` "
        "block before committing (H17/#952).",
        file=sys.stderr,
    )
    for line in verdict.lines:
        print(f"  {line}", file=sys.stderr)
    return code


# --- self-test: the pure classification, pinned --------------------------


def self_test() -> int:
    failures: list[str] = []

    def check(label: str, condition: bool) -> None:
        if not condition:
            failures.append(label)

    now = datetime(2026, 9, 8, 17, 38, 36, tzinfo=timezone.utc)
    window = 24 * 60

    def target(name: str, version: str, published_at: datetime | None) -> Target:
        return Target(Outdated(name, "0.0.0", f"~{version}"), version, published_at)

    # 1. The measured 2026-09-08 case: expo 57.0.21 published 13:50Z the same
    #    day, i.e. ~4h before the run — inside a 24h window → tolerated.
    same_day = target("expo", "57.0.21", datetime(2026, 9, 8, 13, 50, 37, tzinfo=timezone.utc))
    v = classify([same_day], window, now)
    check("a same-day release inside the window is tolerated", v.tolerated)
    check("the tolerated line says when it becomes installable", any("installable after" in l for l in v.lines))

    # 2. An older release, outside the window → a real drift → NOT tolerated.
    old = target("expo-camera", "57.0.4", datetime(2026, 9, 1, 0, 0, tzinfo=timezone.utc))
    v = classify([old], window, now)
    check("a release older than the window is a real drift", not v.tolerated)
    check("the failing line says installable now", any("installable now" in l for l in v.lines))

    # 3. The quantifier: ONE installable drift among same-day ones fails the
    #    whole check — a same-day Expo release must not be cover for a
    #    genuinely stale dependency. (Mutating ALL→ANY passes this wrongly.)
    v = classify([same_day, old], window, now)
    check("one installable drift among tolerable ones still fails", not v.tolerated)

    # 4. Exactly at the cutoff is NOT inside the window (pnpm compares
    #    published > cutoff, so a package published precisely 24h ago is
    #    installable).
    at_cutoff = target("expo-font", "57.0.3", now - timedelta(minutes=window))
    v = classify([at_cutoff], window, now)
    check("a release exactly at the cutoff is installable, hence a real drift", not v.tolerated)

    # 5. One second inside the cutoff IS tolerated — pins the comparison's
    #    direction; inverting it fails this and #1 together.
    just_inside = target("expo-font", "57.0.3", now - timedelta(minutes=window) + timedelta(seconds=1))
    v = classify([just_inside], window, now)
    check("a release one second inside the cutoff is tolerated", v.tolerated)

    # 6. The guard off (window 0) → no tolerance at all, even for same-day.
    v = classify([same_day], 0, now)
    check("a zero window disables the tolerance", not v.tolerated)

    # 7. No publish time → conservative: treated as installable → fails.
    unknown = target("expo-mystery", "1.2.3", None)
    v = classify([unknown], window, now)
    check("a target with no publish time is not tolerated", not v.tolerated)
    check("...and the line says why", any("no publish time" in l for l in v.lines))

    # 8. Nothing outdated → nothing to tolerate (caller never reaches here
    #    on exit 0, but the function must not claim tolerance for nothing).
    v = classify([], window, now)
    check("an empty list is not 'tolerated'", not v.tolerated)

    # 9. Range resolution helper: highest wins, and pre-release suffixes do
    #    not break the comparison.
    check("version key orders numerically", _version_key("57.0.21") > _version_key("57.0.9"))
    check("version key survives a pre-release suffix", _version_key("57.1.0-beta.1") == (57, 1, 0))

    # 10. The env override parses, rejects garbage, and 0 means off.
    saved = os.environ.get(OVERRIDE_ENV)
    try:
        os.environ[OVERRIDE_ENV] = "90"
        check("env override is honoured", release_age_window_minutes() == 90)
        os.environ[OVERRIDE_ENV] = ""
        check("empty env override falls back to pnpm's default", release_age_window_minutes() == PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES)
        os.environ[OVERRIDE_ENV] = "nope"
        # The rejection prints its reason to stderr; on a PASSING self-test
        # that line would read like a failure, so swallow it here only.
        import contextlib, io
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                release_age_window_minutes()
                check("a non-integer override is rejected", False)
            except SystemExit as e:
                check("a non-integer override is rejected", e.code == 1)
    finally:
        if saved is None:
            os.environ.pop(OVERRIDE_ENV, None)
        else:
            os.environ[OVERRIDE_ENV] = saved

    if failures:
        print("check-expo-compat self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print(f"check-expo-compat self-test ok ({10} groups)")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--self-test", action="store_true", help="pin the pure classification against fixtures, no network")
    args = parser.parse_args()
    sys.exit(self_test() if args.self_test else main())
