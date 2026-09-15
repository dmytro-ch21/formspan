#!/usr/bin/env python3
"""Fail when an installed `expo-*`/`react-native` version has drifted from
what the pinned Expo SDK expects (N133, #537) — UNLESS the version it wants
is one pnpm will not let this repo install yet (H15, #950), one npm has
never published at all (H38, #1243), or one released in the same Expo batch
as a version in either state (H39, #1245).

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
- A target that IS installable now, but belongs to an Expo release batch with
  a member still inside the window or unpublished, is tolerated with that
  batch (H39, #1245): WARN, name the batch and when its LAST member becomes
  installable, exit 0. A batch is `release_batches()`: single-linkage on
  publish time — sorted, a target joins when it is at most
  `RELEASE_BATCH_GAP_MINUTES` (60, measured below) after the one before it.
  An unpublished target sits at `now`, the earliest it can be published. A
  target with no publish time, or whose range could not be resolved, joins
  no batch.
- If ANY outdated package's target is installable now and is NOT in such a
  batch, that is a real drift and this fails exactly as it always did. A
  same-day Expo release must not become cover for an older, genuinely stale
  dependency — which is why H39 is batch-aware rather than "fail only when
  every target is installable": that flip would let any fresh release shield
  a dependency that has been installable for weeks.

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

## The fourth incident: one release batch crossing the window a member at a time

2026-09-15 (H39, #1245). Expo published one SDK-57 patch batch over 56
minutes: `expo-task-manager@57.0.18` at 15:56:18Z, five more by 16:02:58Z,
and `expo-image-manipulator@57.0.18` (the one H38 met unpublished) at
16:52:20Z. Each leaves pnpm's window 24h after its own publish, so from
2026-09-16T15:56:18Z to 16:52:20Z some targets are installable and the last
is not. Under the any-installable rule that is an hour of red `verify` and CI
asking for a bump `expo install --fix` cannot land: pnpm still refuses the
batch's newest member.

The threshold is measured, not guessed. `npm view <pkg> time --json` for
`expo` and 27 `expo-*` packages, every SDK-57 stable publish from 2026-06-25
to 2026-09-15 (356 publishes), read 2026-09-15:

- Widest lag inside one release: 53.1 min (2026-08-14, `expo-file-system`
  after the `expo@57.0.13` batch; not a dependency here) and 49.4 min
  (2026-09-15, above). Every other release's internal gaps were at most
  16.5 min. Widest spread of one release: 56.0 min (2026-09-15).
- Closest SEPARATE releases: 31.1 min (2026-06-25, a two-package 57.0.1
  follow-up), 38.6 min (2026-07-15, the `expo@57.0.5` release then the
  `expo@57.0.6` one), 83.0 min (2026-07-07), 104.3 min (2026-09-01), then
  172.7 min and days.
- So the data does NOT separate cleanly: two pairs of separate releases were
  closer than the widest lag. 60 min is the smallest round value above 53.1.
  At 60, those two close pairs merge and every pair 83 min or more apart stays
  separate. Smaller would fail more often, which is the safe direction, but
  anything under 49.4 reopens the very hour this exists for.
- What a merge costs is bounded. A batch is tolerated only until its newest
  member leaves the window, and single-linkage chains at most (n - 1) x 60 min
  across n outdated targets. So an installable target is never held more than
  that past the moment it became installable, and a dependency published days
  before a batch is never in it.
- An unpublished member sits at `now`, so it cannot reach back a day to hold a
  batch whose published members have all aged out. If a member stays
  unpublished that long, the check fails loudly, as it did before H39.

`--self-test` groups 18-24 pin this against the real batch's timestamps.
Disabling batching, flipping to "fail only when every target is
installable", `<=` becoming `<` at the threshold, doubling the threshold, and
letting an unresolved target join a batch each fail it.

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

# H39 (#1245): two outdated targets published at most this far apart are one
# Expo release batch. Measured from the registry, not guessed — see the
# docstring's "fourth incident" section for the data: the widest lag inside one
# release was 53.1 min, and the closest separate releases that did NOT merge at
# this value were 83.0 min apart. Smaller fails more often, which is the safe
# direction.
RELEASE_BATCH_GAP_MINUTES = 60

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


def _stamp(d: datetime) -> str:
    # `2026-09-08T13:50:37Z`, not `…37.144000+00:00` — this line is read by
    # a human in CI output, and the microseconds say nothing they need.
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _batch_anchor(t: Target, now: datetime) -> datetime | None:
    """Where a target sits on the publish timeline, for batching (H39).

    - RESOLVED with a publish time: at that time.
    - UNPUBLISHED: it has not been published yet, so the earliest it can sit
      is `now`.
    - Anything else — resolved with no readable time, or UNRESOLVED — has no
      place on the timeline and joins NO batch, so it keeps the conservative
      "installable" reading. This is the only place that decides it."""
    if t.resolution is Resolution.UNPUBLISHED:
        return now
    if t.resolution is Resolution.RESOLVED and t.published is not None:
        return t.published
    return None


def release_batches(
    targets: list[Target], now: datetime, gap_minutes: int = RELEASE_BATCH_GAP_MINUTES
) -> list[tuple[Target, ...]]:
    """Pure: group the targets that have a batch anchor into release batches.

    Single-linkage on the publish timeline: sorted by (anchor, name, version),
    a target joins the batch of the target before it when its anchor is AT
    MOST `gap_minutes` later (inclusive), and starts a new batch otherwise.
    Equivalently, a target is in a batch when it is within `gap_minutes` of
    any member. The result does not depend on the order of `targets`.
    Targets with no anchor (see `_batch_anchor`) are in no batch."""
    anchored = sorted(
        ((a, t) for t in targets if (a := _batch_anchor(t, now)) is not None),
        key=lambda pair: (pair[0], pair[1].outdated.name, pair[1].version),
    )
    gap = timedelta(minutes=gap_minutes)
    batches: list[list[Target]] = []
    previous: datetime | None = None
    for anchor, t in anchored:
        if previous is not None and anchor - previous <= gap:
            batches[-1].append(t)
        else:
            batches.append([t])
        previous = anchor
    return [tuple(b) for b in batches]


def _batch_line(batch: tuple[Target, ...], window_minutes: int, now: datetime) -> str:
    """Names the batch and the moment its LAST member becomes installable."""
    members = ", ".join(f"{t.outdated.name}@{t.version}" for t in batch)
    published = [t for t in batch if t.published is not None]
    unpublished = [t for t in batch if t.resolution is Resolution.UNPUBLISHED]
    window = timedelta(minutes=window_minutes)
    span = ""
    if published:
        span = f", published {_stamp(published[0].published)} to {_stamp(published[-1].published)}"
    if unpublished:
        names = ", ".join(f"{t.outdated.name}@{t.outdated.expected_range}" for t in unpublished)
        last = f"{names} not published yet, so its last member is installable no earlier than {_stamp(now + window)}"
    else:
        newest = max(published, key=lambda t: t.published)
        last = (
            f"last member {newest.outdated.name}@{newest.version} "
            f"installable after {_stamp(newest.published + window)}"
        )
    return (
        f"release batch of {len(batch)} ({members}){span}: {last}. "
        "Its members that are installable now are tolerated until then (H39)"
    )


def classify(targets: list[Target], window_minutes: int, now: datetime) -> Verdict:
    """The pure decision. Tolerated ONLY when EVERY target is inside the
    window (and the window is on), definitely unpublished, or installable but
    in a release batch (`release_batches`) that still has a member inside the
    window or unpublished. A target with no publish time — including one whose
    range could not be resolved for any other reason — joins no batch and is
    treated as installable (i.e. a real drift), the conservative reading. So is
    an installable target whose batch has fully aged out, or that is in no
    batch with anything still maturing."""
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

    def still_maturing(t: Target) -> bool:
        # Not installable yet: unpublished, or published inside the window.
        return t.resolution is Resolution.UNPUBLISHED or (t.published is not None and t.published > cutoff)

    batches = release_batches(targets, now)
    maturing = [b for b in batches if any(still_maturing(m) for m in b)]
    in_maturing_batch = {id(m) for b in maturing for m in b}

    inside: list[str] = []
    outside: list[str] = []
    batched: list[str] = []
    for t in rest:
        label = f"{t.outdated.name}@{t.version} (have {t.outdated.actual}, want {t.outdated.expected_range})"
        if t.published is not None and t.published > cutoff:
            installable_at = t.published + timedelta(minutes=window_minutes)
            inside.append(
                f"{label} — published {_stamp(t.published)}, "
                f"installable after {_stamp(installable_at)}"
            )
            continue
        if t.published is None:
            reason = "registry reports no publish time; treated as installable"
        else:
            reason = f"published {_stamp(t.published)}, installable now"
        if id(t) in in_maturing_batch:
            batched.append(f"{label} — {reason}, but tolerated with its release batch (below)")
        else:
            outside.append(f"{label} — {reason}")
    batch_lines = [_batch_line(b, window_minutes, now) for b in maturing if len(b) > 1]
    if outside:
        return Verdict(tolerated=False, lines=tuple(outside + batched + inside + batch_lines + unpublished))
    return Verdict(tolerated=True, lines=tuple(batched + inside + batch_lines + unpublished))


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
            "compatibility matrix, but every newer version is still inside "
            f"pnpm's {release_age_window_minutes()}-minute minimumReleaseAge window, "
            "not published at all, or part of an Expo release batch whose last "
            "member is one of those, so the bump cannot be landed whole yet "
            "(H15/#950, H38/#1243, H39/#1245). Not failing. Land the bump once "
            "the last of these is installable, and check pnpm-workspace.yaml for "
            "a tool-written `minimumReleaseAgeExclude` block before committing:",
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

SELF_TEST_GROUPS = 24


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

    # --- H39 (#1245): release batches, against the real 2026-09-15 batch ---
    # Every publish time below is the registry's, read with `npm view <name>
    # time --json` on 2026-09-15; `have` is what apps/mobile had installed.
    def at(s: str) -> datetime:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))

    def member(name: str, have: str, version: str, published: str) -> Target:
        return Target(Outdated(name, have, f"~{version}"), version, at(published))

    batch_0915 = [
        member("expo-task-manager", "57.0.17", "57.0.18", "2026-09-15T15:56:18Z"),
        member("expo-sharing", "57.0.19", "57.0.20", "2026-09-15T15:58:42Z"),
        member("expo-image-picker", "57.0.17", "57.0.18", "2026-09-15T15:59:01Z"),
        member("expo", "57.0.22", "57.0.23", "2026-09-15T15:59:52Z"),
        member("expo-build-properties", "57.0.17", "57.0.18", "2026-09-15T16:00:34Z"),
        member("expo-location", "57.0.17", "57.0.18", "2026-09-15T16:02:58Z"),
        member("expo-image-manipulator", "57.0.17", "57.0.18", "2026-09-15T16:52:20Z"),
    ]
    published_six = batch_0915[:-1]
    first_member, last_member = batch_0915[0], batch_0915[-1]
    mid_crossing = at("2026-09-16T16:10:00Z")
    gap = timedelta(minutes=RELEASE_BATCH_GAP_MINUTES)
    # Real: expo-camera@57.0.5 was published four days before the batch.
    stale = member("expo-camera", "57.0.4", "57.0.5", "2026-09-11T11:43:10Z")

    # 18. The hour this exists for: part of the batch installable, the last
    #     member not → tolerated, naming the batch and 16:52:20Z.
    v = classify(batch_0915, window, mid_crossing)
    check("H39: the 15:56–16:52 crossing of one batch is tolerated", v.tolerated)
    check(
        "...the warning names the batch",
        any(l.startswith("release batch of 7 (") and "expo-task-manager@57.0.18" in l and "expo-image-manipulator@57.0.18" in l for l in v.lines),
    )
    check(
        "...and when its last member becomes installable",
        any(l.startswith("release batch of 7 ") and "last member expo-image-manipulator@57.0.18 installable after 2026-09-16T16:52:20Z" in l for l in v.lines),
    )
    check("...the six installable members are named as tolerated with the batch", sum("tolerated with its release batch" in l for l in v.lines) == 6)
    check(
        "...and the last member is still named as inside the window",
        any(l.startswith("expo-image-manipulator@57.0.18 ") and l.endswith("installable after 2026-09-16T16:52:20Z") for l in v.lines),
    )
    check("the first second of the crossing is tolerated", classify(batch_0915, window, at("2026-09-16T15:56:18Z")).tolerated)
    check("the last second of the crossing is tolerated", classify(batch_0915, window, at("2026-09-16T16:52:19Z")).tolerated)
    check("a zero window turns the batch tolerance off too", not classify(batch_0915, 0, mid_crossing).tolerated)

    # 19. From 16:52:20Z every member is installable → a real drift, land it.
    v = classify(batch_0915, window, at("2026-09-16T16:52:20Z"))
    check("H39: once the last member is installable the whole batch is a real drift", not v.tolerated)
    check("...every member is listed as installable now", sum(l.endswith("installable now") for l in v.lines) == 7)
    check("...and nothing is called tolerated", not any("tolerated" in l or l.startswith("release batch") for l in v.lines))

    # 20. Group 3's intent, kept: a stale, long-installable target beside a
    #     still-maturing batch fails the check. (Flipping to "fail only when
    #     every target is installable" passes this wrongly.)
    v = classify(batch_0915 + [stale], window, mid_crossing)
    check("H39: a stale target beside a still-maturing batch still fails", not v.tolerated)
    check(
        "...and the stale one is what fails, not the batch",
        any(l.startswith("expo-camera@57.0.5 ") and l.endswith("installable now") for l in v.lines)
        and not any(l.startswith("expo-camera@57.0.5 ") and "tolerated" in l for l in v.lines),
    )
    ancient = member("expo-font", "57.0.0", "57.0.1", "2026-07-15T10:00:56Z")
    check("...and so does a months-old one", not classify([ancient] + batch_0915, window, mid_crossing).tolerated)

    # 21. The threshold, on both sides of it and on both ends of the batch.
    #     Before the first member: exactly the threshold joins, one second
    #     more does not and, being installable, fails.
    joins = member("expo-crypto", "57.0.2", "57.0.3", _stamp(first_member.published - gap))
    apart = member("expo-crypto", "57.0.2", "57.0.3", _stamp(first_member.published - gap - timedelta(seconds=1)))
    v = classify([joins] + batch_0915, window, mid_crossing)
    check(f"H39: a target exactly {RELEASE_BATCH_GAP_MINUTES} min before the batch joins it and is tolerated", v.tolerated)
    v = classify([apart] + batch_0915, window, mid_crossing)
    check("...one second further out does not join, and being installable, fails", not v.tolerated)
    check("...naming it as installable now", any(l.startswith("expo-crypto@57.0.3 ") and l.endswith("installable now") for l in v.lines))
    #     After the last member, once the batch itself has aged out: a
    #     late target at exactly the threshold still holds it; one second
    #     later it is its own batch and the aged-out batch fails.
    aged_out = at("2026-09-16T16:55:00Z")
    late_joins = member("expo-font", "57.0.4", "57.0.5", _stamp(last_member.published + gap))
    late_apart = member("expo-font", "57.0.4", "57.0.5", _stamp(last_member.published + gap + timedelta(seconds=1)))
    check("...a late member exactly the threshold after the batch keeps it tolerated", classify(batch_0915 + [late_joins], window, aged_out).tolerated)
    check("...one second later it does not", not classify(batch_0915 + [late_apart], window, aged_out).tolerated)

    # 22. An unpublished member (H38) is a not-yet-installable member,
    #     anchored at `now`. The real H38 moment, 16:52:18Z, with a 30-minute
    #     window so the six published members are all installable: only the
    #     unpublished one, 49m20s after expo-location, holds the batch.
    unpublished_last = from_view("expo-image-manipulator", "57.0.17", "~57.0.18", 1, FIXTURE_NPM_E404_NO_MATCH)
    h38_moment = at("2026-09-15T16:52:18Z")
    v = classify(published_six + [unpublished_last], 30, h38_moment)
    check("H39: an unpublished member keeps its batch tolerated", v.tolerated)
    check(
        "...and the batch line says it is not published yet",
        any(l.startswith("release batch of 7 ") and "expo-image-manipulator@~57.0.18 not published yet" in l for l in v.lines),
    )
    check("...without it, the same six are a real drift", not classify(published_six, 30, h38_moment).tolerated)
    check("...with pnpm's real 24h window that moment is tolerated too", classify(published_six + [unpublished_last], window, h38_moment).tolerated)
    check(
        "...but it does not reach back a day to hold a batch that has aged out",
        not classify(published_six + [unpublished_last], window, mid_crossing).tolerated,
    )

    # 23. An unresolved target, or a resolved one with no publish time, joins
    #     no batch and still fails — here `now` is 57 min after expo-location,
    #     so anchoring it at `now` would wrongly pull it into the batch.
    unresolved_last = from_view("expo-image-manipulator", "57.0.17", "~57.0.18", 1, FIXTURE_NPM_ECONNREFUSED)
    no_time_last = from_view("expo-image-manipulator", "57.0.17", "~57.0.18", 0, '"57.0.18"\n')
    batch_day = at("2026-09-15T17:00:00Z")
    v = classify(published_six + [unresolved_last], window, batch_day)
    check("H39: an unresolved target still fails beside a maturing batch", not v.tolerated)
    check(
        "...with the existing no-publish-time message, not a batch one",
        any(l.startswith("expo-image-manipulator@~57.0.18 ") and l.endswith("registry reports no publish time; treated as installable") for l in v.lines),
    )
    check("...so does a resolved target with no publish time", not classify(published_six + [no_time_last], window, batch_day).tolerated)

    # 24. release_batches itself: pure, order-independent, single-linkage.
    b = release_batches(batch_0915, mid_crossing)
    check("H39: the real 2026-09-15 batch is one batch of 7", len(b) == 1 and len(b[0]) == 7)
    check("...whatever order the targets arrive in", release_batches(list(reversed(batch_0915)), mid_crossing) == b)
    t0 = at("2026-09-15T10:00:00Z")
    chain = [Target(Outdated(f"expo-chain-{i}", "0.0.0", "~1.0.0"), "1.0.0", t0 + timedelta(minutes=50 * i)) for i in range(3)]
    check("...members 50 min apart chain into one batch spanning 100 min", len(release_batches(chain, mid_crossing)) == 1)
    check("...a four-day gap splits batches", len(release_batches([stale] + batch_0915, mid_crossing)) == 2)
    check("...targets with no anchor are in no batch", release_batches([unresolved_last, no_time_last], batch_day) == [])

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
