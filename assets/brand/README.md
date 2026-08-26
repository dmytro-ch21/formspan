# VOLA Brand Asset Starter Kit

Included:
- 7 logo SVGs
- 4 app icon SVG masters
- 2 splash screen SVGs
- 25 UI icons
- design-tokens.json

## Brand colors
- Lime: #D3EC52
- Green: #42F58D
- Navy: #0B1220
- Charcoal: #111827
- White: #FFFFFF
- Muted: #94A3B8

## Where the lime actually lives

`design-tokens.json` is the source of truth, and the kit is **half migrated**.
The lime moved from `#B8FF2C` to `#D3EC52` on 2026-08-25 (N183):

- **`app-icons/` and both apps' `Brand.tsx` were already on the approved
  artwork** before that ticket — they draw the folded check in `#D0E950` /
  `#9CC740` / `#71912F`, sampled from `logos/source/`, and never contained
  `#B8FF2C` at all. So the rasters generated from them need no regeneration.
- **`logos/` and `splash/` are the OLD mark** — a rounded-stroke check on a
  `#42F58D`→lime gradient, a different drawing from the one in
  `logos/source/`. N183 moved their lime stop onto the brand value so the kit
  stops disagreeing with its own token file, but **re-cutting them from
  `logos/source/` is separate, unstarted work**, and nobody has looked at the
  recoloured gradient on a screen.

`logos/source/` is the supplied artwork and is left untouched.

## Notes
- SVGs are editable in Figma, Illustrator, Sketch, and most code editors.
- UI icons use `currentColor`, so your app can recolor them through CSS, React Native SVG props, Flutter color filters, or native tinting.
- Apple App Store requires a 1024×1024 raster icon with no transparency. Export `vola-app-icon-dark-1024.svg` to PNG before submission.
- Android adaptive icons are split into foreground and background assets.
- The wordmark uses a system sans-serif fallback. For a final trademark-ready logo, convert the chosen wordmark lettering to vector outlines in Figma or Illustrator.
