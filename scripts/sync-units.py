#!/usr/bin/env python3
"""Generate `apps/web`'s units module from `apps/mobile`'s, and fail if it drifts.

    python3 scripts/sync-units.py            # --check: fail if web is out of date
    python3 scripts/sync-units.py --write    # regenerate web's copy from mobile's

`--check` runs in `verify` (as `check:units`) and in the `Scripts (Python)` CI
job, so a units edit that nobody regenerated is a red build rather than a
platform difference an athlete finds.

## Why generation, and not the two obvious alternatives

Units are read on nearly every screen in both apps, and until N105 there were
**two hand-maintained copies** — 179 lines and 16 exports in mobile, 137 and 12
in web. They had already drifted: web lacked all four fluid functions, so mobile
could render a volume in the athlete's own units and web could not. Nobody chose
that; it is what two copies do.

**A shared workspace package is the obvious fix and this repo has already
measured it.** N50 built `packages/telemetry` for the same shape — package.json,
tsconfig, the module moved, mobile rewired, pnpm linking it correctly first try
— and abandoned it after jest died and two attempted fixes were both wrong,
"two bundlers down with three untested ahead" (Metro's `watchFolders`,
turbopack's `transpilePackages`, a vitest alias). The tree was fully restored.
`packages/*` is still declared in `pnpm-workspace.yaml` and still empty.

Note that N50's *load-bearing* argument does not transfer here: telemetry's
transport genuinely could not be shared, because React Native routes unhandled
rejections through `ExceptionsManager` while a browser has real events. This
module has no platform surface at all — it is `Math.round` and `toLocaleString`.
So what rules a package out is only the bundler cost, which is real and which
generation avoids entirely: both files stay exactly where they already sat, so
all four bundlers resolve them unchanged and neither app gains a dependency.

**A parity check is the third option, and the repo says it is second-best.**
`scripts/check-brand-copies.mjs`, which guards the same shape for the brand
components, opens by calling itself "a stopgap" and naming the real fix as
"generating both files from source, the way `scripts/generate_icons.mjs` now
generates the mobile icon set". This is that. Generation is strictly stronger
than parity — parity says the two agree, generation says web matches the source
— and unlike parity it ships a fix rather than only a red light.

## What is copied, and what deliberately is not

Everything from `MARKER` onward, byte for byte. That is the whole module minus
its header comment, and the headers are expected to differ: mobile's says it is
the source and how to regenerate, web's says it is generated and must not be
edited. Forcing the headers to match is what produced the *wrong* comment in
`check-brand-copies`'s own history, so they are excluded here on purpose.

No transformation is applied to the body — no quote-style rewriting, no import
rewriting — and that is a property worth keeping rather than an omission.
Neither app's eslint config has a quote rule (checked: `eslint-config-expo` and
`eslint-config-next`, neither enables one, and there is no prettier anywhere in
this repo), the module imports nothing, and it references no platform global. A
byte-for-byte copy is therefore both the simplest transform and the only one
that cannot introduce a difference of its own.

**If that ever stops being true** — the module gains an import, or an app gains
a formatting rule — do not add a rewriting step here. Split the platform-varying
part out of the shared body first, the way `check-telemetry-parity.py` compares
"the whole shared body from the first `Severity` declaration onward" and leaves
the file headers alone. A generator that edits code as it copies it is one whose
output nobody can reason about from the source.

## What this cannot promise

It compares text, not behaviour. If both files are wrong in the same way this is
green, so the conversions themselves are covered by tests on each side
(`apps/mobile/lib/__tests__/units.test.ts` and
`apps/web/src/lib/__tests__/units.test.ts`) rather than here.

Stdlib-only, matching its four parity siblings, so `verify` needs no toolchain
and the `Scripts (Python)` CI job — which deliberately installs neither Node nor
pnpm — can run it directly as `python3`.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SOURCE = ROOT / "apps/mobile/lib/units.ts"
GENERATED = ROOT / "apps/web/src/lib/units.ts"

#: The first line of the module proper. Everything above it is the file's own
#: header comment, which the two are meant to differ on.
MARKER = "export type UnitSystem ="

HEADER = """/**
 * Display units — GENERATED FILE, DO NOT EDIT.
 *
 * Generated from `apps/mobile/lib/units.ts` by `scripts/sync-units.py`. Edit
 * that file, run `python3 scripts/sync-units.py --write`, and commit both.
 * `pnpm run check:units` fails if this copy is out of date, in `verify` and in
 * CI, so an edit made here instead is caught rather than silently lost on the
 * next regeneration.
 *
 * The reason it is generated rather than shared or hand-copied is recorded in
 * the generator's docstring and in the source file's header: hand-copies had
 * already drifted (this file was missing all four fluid functions), and a
 * shared workspace package was built and abandoned two bundlers down in N50.
 * Generation costs no bundler configuration, because this file sits exactly
 * where it always sat.
 */
