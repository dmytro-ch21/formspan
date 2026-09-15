#!/usr/bin/env python3
"""Fail when an installed `expo-*`/`react-native` version has drifted from
what the pinned Expo SDK expects (N133, #537) — UNLESS the version it wants
is one pnpm will not let this repo install yet (H15, #950), or one npm has
never published at all (H38, #1243).

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
- If a range resolves to NO published version at all (H38, #1243), that is
  not installable either, and is tolerated the same way: WARN, name it as
  unpublished, exit 0 — provided everything else is tolerable too. Only a
  definite answer counts: npm's `E404` whose summary is exactly
  `No match found for version <range>`. A 404 for the whole package, a
  network error (`ECONNREFUSED`), a timeout, a different error code, or output
  this script cannot parse is NOT "unpublished" — it keeps the conservative
  reading below and fails.
- A range that resolves to a version whose publish time cannot be read is
  treated as installable, i.e. a real drift — the conservative reading.
- If ANY outdated package's target is installable now, that is a real drift
  and this fails exactly as it always did. A same-day Expo release must not
  become cover for an older, genuinely stale dependency.

## The third incident: a version Expo asks for that npm never had

2026-09-15 (H38, #1243). `expo install --check` asked for
`expo-image-manipulator@~57.0.18` while npm's newest 57.x was 57.0.17 — Expo's
compatibility data was published ahead of the package itself. `npm view` could
not resolve the range, so this script recorded no publish time and called it
"installable now", failing `verify` and CI for a bump nobody could make
(`expo install --fix` cannot install a version that does not exist). The two
`npm view … version --json` outputs that matter, measured that day with npm
10.9.2, are the fixtures in `--self-test`: the E404 "No match found" object
that is tolerated, and the `ECONNREFUSED` object that is not. (57.0.18 was in
fact published two seconds after the 404 was measured — the gap is real but
can be short.)

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
release-age tolerance entirely, matching what a disabled guard means. It does
not disable the unpublished tolerance, which has nothing to do with pnpm's
window: with the guard off, a version that does not exist still cannot be
installed.

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
likewise, though not fast: against a closed local port it retried for ~70s
before printing `ECONNREFUSED` (measured 2026-09-15), which is past
`NETWORK_TIMEOUT_SECONDS`, so on the real path that case fails as a timeout.
CI already requires network for `pnpm install --frozen-lockfile`
in the same job, and a developer running `verify` before a push already
needs it for the push. Every call is bounded by `NETWORK_TIMEOUT_SECONDS`.

## `--self-test`, and what it can and cannot prove

The classification — "given these outdated packages, their target publish
times, the window and now, is this a tolerable drift or a real one" — is a
pure function and `--self-test` pins it against fixtures, including the
2026-09-08 case as measured. So is the reading of `npm view`'s output into a
resolution (resolved / unpublished / unresolved), pinned against npm's own
output captured verbatim on 2026-09-15. Mutation-checked on the way in:
inverting the window comparison, or dropping the "ALL must be inside"
quantifier to "ANY", fails the self-test; so does treating an unpublished
range as installable, treating any resolution failure as unpublished, or
accepting a non-E404 error (or a whole-package 404) as unpublished. What the
self-test cannot prove is anything about the registry or Expo's matrix —
those are the real check's job, and the only proof of those is running it.
"""

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
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

# npm 10.9.2's `error.summary` when the package exists but no published
# version satisfies the requested range (measured 2026-09-15). A 404 for a
# package that does not exist at all reads `Not Found - GET <url> - Not found`
# instead, and is deliberately NOT treated as unpublished.
NPM_NO_MATCH_SUMMARY_PREFIX = "No match found for version "


class Resolution(Enum):
    RESOLVED = "resolved"  # npm named a concrete version for the range
    UNPUBLISHED = "unpublished"  # npm said, definitely, no version satisfies the range
    UNRESOLVED = "unresolved"  # anything else: network, other error, unparseable output


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
    resolution: Resolution = Resolution.RESOLVED


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


def _tolerated_as_unpublished(t: Target) -> bool:
    return t.resolution is Resolution.UNPUBLISHED


