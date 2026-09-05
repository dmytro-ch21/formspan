import type { TextStyle } from 'react-native';

/**
 * The VOLA mobile type scale.
 *
 * Sibling to `Colors.ts` and `Spacing.ts` — same discipline, but there was
 * nothing to reconcile here: **no type scale existed anywhere in this app
 * before N508.** `assets/brand/design-tokens.json` never declared one, so
 * this file is authored from scratch, off measured real usage rather than
 * an existing declaration.
 *
 * N508's audit measured 27 distinct `fontSize` values across 1,256 sites in
 * 143 files, with 11/12/13/14/15/16 all in heavy simultaneous use — a
 * continuous 1pt-stepped band, not a scale, and direct evidence of nudging
 * without a vocabulary to reach for (`fontSize: 12.5` existed at one site).
 * Re-measured on just the six screens this ticket converts
 * (`components/ui/Section.tsx`, `components/ui/Stat.tsx`,
 * `components/ScreenHeader.tsx`, `(tabs)/workouts.tsx`, `(tabs)/progress.tsx`,
 * `running/[id].tsx`, `bjj/session/[id].tsx`, `session/[id].tsx`):
 *
 *     15   21 sites   13   17 sites   12   17 sites   14   12 sites
 *     16    8 sites   17    6 sites   11    5 sites   10    3 sites
 *     18    2 sites    9    1 site    28    1 site    26    1 site
 *     22    1 site     20   1 site
 *
 * ## Seven roles, not the six the ticket sketched
 *
 * The ticket's own sketch bundled "eyebrow/caption" as one ~11pt role. Real
 * usage argues against that: `Section.tsx`'s eyebrow (11/700/tracking 1.2,
 * uppercase section labels) and a plain small caption (12, not uppercase,
 * no tracking — deltas, secondary meta) read differently and are used for
 * different things, and folding them into one role would have meant picking
 * a weight/tracking that fits neither. So `eyebrow` and `caption` stay
 * distinct, alongside `meta` (13, the OTHER heavily-used small size,
 * distinct from `body`'s 14) — five core reading roles plus `title` and
 * `display` for chrome and hero figures. Weights are NOT invented here:
 * 400/600/700/800 were already the app's convention (per the ticket's own
 * note) and this scale only assigns them to roles, it doesn't add a fifth.
 *
 * ## Fixing the one disagreement the ticket named directly
 *
 * `Section.tsx`'s eyebrow was `{11, 700, tracking 1.2}`; `Stat.tsx`'s was
 * `{11, 600, tracking 0.8}` — same role (an uppercase label over a group),
 * different everything else. `Section.tsx`'s wins outright — its own
 * comment already describes it as "the house style" that `TrainingSummary`,
 * `You` and the old Today screen each converged on independently before it
 * existed — and `Stat.tsx` now reads `Typography.eyebrow` instead of a
 * second literal.
 *
 * `ScreenHeader.tsx`'s screen-name title (`{15, 700, uppercase, tracking 1}`)
 * is a THIRD, visually similar treatment, and it is deliberately NOT folded
 * into `eyebrow`: it is a per-screen identity mark (the one thing on every
 * tab that says "you are here"), not a label over a group of cards, and it
 * sits at 15pt, not 11. It takes `emphasis`'s fontSize/lineHeight (the
 * nearest role) and layers its own uppercase/tracking/weight on top, spelled
 * out at that call site — see the comment there.
 *
 * Each role pairs `fontSize` with `lineHeight`, `letterSpacing` and
 * `fontWeight`, per the ticket's own requirement — a role is the whole
 * bundle, not just a number.
 */
export const Typography = {
  /**
   * 11pt. Uppercase, tracked labels over a group — a section header, a
   * card's category tag. NOT for reading text; `textTransform: 'uppercase'`
   * belongs at the call site alongside this (kept out of the role itself,
   * since a handful of eyebrow-styled call sites render already-uppercase
   * strings and doubling the transform is harmless but redundant to state
   * twice).
   */
  eyebrow: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    fontWeight: '700',
  } satisfies TextStyle,

  /**
   * 12pt. Small reading text that is NOT a label — deltas, secondary meta,
   * a stat's unit suffix. Distinct from `eyebrow`: no tracking, no forced
   * case.
   */
  caption: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.2,
    fontWeight: '600',
  } satisfies TextStyle,

  /**
   * 13pt. Row meta, timestamps, secondary descriptors — the other heavily
   * used small size, one step up from `caption` and distinct from `body`.
   */
  meta: {
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0,
    fontWeight: '400',
  } satisfies TextStyle,

  /** 14pt. Default reading text — descriptions, body copy. */
  body: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0,
    fontWeight: '400',
  } satisfies TextStyle,

  /**
   * 15pt. Emphasis — row titles, card headers, primary labels, button text.
   * The single most common size measured across the converted screens,
   * which tracks: it is the size a card's own title renders at, and cards
   * are what these screens are mostly made of.
   */
  emphasis: {
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
    fontWeight: '600',
  } satisfies TextStyle,

  /** 20pt. A screen or section headline. */
  title: {
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.2,
    fontWeight: '800',
  } satisfies TextStyle,

  /** 28pt. A hero figure — a large stat number, a screen's single big total. */
  display: {
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.3,
    fontWeight: '800',
  } satisfies TextStyle,
} as const;