"""


def render(source_text: str) -> str:
    at = source_text.find(MARKER)
    if at == -1:
        raise SystemExit(
            f"sync-units: could not find {MARKER!r} in {SOURCE.relative_to(ROOT)}.\n"
            "That marker is the boundary between the file's header comment and "
            "the module body this script copies. It was renamed or reordered.\n"
            "Update MARKER in scripts/sync-units.py to the new first line of the "
            "module — do NOT delete the check. A generator that cannot find its "
            "own starting point and carries on would emit a truncated units "
            "module, which every screen in both apps reads."
        )
    return HEADER + "\n" + source_text[at:]


def main() -> int:
    write = "--write" in sys.argv[1:]
    unknown = [a for a in sys.argv[1:] if a not in ("--write", "--check")]
    if unknown:
        # Not tolerated silently: a typo'd flag that falls through to --check
        # would report success for a run somebody believed had regenerated.
        print(f"sync-units: unrecognised argument(s): {' '.join(unknown)}")
        print("Usage: sync-units.py [--check | --write]")
        return 2

    if not SOURCE.exists():
        print(f"sync-units: source {SOURCE.relative_to(ROOT)} does not exist.")
        return 1

    expected = render(SOURCE.read_text())

    if write:
        GENERATED.parent.mkdir(parents=True, exist_ok=True)
        GENERATED.write_text(expected)
        lines = expected.count("\n")
        print(f"wrote {GENERATED.relative_to(ROOT)} from {SOURCE.relative_to(ROOT)} ({lines} lines)")
        return 0

    if not GENERATED.exists():
        print(
            f"sync-units: {GENERATED.relative_to(ROOT)} is missing.\n"
            "Run: python3 scripts/sync-units.py --write"
        )
        return 1

    actual = GENERATED.read_text()
    if actual != expected:
        exp_lines = expected.split("\n")
        act_lines = actual.split("\n")
        first = next(
            (
                i
                for i in range(max(len(exp_lines), len(act_lines)))
                if (exp_lines[i] if i < len(exp_lines) else None)
                != (act_lines[i] if i < len(act_lines) else None)
            ),
            0,
        )
        print(
            f"sync-units: {GENERATED.relative_to(ROOT)} is out of date with "
            f"{SOURCE.relative_to(ROOT)}.\n\n"
            f"First difference at line {first + 1}:\n"
            f"  expected: {exp_lines[first] if first < len(exp_lines) else '<end of file>'!r}\n"
            f"  actual:   {act_lines[first] if first < len(act_lines) else '<end of file>'!r}\n\n"
            "If you edited apps/mobile/lib/units.ts, regenerate:\n"
            "  python3 scripts/sync-units.py --write\n\n"
            "If you edited apps/web/src/lib/units.ts, move the change to the "
            "mobile file instead — this one is generated and your edit will be "
            "overwritten."
        )
        return 1

    exports = expected.count("\nexport ")
    print(f"apps/web units module is generated and current ({exports} exports)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
