/**
 * VOLA's brand marks, inlined as SVG.
 *
 * **Inlined rather than `<Image>`d, and drawn with `fill="currentColor"`, so
 * one asset serves both themes.** The letters take the ambient text colour —
 * `#10151F` on light, `#F3F6FA` on dark — with no second file and no rule
 * choosing between them.
 *
 * To be accurate about *why*: a two-file approach would also have painted
 * correctly on first load. `ThemeScript` is a blocking inline script in
 * `<head>`, so `data-theme` is set before the body is parsed, and a CSS rule
 * keyed on it would resolve before first paint rather than after hydration.
 * The argument for `currentColor` is therefore not "it avoids a flash" — it is
 * that there is no second asset to keep in sync and no rule to get wrong, and
 * the colours are the theme's own tokens rather than two hexes baked into
 * files. It also renders without a network request.
 *
 * The mark keeps its own three greens rather than taking `currentColor` — it
 * is a coloured object, not an icon, and it reads on both grounds unchanged.
 *
 * **Both primitives are unconditionally `aria-hidden`, so a caller must supply
 * the accessible name on a container.** That is right for a lockup sitting
 * inside a labelled link, and wrong if one is ever used alone — reach for
 * `VolaMark` as a standalone empty-state graphic and it is invisible to a
 * screen reader with no way to override it from the outside. Give it a name on
 * the wrapper, or add a `title` prop here before that use appears.
 *
 * Geometry is lifted verbatim from `assets/brand/logos/source/`, which is the
 * brand kit's source of truth. Each `viewBox` is the artwork's own content box
 * in its own coordinate space, so these crop tight with no padding to fight.
 * **Do not retype these paths** — regenerate them from the source SVGs, or the
 * copy in this file becomes a second source of truth that silently drifts.
 * That is exactly how `apps/web` ended up shipping a hand-drawn stand-in
 * checkmark and the string "VOLA" long after the real artwork existed.
 */

import type { CSSProperties } from "react";

type SvgProps = { className?: string; style?: CSSProperties };

/** The faceted tick. Content box 4645x4185 in the source's coordinate space. */
export function VolaMark({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="1911 2141 4645 4185"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path fill="#D0E950" d="M1911 3801l1625 1128 3020 -2788 -2933 4185 -1712 -2525z" />
      <path fill="#9CC740" d="M3008 5418l401 -577 -1498 -1040 1097 1617z" />
      <path fill="#71912F" d="M3536 4929l-528 489 367 -600 161 111z" />
    </svg>
  );
}

/**
 * The four letterforms. Content box 14030x1759.
 *
 * `fillRule="nonzero"` matches the source, which sets `evenodd` at its root and
 * overrides it to `nonzero` on the letter class. It is fidelity, not necessity:
 * the O's two subpaths wind in opposite directions, so `evenodd` renders it
 * identically. (An earlier version of this comment claimed the counter would
 * fill without it. It would not — the two rules agree on this artwork.)
 */
