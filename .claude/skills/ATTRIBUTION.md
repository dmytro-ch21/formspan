# Vendored skills — attribution

Eight skills in this directory are vendored from
[emilkowalski/skills](https://github.com/emilkowalski/skills), MIT licensed
(© 2026 Emil Kowalski). Full licence text: `ATTRIBUTION-emilkowalski-LICENSE`.

Vendored at upstream commit `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7`, on 2026-09-09.

| Skill | What it is for |
|---|---|
| `apple-design` | Apple's interface and motion principles, from the WWDC design talks |
| `animate` | Building web animation from scratch — CSS, springs, interruption, exits |
| `animate-expo` | The same bar for React Native / Expo — gestures, sheets, haptics, threading |
| `review-animations` | Strict review of animation code. User-invocable only |
| `improve-animations` | Audit motion across a codebase, emit self-contained plans |
| `find-animation-opportunities` | Find what should animate — and reject what shouldn't |
| `animation-vocabulary` | Name a motion effect precisely so you can ask for it |
| `pick-ui-library` | Curated library picks. User-invocable only |

## Why vendored rather than referenced

The same reason every other fact in this repo lives in one file: a skill read
from a personal `~/.claude/skills` directory is invisible to every other
session, to CI, and to every subagent spawned on another machine. Vendoring
makes the bar the repo's, not an individual's.

## Two of them do not auto-trigger, on purpose

`review-animations` and `pick-ui-library` set `disable-model-invocation: true`
upstream. That is deliberate and is preserved — a strict review gate and a
taste-driven library picker are things a person asks for, not things a model
decides it needs. Invoke them as `/review-animations` and `/pick-ui-library`.

## Cross-references resolve

`animate` and `animate-expo` point at each other, and both point at
`review-animations`, `improve-animations`, `find-animation-opportunities` and
`pick-ui-library`. **Every skill referenced by a vendored skill is itself
vendored here** — checked, not assumed. If you add or drop one, re-check that
property; a skill telling an agent to "use `X`" when `X` is absent sends it
looking for something that will never be found, and nothing reports that.

Upstream's remaining skills — `prototype`, `emil-design-eng`, `write-swift`,
`ask-sonner` — are deliberately not vendored and are referenced by none of the
eight.

## Updating

Re-copy from upstream and bump the commit above. Do not hand-edit the vendored
files: a local edit is invisible at the next update and will be silently
reverted. If VOLA needs to say something different from upstream, say it in
`CLAUDE.md` or in a `vola-*` skill, which is where this repo's own rules live.
