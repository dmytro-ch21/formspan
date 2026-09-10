# Vendored skills — attribution

Seven skills in this directory are vendored from
[emilkowalski/skills](https://github.com/emilkowalski/skills), MIT licensed
(© 2026 Emil Kowalski). Full licence text: `ATTRIBUTION-emilkowalski-LICENSE`.

Vendored at upstream commit `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7`, on 2026-09-09.

| Skill | What it is for |
|---|---|
| `apple-design` | Apple's interface and motion principles, from the WWDC design talks |
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

## Known dangling reference

`animate-expo`'s frontmatter says *"For web animation use `animate`"*.
Upstream's `animate` skill (the web counterpart) is **not** vendored here — it
was outside the requested set. If web motion work picks up (see N559), vendor it
the same way rather than letting the reference stay broken.

## Updating

Re-copy from upstream and bump the commit above. Do not hand-edit the vendored
files: a local edit is invisible at the next update and will be silently
reverted. If VOLA needs to say something different from upstream, say it in
`CLAUDE.md` or in a `vola-*` skill, which is where this repo's own rules live.