export function VolaWordmark({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="3568 12529 14030 1759"
      className={className}
      style={style}
      fill="currentColor"
      fillRule="nonzero"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3926 12529c16,0 29,3 36,8 8,5 15,13 21,25l737 1351c5,12 15,18 30,18l12 0c12,0 21,-6 28,-18l726 -1351c10,-22 29,-33 58,-33l329 0c20,0 32,6 36,17 4,11 2,24 -6,41l-824 1510c-42,77 -83,128 -123,153 -40,25 -87,38 -141,38l-146 0c-65,0 -119,-13 -162,-38 -42,-25 -85,-76 -126,-153l-834 -1510c-9,-17 -11,-30 -7,-41 4,-11 17,-17 39,-17l317 0z" />
      <path d="M9154 12529c128,0 236,12 326,37 89,24 162,63 218,115 56,53 97,121 122,205 25,84 38,186 38,306l0 433c0,120 -13,223 -38,307 -25,85 -66,153 -122,206 -56,53 -129,91 -218,115 -90,23 -198,35 -326,35l-776 0c-127,0 -235,-12 -324,-35 -89,-24 -161,-62 -217,-115 -56,-53 -97,-121 -123,-206 -26,-84 -39,-187 -39,-307l0 -433c0,-120 13,-222 39,-306 26,-84 67,-152 123,-205 56,-52 128,-91 217,-115 89,-25 197,-37 324,-37l776 0zm-1095 1068c0,65 6,120 16,164 11,45 29,80 54,106 26,26 59,44 102,55 43,11 97,17 162,17l746 0c66,0 120,-6 162,-17 43,-11 77,-29 102,-55 25,-26 43,-61 54,-106 11,-44 16,-99 16,-164l0 -377c0,-65 -5,-120 -16,-164 -11,-45 -29,-80 -54,-106 -25,-26 -59,-44 -102,-55 -42,-11 -96,-17 -162,-17l-746 0c-65,0 -119,6 -162,17 -43,11 -76,29 -102,55 -25,26 -43,61 -54,106 -10,44 -16,99 -16,164l0 377z" />
      <path d="M12006 12529c37,0 55,19 55,56l0 66 0 508 0 772 720 0 262 0 544 0c37,0 76,25 55,55l-174 246c-21,30 -18,56 -55,56l-370 0 -262 0 -720 0 -384 0 0 -357 0 -772 0 -508 0 -66c0,-37 19,-56 58,-56l271 0z" />
      <path d="M15583 14288c17,0 29,-3 36,-8 8,-5 15,-13 22,-25l736 -1351c5,-12 15,-18 30,-18l13 0c11,0 20,6 27,18l726 1351c10,22 29,33 58,33l329 0c20,0 32,-6 36,-17 5,-11 2,-24 -6,-41l-824 -1510c-42,-77 -83,-128 -123,-153 -40,-25 -87,-38 -141,-38l-145 0c-66,0 -120,13 -162,38 -43,25 -85,76 -127,153l-834 1510c-8,17 -11,30 -6,41 4,11 17,17 39,17l316 0z" />
    </svg>
  );
}

/**
 * The stacked lockup: mark above, wordmark below.
 *
 * **Stacked rather than horizontal, and that is a consequence of dropping the
 * tagline.** The horizontal lockup was tried first and looked wrong: its mark
 * is 3.4x the height of its wordmark, which is balanced in the source artwork
 * only because a line of tagline text sits under the letters and fills the
 * space beside the tick. Remove the tagline — which we do, everywhere — and the
 * proportions are suddenly holding up nothing, so the mark towers over a single
 * line of letters. The stacked arrangement carries the same size relationship
 * without needing the tagline to balance it, because the mark is above the
 * wordmark rather than beside it.
 *
 * Every number is measured off `vola-stacked-color.svg` in its own coordinate
 * space, cropped to the two elements we keep:
 *
 *   wordmark  x 3568..17598 (w 14030)   y 12529..14288 (h 1759)
 *   mark      x 7328..14035 (w  6707)   y  5088..11132 (h 6044)
 *
 * expressed against the wordmark's width, which is what a caller picks. These
 * are the same ratios `apps/mobile`'s `AnimatedSplash` uses for its final
 * frame, deliberately — the two apps assemble the identical lockup.
 */
export function VolaLockup({
  width = 132,
  className,
}: {
  /** The wordmark's width in px. Everything else is derived from it. */
  width?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center ${className ?? ""}`}
    >
      <VolaMark
        style={{
          width: width * (6707 / 14030),
          height: width * (6044 / 14030),
          marginBottom: width * (1397 / 14030),
          // The lockup centres the mark on itself, not on the wordmark — 98.5
          // units right of the wordmark's centre. Under a pixel at these sizes,
          // and kept because reproducing the lockup is the whole job.
          transform: `translateX(${width * (98.5 / 14030)}px)`,
        }}
      />
      <VolaWordmark style={{ width, height: width * (1759 / 14030) }} />
    </span>
  );
}