def classify(targets: list[Target], window_minutes: int, now: datetime) -> Verdict:
    """The pure decision. Tolerated ONLY when EVERY target is either inside
    the window (and the window is on) or definitely unpublished; a target with
    no publish time — including one whose range could not be resolved for any
    other reason — is treated as installable (i.e. a real drift), the
    conservative reading."""
    if not targets:
        return Verdict(tolerated=False, lines=())

    unpublished = [
        f"{t.outdated.name}@{t.outdated.expected_range} (have {t.outdated.actual}) — "
        f"unpublished: no version satisfies {t.outdated.expected_range} on the registry yet, "
        "nothing to install"
        for t in targets
        if _tolerated_as_unpublished(t)
    ]
    rest = [t for t in targets if not _tolerated_as_unpublished(t)]
    if not rest:
        return Verdict(tolerated=True, lines=tuple(unpublished))

    if window_minutes <= 0:
        return Verdict(
            tolerated=False,
            lines=("release-age tolerance is off (window is 0 minutes)", *unpublished),
        )
    cutoff = now - timedelta(minutes=window_minutes)

    def stamp(d: datetime) -> str:
        # `2026-09-08T13:50:37Z`, not `…37.144000+00:00` — this line is read by
        # a human in CI output, and the microseconds say nothing they need.
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    inside: list[str] = []
    outside: list[str] = []
    for t in rest:
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
        return Verdict(tolerated=False, lines=tuple(outside + inside + unpublished))
    return Verdict(tolerated=True, lines=tuple(inside + unpublished))


# --- reading npm's answer, pure so the self-test can pin it -----------------


def _version_key(v: str) -> tuple[int, ...]:
    parts: list[int] = []
    for piece in v.split("-", 1)[0].split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def is_unpublished_range(returncode: int, stdout: str, requested_range: str) -> bool:
    """True ONLY for npm's definite "this package has no version satisfying
    this range": a non-zero exit, and `--json` stdout carrying
    `{"error": {"code": "E404", "summary": "No match found for version <range>"}}`
    for exactly the range asked about. Everything else — a whole-package 404,
    `ECONNREFUSED` and every other code, empty or non-JSON output — is False,
    so the caller keeps the conservative reading."""
    if returncode == 0:
        return False
    try:
        parsed = json.loads(stdout)
    except ValueError:
        return False
    if not isinstance(parsed, dict):
        return False
    error = parsed.get("error")
    if not isinstance(error, dict):
        return False
    if error.get("code") != "E404":
        return False
    summary = error.get("summary")
    if not isinstance(summary, str):
        return False
    return summary == NPM_NO_MATCH_SUMMARY_PREFIX + requested_range


def resolution_from_view(returncode: int, stdout: str, requested_range: str) -> tuple[Resolution, str | None]:
    """Read `npm view <name>@<range> version --json`. On success it returns
    one string, or an ascending array when several versions satisfy the
    range — npm would install the highest, so that is the one whose age
    matters."""
    if returncode == 0 and stdout.strip():
        try:
            parsed = json.loads(stdout)
            candidates = parsed if isinstance(parsed, list) else [parsed]
            candidates = [str(c) for c in candidates if c]
            if candidates:
                return Resolution.RESOLVED, max(candidates, key=_version_key)
        except ValueError:
            pass
        return Resolution.UNRESOLVED, None
    if is_unpublished_range(returncode, stdout, requested_range):
        return Resolution.UNPUBLISHED, None
    return Resolution.UNRESOLVED, None


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


def resolve_target(o: Outdated, cwd: Path) -> Target:
    r = _run(["npm", "view", f"{o.name}@{o.expected_range}", "version", "--json"], cwd)
    resolution, version = resolution_from_view(r.returncode, r.stdout, o.expected_range)
    if version is None:
        # UNPUBLISHED: npm said no such version exists — classify() tolerates
        # it. UNRESOLVED: could not resolve the range at all — nothing to be
        # tolerant about; the real check's own failure stands.
        return Target(outdated=o, version=o.expected_range, published=None, resolution=resolution)

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
            "compatibility matrix, but every newer version is either still inside "
            f"pnpm's {release_age_window_minutes()}-minute minimumReleaseAge window "
            "or not published at all, so none can be installed yet (H15/#950, "
            "H38/#1243). Not failing. Land the bump once the last of these is "
            "installable, and check pnpm-workspace.yaml for a tool-written "
            "`minimumReleaseAgeExclude` block before committing:",
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

