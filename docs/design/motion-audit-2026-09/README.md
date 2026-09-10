# Motion & design audit — 2026-09-09

Three independent audits of `apps/mobile`, `apps/web` and `apps/admin`, run on
Opus against the skills vendored in `.claude/skills/` (see `ATTRIBUTION.md`).
Each ran read-only, with no knowledge of the others.

| File | Skill | Lines |
|---|---|---|
| `00-merged.md` | — | 182 |
| `01-apple-design.md` | `apple-design` | 967 |
| `02-improve-animations.md` | `improve-animations` | 1,590 |
| `03-opportunities.md` | `find-animation-opportunities` | 354 |

**Start with `00-merged.md`.** It de-duplicates the three into 16 units of work,
records where they disagreed, and carries the "Do NOT do these" list. The
individual audits are kept because the merged view drops evidence: each finding's
`file:line` anchors, quoted snippets and exact recipes live in the source docs.

`02-improve-animations.md` additionally carries **seven self-contained
implementation plans (P1–P7)**, each executable by an agent with no access to
the audit's reasoning.

## Status

Filed as N556–N561, F38–F46, L14, H22. **Nothing here was verified on a device** —
every claim about feel is derived from source and measured values, which is why
the mobile tickets carry a device-evidence criterion.

## Reproducing

The three audits are re-runnable: point an agent at the skill, the app, and the
repo's own `vola-design-system` / `vola-athlete-ux` rules. What made these useful
was the constraint to cite `file:line` with quoted evidence or drop the finding,
and the instruction to say explicitly what was *not* covered.

## Anchor corrections

Every `file:line` in these documents was re-verified against `f00c6a82` during
ticket filing. Two had drifted, and **the tickets carry the corrected line while
the audit text below still shows the original** — the audits are kept as the
record of what was found, not silently rewritten:

| What | Audit says | Actually at | Where |
|---|---|---|---|
| `TrackerCard`'s `scale(0)` binding | `:504-509` | **`:517`** | `02-improve-animations.md` H4 |
| `EntryRow`'s boolean-bound scale | `:264` (doc 02) / `:266` (doc 01) | **`:266`** | F44 |

The three hand-rolled toggles (F43) were cited by their *style* lines rather
than their markup; the ticket carries both columns.

Nothing in `apps/admin/src/app/content/*Button.tsx` was read by any of the three
audits — L14's claim there is a file-level count only, and says so.

Every repo-wide count in these documents reproduced exactly on re-measurement:
493 pressables across 125 files, 0 `pressRetentionOffset`, 0
`prefers-reduced-motion` in web and admin, 0 `origin-`, 0 `duration-`/`ease-`
classes on web, 12 of 179 Typography importers, 1,247 raw `fontSize` sites, 0 of
31 admin files with motion, and 1 real `useReducedMotion` consumer.
