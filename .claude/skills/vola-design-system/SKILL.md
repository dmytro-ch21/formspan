---
name: vola-design-system
description: VOLA's brand and design-token discipline — where colors, icons, spacing and typography come from and what must never be hardcoded. Use when styling any screen, adding or recoloring an icon, touching theme/appearance code, picking a color, or reviewing UI work in apps/mobile, apps/web, or apps/admin.
---

The rule underneath everything here: **facts about the brand live in exactly
one file each, and code references them — it never copies them.** Duplicated
values in this repo have measurably gone stale within hours; a hex written
inline is a fork of the brand waiting to drift.

## Sources of truth

- **`assets/brand/design-tokens.json`** — the brand palette (`brand.lime` is
  THE lime; also green/navy/charcoal/white/muted), icon specs (size, stroke,
  caps), spacing scale, radius scale. Read values from here; never restate a
  hex in code or docs. N183's history entry is the account of why: the
  implementation had drifted to a different lime doing seven jobs, and only
  one of them was the brand.
- **`assets/brand/`** — all identity assets, all SVG: logos, app-icon and
  splash masters, the UI icon set. The PNGs in `apps/mobile/assets/images/`
  are GENERATED from these — edit the SVG and regenerate, never the raster.
- **UI icons use `currentColor`** — recolor via CSS/props, never by forking
  the SVG file.
- **`apps/admin/app/globals.css` `@theme` block** — admin's tokens, from the
  shared hi-fi design file (Barlow / Barlow Condensed).
- **`scripts/generate_sounds.py`** — the sonic identity, same relationship
  to the app as `assets/brand/`: synthesized, script is the source. Levels
  are intentionally unequal; do not "fix" by normalizing.

## Hard rules

1. **No arbitrary new colors.** A color not derivable from the tokens file
   is a proposal to change the brand, which is a decision to surface, not a
   line to commit.
2. **Theme-following surfaces reference variables, never literals.**
   `apps/web/src/app/clerkAppearance.ts` is the canonical example: its
   `appearance.variables` are `var(--c-*)` references — a literal color
   there silently gives dark-mode users a white modal, because the modal
   can't follow a toggle it can't see.
3. **Dark-mode-first on mobile.** A color choice must be checked in dark
   mode before it's checked in light.
4. **Touch and contrast floors are design-system properties, not
   per-screen choices** — large one-handed controls, accessible contrast
   (see the `vola-athlete-ux` skill for the product reasoning).

## Known asymmetry — do not copy the wrong reference

**`apps/web`'s current visual style predates the design system and does not
yet follow it.** Reconciling that is separate, not-yet-started work. When
building something new, take tokens and component conventions from
`apps/admin` and `assets/brand`, not from what `apps/web` happens to look
like today.

## Not covered here, and where it lives

- What screens should *say* and how they're structured: `vola-athlete-ux`.
- The app-icon/splash generation pipeline and the permission traps a native
  rebuild carries: CLAUDE.md "Known gotchas".
- Why sounds are levelled unequally: `scripts/generate_sounds.py`'s own
  comments.