# `npm view "expo-image-manipulator@~57.0.18" version --json`, stdout, exit 1,
# npm 10.9.2, 2026-09-15T16:52:18Z — two seconds before 57.0.18 was published.
FIXTURE_NPM_E404_NO_MATCH = """{
  "error": {
    "code": "E404",
    "summary": "No match found for version ~57.0.18",
    "detail": "'expo-image-manipulator@~57.0.18' is not in this registry.\\n\\nNote that you can also install from a\\ntarball, folder, http url, or git url."
  }
}
"""

# `npm view "expo-image-manipulator@~57.0.18" version --json --registry
# http://127.0.0.1:9`, stdout, exit 1 after ~70s of retries, same day. The
# same object with `npm_config_registry` set instead of the flag.
FIXTURE_NPM_ECONNREFUSED = """{
  "error": {
    "code": "ECONNREFUSED",
    "summary": "FetchError: request to http://127.0.0.1:9/expo-image-manipulator failed, reason: connect ECONNREFUSED 127.0.0.1:9",
    "detail": "If you are behind a proxy, please make sure that the\\n'proxy' config is set properly.  See: 'npm help config'"
  }
}
"""

# `npm view "vola-h38-definitely-not-a-package-zzq@~1.0.0" version --json`,
# stdout, exit 1, same day: a 404 for a package that does not exist at all.
FIXTURE_NPM_E404_NO_PACKAGE = """{
  "error": {
    "code": "E404",
    "summary": "Not Found - GET https://registry.npmjs.org/vola-h38-definitely-not-a-package-zzq - Not found",
    "detail": "'vola-h38-definitely-not-a-package-zzq@~1.0.0' is not in this registry.\\n\\nNote that you can also install from a\\ntarball, folder, http url, or git url."
  }
}
"""

# SYNTHETIC, not measured: the no-match summary under a different code. It
# exists only so the E404 code check is exercised by an input it must reject.
FIXTURE_SYNTHETIC_E500_NO_MATCH = FIXTURE_NPM_E404_NO_MATCH.replace('"E404"', '"E500"')

SELF_TEST_GROUPS = 17


