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
