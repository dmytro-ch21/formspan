#!/usr/bin/env python3
"""Fail if the two copies of the telemetry buffer drift.

One decision layer, two copies: `apps/mobile/lib/telemetry.ts` and
`apps/web/src/lib/telemetry.ts`. They decide what leaves a device and when —
coalescing, the per-fingerprint cap, the fixed-size ring, the level gate, and
`redact()`.

## Why two copies exist at all

A shared workspace package was built and measured worse here. `packages/*` is
declared in `pnpm-workspace.yaml` and empty, and the buffer would have had to
satisfy four bundlers: jest-expo, Metro, turbopack and vitest. jest-expo alone
failed twice — `transformIgnorePatterns` is the wrong lever, since pnpm links by
symlink and the real path holds no `node_modules` segment, and a package-local
babel config did not fix it either.

So the copies are allowed to exist because drift fails a check rather than
reaching an athlete. That is the same trade `check-grip-parity` and
`check-rate-parity` already make, and it is the STRONGER of the two guarantees:
a shared package is safe only while four build systems keep agreeing, while this
cannot be defeated by a bundler config change.

## The failure it prevents

Both halves stay plausible while drifted, which is what makes it dangerous.

The worst case is `redact()`. It is an ALLOWLIST — a key nobody has permitted
does not travel — and it is the control that stops an athlete's notes, food
names or a partner's handle reaching a log on the crash path, unprompted. If web
gains an allowlisted key that mobile does not have, nothing looks wrong on
either side and one platform is shipping a field the other considers private.
That is a privacy failure rather than an inconsistency, so the allowlist is
compared name by name and ORDER-SENSITIVELY, and a missing list is an error
rather than an empty comparison that passes.

## What it does not promise

Stdlib-only and syntactic, matching its two siblings: it parses the files rather
than importing them, so `verify` needs no Node. It compares the SHARED BODY —
everything from the first `Severity` declaration onward — plus the allowlist and
the tuning constants by name. The file headers deliberately differ (each
explains its own side), so they are excluded.

A copy reformatted beyond these patterns will fail here as drift even when it is
correct. Fix the parser then; do not delete the check.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MOBILE = ROOT / "apps/mobile/lib/telemetry.ts"
WEB = ROOT / "apps/web/src/lib/telemetry.ts"

# Where the shared body starts. Above this each copy explains itself, and those
# headers are SUPPOSED to differ.
BODY_MARKER = "/** Severity. Ordered"


def shared_body(text: str, path: Path) -> str:
    i = text.find(BODY_MARKER)
    if i < 0:
        raise SystemExit(
            f"{path}: could not find the shared-body marker {BODY_MARKER!r}.\n"
            "Either the file was restructured or this check is parsing the wrong "
            "thing. Fix the marker rather than deleting the check."
        )
    return text[i:]


def parse_allowlist(text: str, path: Path) -> list[str]:
    """The redaction allowlist, in order.

    A missing or empty list raises rather than returning `[]`: two empty lists
    compare equal, so a parser that quietly found nothing would report parity
    over the one thing this check exists to guard.
    """
    m = re.search(r"ALLOWED_DETAIL_KEYS\s*=\s*\[(.*?)\]\s*as const", text, re.S)
    if not m:
        raise SystemExit(f"{path}: ALLOWED_DETAIL_KEYS not found — see this script's docstring.")
    keys = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))
    if not keys:
        raise SystemExit(f"{path}: ALLOWED_DETAIL_KEYS parsed as empty, which is never correct.")
    return keys


def parse_consts(text: str) -> dict[str, str]:
    """The tuning constants that decide how much leaves a device."""
    out: dict[str, str] = {}
    for name in ("MEAN_WINDOW_DAYS", "MAX_MESSAGE", "DEFAULT_MIN_LEVEL"):
        m = re.search(rf"\b{name}[^=]*=\s*([^;]+);", text)
        if m:
            out[name] = " ".join(m.group(1).split())
    m = re.search(r"DEFAULTS:\s*TelemetryConfig\s*=\s*\{(.*?)\n\};", text, re.S)
    if m:
        for key, val in re.findall(r"^\s*(\w+):\s*([^,\n]+),", m.group(1), re.M):
            out[f"DEFAULTS.{key}"] = " ".join(val.split())
    return out


def main() -> int:
    if not MOBILE.exists() or not WEB.exists():
        print(f"missing a copy: {MOBILE if not MOBILE.exists() else WEB}", file=sys.stderr)
        return 1

    mobile_text, web_text = MOBILE.read_text(), WEB.read_text()
    problems: list[str] = []

    # 1. The allowlist, name by name and in order. The privacy half.
    m_keys, w_keys = parse_allowlist(mobile_text, MOBILE), parse_allowlist(web_text, WEB)
    if m_keys != w_keys:
        only_m = [k for k in m_keys if k not in w_keys]
        only_w = [k for k in w_keys if k not in m_keys]
        problems.append("redaction allowlist differs:")
        if only_m:
            problems.append(f"  only in mobile: {', '.join(only_m)}")
        if only_w:
            problems.append(f"  only in web:    {', '.join(only_w)}")
        if not only_m and not only_w:
            problems.append(f"  same keys, different ORDER:\n    mobile: {m_keys}\n    web:    {w_keys}")

    # 2. The tuning constants, by name.
    m_consts, w_consts = parse_consts(mobile_text), parse_consts(web_text)
    if not m_consts:
        raise SystemExit(f"{MOBILE}: no tuning constants parsed — see this script's docstring.")
    for key in sorted(set(m_consts) | set(w_consts)):
        a, b = m_consts.get(key), w_consts.get(key)
        if a != b:
            problems.append(f"{key}: mobile={a!r} web={b!r}")

    # 3. The shared body, verbatim. The blunt check that catches everything the
    #    two targeted ones above do not — a changed regex, an inverted
    #    comparison, a dropped guard.
    m_body, w_body = shared_body(mobile_text, MOBILE), shared_body(web_text, WEB)
    if m_body != w_body:
        m_lines, w_lines = m_body.splitlines(), w_body.splitlines()
        problems.append(
            f"shared body differs ({len(m_lines)} lines in mobile, {len(w_lines)} in web)"
        )
        for i, (a, b) in enumerate(zip(m_lines, w_lines)):
            if a != b:
                problems.append(f"  first difference at shared-body line {i + 1}:")
                problems.append(f"    mobile: {a.strip()[:100]}")
                problems.append(f"    web:    {b.strip()[:100]}")
                break

    if problems:
        print("telemetry buffer copies have drifted:\n", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(
            "\nThese two files are a deliberate duplicate and must change together.\n"
            f"  {MOBILE.relative_to(ROOT)}\n  {WEB.relative_to(ROOT)}\n"
            "Everything from the `Severity` declaration onward is shared; the headers "
            "above it are each file's own and may differ.",
            file=sys.stderr,
        )
        return 1

    print(
        f"telemetry parity ok — {len(m_keys)} allowlisted keys, "
        f"{len(m_consts)} constants, {len(m_body.splitlines())} shared lines"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