def self_test() -> int:
    failures: list[str] = []

    def check(label: str, condition: bool) -> None:
        if not condition:
            failures.append(label)

    now = datetime(2026, 9, 8, 17, 38, 36, tzinfo=timezone.utc)
    window = 24 * 60

    def target(name: str, version: str, published_at: datetime | None) -> Target:
        return Target(Outdated(name, "0.0.0", f"~{version}"), version, published_at)

    def from_view(name: str, actual: str, rng: str, returncode: int, stdout: str) -> Target:
        # The same construction resolve_target performs, minus the network.
        resolution, version = resolution_from_view(returncode, stdout, rng)
        o = Outdated(name, actual, rng)
        if version is None:
            return Target(o, rng, None, resolution)
        return Target(o, version, None, resolution)

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

    # The measured 2026-09-15 case, through the same pure reading
    # resolve_target uses: expo-image-manipulator@~57.0.18 with 57.0.17 installed.
    unpublished = from_view("expo-image-manipulator", "57.0.17", "~57.0.18", 1, FIXTURE_NPM_E404_NO_MATCH)
    network_down = from_view("expo-image-manipulator", "57.0.17", "~57.0.18", 1, FIXTURE_NPM_ECONNREFUSED)

    # 11. Unpublished only → tolerated (exit 0), named as unpublished.
    check("the measured E404 no-match reads as UNPUBLISHED", unpublished.resolution is Resolution.UNPUBLISHED)
    v = classify([unpublished], window, now)
    check("an unpublished-only drift is tolerated", v.tolerated)
    check(
        "the tolerated line names the range as unpublished",
        any(l.startswith("expo-image-manipulator@~57.0.18 ") and "unpublished" in l for l in v.lines),
    )
    check("an unpublished range is not called installable", not any("installable now" in l or "no publish time" in l for l in v.lines))

    # 12. Unpublished + inside the window → tolerated (exit 0), both named.
    v = classify([same_day, unpublished], window, now)
    check("unpublished plus within-window is tolerated", v.tolerated)
    check("...naming both", any("installable after" in l for l in v.lines) and any("unpublished" in l for l in v.lines))

    # 13. Unpublished + installable now → a real drift (exit 1). An unpublished
    #     range must not be cover for a stale dependency either.
    v = classify([unpublished, old], window, now)
    check("unpublished plus installable-now still fails", not v.tolerated)
    check("...and still lists the unpublished one", any("unpublished" in l for l in v.lines))

    # 14. A network failure is NOT unpublished → conservative, fails (exit 1)
    #     with the existing message.
    check("the measured ECONNREFUSED reads as UNRESOLVED", network_down.resolution is Resolution.UNRESOLVED)
    v = classify([network_down], window, now)
    check("a network-error resolution is not tolerated", not v.tolerated)
    check("...with the existing no-publish-time message", any("no publish time; treated as installable" in l for l in v.lines))
    v = classify([network_down, same_day], window, now)
    check("a network-error resolution alongside a same-day release still fails", not v.tolerated)

    # 15. Resolved but no readable publish time → unchanged: installable (exit 1).
    resolved = from_view("expo-font", "57.0.2", "~57.0.3", 0, '"57.0.3"\n')
    check("a resolved version reads as RESOLVED", resolved.resolution is Resolution.RESOLVED and resolved.version == "57.0.3")
    ranged = from_view("expo-font", "57.0.2", "~57.0", 0, '[\n  "57.0.3",\n  "57.0.10"\n]\n')
    check("an array resolves to the highest", ranged.resolution is Resolution.RESOLVED and ranged.version == "57.0.10")
    v = classify([resolved], window, now)
    check("published without a time is still treated as installable", not v.tolerated)
    check("...and is not reported as unpublished", not any("unpublished" in l for l in v.lines))
    check("exit 0 with unparseable output is UNRESOLVED", resolution_from_view(0, "not json", "~1.0.0") == (Resolution.UNRESOLVED, None))

    # 16. Window 0 turns off the RELEASE-AGE tolerance only: a version that
    #     does not exist is still not installable with the guard off.
    v = classify([unpublished], 0, now)
    check("a zero window still tolerates an unpublished-only drift", v.tolerated)
    v = classify([unpublished, same_day], 0, now)
    check("a zero window with a same-day release still fails", not v.tolerated)

    # 17. The 404 parser, against npm's own output.
    check("parser: measured E404 no-match is unpublished", is_unpublished_range(1, FIXTURE_NPM_E404_NO_MATCH, "~57.0.18"))
    check("parser: measured ECONNREFUSED is not", not is_unpublished_range(1, FIXTURE_NPM_ECONNREFUSED, "~57.0.18"))
    check("parser: measured whole-package 404 is not", not is_unpublished_range(1, FIXTURE_NPM_E404_NO_PACKAGE, "~1.0.0"))
    check("parser: a non-E404 code with the no-match summary is not", not is_unpublished_range(1, FIXTURE_SYNTHETIC_E500_NO_MATCH, "~57.0.18"))
    check("parser: a no-match for a different range is not", not is_unpublished_range(1, FIXTURE_NPM_E404_NO_MATCH, "~57.0.19"))
    check("parser: exit 0 is never unpublished", not is_unpublished_range(0, FIXTURE_NPM_E404_NO_MATCH, "~57.0.18"))
    check("parser: empty output is not", not is_unpublished_range(1, "", "~57.0.18"))
    check("parser: non-JSON output is not", not is_unpublished_range(1, "npm error code E404\n", "~57.0.18"))
    check("parser: a JSON array is not", not is_unpublished_range(1, "[]", "~57.0.18"))

    if failures:
        print("check-expo-compat self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print(f"check-expo-compat self-test ok ({SELF_TEST_GROUPS} groups)")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--self-test", action="store_true", help="pin the pure classification against fixtures, no network")
    args = parser.parse_args()
    sys.exit(self_test() if args.self_test else main())
