/**
 * The VOLA mobile palette.
 *
 * The phone is **dark-first and dark-only** — it's used in a gym and at
 * night, and a training app that flashes white at 6am is a training app you
 * stop opening. The web app is the opposite (light by default, dark opt-in)
 * because it's the desk surface; see apps/web/src/app/globals.css.
 *
 * Values match web's dark tokens exactly, so the two read as one product
 * rather than two apps that happen to share a logo.
 *
 * `light` and `dark` are intentionally identical: Expo's useColorScheme
 * still resolves per the OS, and rather than fight that everywhere we make
 * both answers the same one. That keeps the existing Themed components
 * working untouched.
 */
const palette = {
  // Ground up — each surface is a step nearer the viewer, not a border away.
  bg: '#080B12',
  surface: '#10151F',
  surfaceRaised: '#171E2B',
  surfaceHover: '#1D2534',

  line: '#222B3A',
  lineSoft: '#1A2230',

  text: '#F3F6FA',
  textMuted: '#949FB3',
  textDim: '#667085',

  lime: '#B8FF2C',

  /**
   * The consistency grid's ramp, and the one place in this palette whose
   * values are *tuned against* `surface` rather than independent of it.
   *
   * They are not lime at an opacity — solving per channel gives inconsistent
   * alphas — because they were picked by running the ramp through a contrast
   * and colour-vision validator over this card. Three steps, not four: a
   * four-step ramp put its top two at ΔE 13.5 (below where full-colour vision
   * separates them) and its bottom at 2.05:1 (invisible in daylight). These
   * clear both — ΔE 18.6+, 3.58 / 8.05 / 15.12 against the card.
   *
   * `gridRest` is the untrained day. At the old `lineSoft` it was 1.14:1 and
   * the grid read as scattered dots rather than a calendar, which is a
   * weaker standard than the one the lit steps were held to.
   *
   * **If `surface` changes, re-run the validator.** Nothing else will catch it.
   */
  /**
   * A logged set's row. Lime at 15% over `surface`, solved per channel and
   * stored opaque — the house convention in this file, so the row does not
   * composite differently depending on what is behind it.
   *
   * 15% specifically. Measured against `surface` (#10151F) and the inks that
   * sit on it: the tint is 1.47:1 against the untouched row, which is what
   * makes "this one is done" readable at a glance across a column of them,
   * and `text` stays at 11.5:1 with `textMuted` at 4.67:1 — still clear of
   * 4.5 for body text. Going to 20% reads better as a band but drops
   * `textMuted` to 3.98:1, which fails; going to 10% keeps every ink happy
   * but the tint falls to 1.26:1 and stops being obvious in daylight, which
   * is the whole point of the request.
   *
   * `textDim` measures 2.51:1 here and is therefore NOT used on a done row —
   * the set ordinal steps up to `textMuted`. Same rule as everywhere else in
   * this file: if `surface` changes, recompute.
   */
  setDone: '#293821',

  gridRest: '#2A3446',
  gridLevels: ['#567826', '#87BC28', '#B8FF2C'] as const,
  green: '#42F58D',
  navy: '#0B1220',

  /**
   * The third categorical hue, for Library tiles. Lives here rather than in the
   * component because a colour outside this file is a colour nobody re-validates.
   * Validated against `surface` with the other two: worst adjacent pair ΔE 21.7
   * (CVD) / 35.6 (normal). Adding a fourth needs `scripts/validate_palette.mjs`
   * — violet measured ΔE 2.0 for a deuteranope against this blue. That warning
   * is why `accent` is #7A50EC and not the brighter violet it was drawn as:
   * the pinker candidates land at ΔE 14.9 and 14.3 against this same blue.
   */
  info: '#6BB6FF',

  warn: '#FFB020',
  danger: '#FF6B6B',

  /**
   * The default accent. **Read `accents` below before using this directly** —
   * the accent is a user preference, and this is only the value someone gets
   * before they have expressed one.
   */
  accent: '#B8FF2C',
  accentInk: '#B8FF2C',
  accentOn: '#080B12',
};

/**
 * The accent is a **setting**, not a constant.
 *
 * The rule the rest of the palette follows, and it is what makes a swappable
 * accent safe: **the accent is identity and interaction; everything that
 * encodes a reading stays fixed.** Pills, active tabs, primary buttons and
 * links take the accent. The consistency grid, the completed-set tint, the
 * sync ticks, `warn` and `danger` do not — those are measurements and states,
 * and a measurement whose colour depends on a preference is a measurement
 * nobody can learn to read.
 *
 * Each theme carries three values because one is never enough:
 *
 * - `accent` — the fill. Must clear 3:1 on `surface` and `surfaceRaised`
 *   (WCAG 1.4.11: it is a graphic that carries meaning).
 * - `ink` — the accent as *text* on a dark ground. Usually the same value;
 *   purple is the exception, because at 3.64:1 the fill is fine as a shape and
 *   fails as type, so it takes a lighter step.
 * - `on` — what can be written on the fill. Must clear 4.5:1, because the
 *   things written on an accent are small: "1M", "Log", a tab label.
 *
 * Every one of these is enforced by `scripts/validate_palette.mjs`, which runs
 * first in `pnpm run verify`. **Adding a theme means adding it there too** —
 * or rather, it means nothing, because the validator reads this object and will
 * fail on a new entry that does not measure up.
 *
 * ### Why these six, and not the two that were asked for and dropped
 *
 * Legibility was never the constraint — every candidate cleared contrast. The
 * constraint is that this palette already spends hues on *meaning*:
 *
 * - **Pink is out.** ΔE 3.6 from `danger` at worst. A pink accent and a red
 *   destructive action are the same colour to a protanope.
 * - **Teal is out**, and it was mine rather than anyone's request — it
 *   measured ΔE 7.9 from `info` under tritanopia, where teal and blue
 *   converge, and Library tiles carry `info` as a category on the same screen
 *   as accent-coloured chrome.
 * - **Orange is in, with a caveat worth knowing.** It sits ΔE 5.8 from
 *   `danger`, and a gamut search found *zero* oranges clearing 15 against the
 *   current coral red. It ships anyway because the two never meet as peers:
 *   `danger` is a filled surface in exactly one component
 *   (`SwipeToDelete`), where the meaning is carried by position and a trash
 *   icon behind a row you are actively dragging, and everywhere else it is
 *   text. Retuning `danger` to a truer red (#E5322F or deeper) would take
 *   orange past 15 and make destructive actions read more urgently — a good
 *   change, and a separate one.
 * - **Green and yellow sit ΔE 2.3–7.5 from `warn`.** Recorded rather than
 *   fixed: green-accent-with-amber-warnings is what this app already ships,
 *   and `warn` only ever appears as a line of text next to an explanation.
 */
export const accents = {
  green: { label: 'Green', accent: '#B8FF2C', ink: '#B8FF2C', on: '#080B12' },
  yellow: { label: 'Yellow', accent: '#FFD400', ink: '#FFD400', on: '#080B12' },
  blue: { label: 'Blue', accent: '#4C7DF0', ink: '#4C7DF0', on: '#080B12' },
  purple: { label: 'Purple', accent: '#7A50EC', ink: '#A78BFA', on: '#FFFFFF' },
  orange: { label: 'Orange', accent: '#FF8A3D', ink: '#FF8A3D', on: '#080B12' },
} as const;

/**
 * A discipline's colour — categorical, and **fixed regardless of the accent**.
 *
 * Same rule as the grid and the completed-set tint: the accent is chrome and
 * moves with a preference, but a sport is a *category*, and a category whose
 * colour depends on a setting is one nobody can learn. A Recent list mixes
 * disciplines in one column, which is the whole reason these need to be
 * distinguishable from each other — unlike `beltAccent`, where an athlete has
 * exactly one belt and no two ever appear together.
 *
 * Validated pairwise under simulated colour blindness by
 * `scripts/validate_palette.mjs`. That check is the point of the set: four
 * hues that separate cleanly for you can collapse to two for a deuteranope,
 * and a mat day then looks like a lifting day in the one view meant to tell
 * them apart.
 *
 * The first attempt at this set was picked by eye and failed hard: BJJ's light
 * purple and running's light blue measured **ΔE 4.7 for a deuteranope** while
 * looking 21.9 apart to me. Purple-versus-blue is the classic red-green
 * collapse, and a mat day would have been indistinguishable from a run in the
 * one view meant to separate them. These four came out of a search that
 * maximises the *worst* pair across all three CVD types; the tightest is now
 * strength/running at 16.4.
 *
 * A consequence worth naming rather than discovering: on the purple theme, the
 * BJJ colour and the accent sit near each other. That is harmless — one is a
 * label, the other is a button — and it is the price of keeping categories
 * stable while chrome moves.
 */
export const sportColors = {
  strength: '#B8FF2C',
  bjj: '#B06BFF',
  running: '#7FD4FF',
  nutrition: '#FF6B35',
} as const;

export type SportKey = keyof typeof sportColors;

export type AccentName = keyof typeof accents;
export type Accent = (typeof accents)[AccentName];

/** What someone gets before they have chosen — the brand's own hue. */
export const DEFAULT_ACCENT: AccentName = 'green';

/**
 * The belt, as a colour — **for the rank card and nothing else.**
 *
 * A belt is the one thing on the You screen that is genuinely personal, so the
 * masthead takes its accent from the athlete's rank rather than from the app.
 * It stops there on purpose: a belt-coloured tab bar means five validated
 * accent sets, and three of the five do not survive contact with a dark UI.
 *
 * **These are not the belt's own colours.** `components/Belt.tsx` draws the
 * real ones — #1B4CC4 blue, #6A2D9B purple, #5C3A21 brown — and every one of
 * them measures under 3:1 against this card (2.50, 2.14, 1.81; black is
 * 1.05:1, i.e. invisible). A belt is a physical object seen in daylight; an
 * accent is a signal on a near-black screen. These are the legible reading of
 * each, all clearing 3:1 on both `surface` and `surfaceRaised`.
 *
 * Two are interpretations rather than translations, and both are judgement
 * calls worth knowing about:
 *
 * - **Black has no colour at all**, so it takes the red of the belt's own bar —
 *   and it is a *vivid* red rather than a soft one for a measured reason. The
 *   first attempt, a coral #E0405E, sat ΔE 8.0 from `danger` under tritanopia,
 *   where reds converge: a black belt's masthead would have been the same
 *   colour as an error message. Searching the red gamut under every constraint
 *   at once turned up 1099 admissible colours, and the most belt-like of them
 *   is this one — ΔE 15.7 from `danger`, and closer to a real belt's bar than
 *   the coral was anyway.
 * - **White is nearly body-text brightness** (12:1), which is as close as a
 *   white belt can get without inventing a colour it does not have. It is the
 *   one belt whose card leans on the belt render rather than the accent.
 */
export const beltAccent = {
  white: '#C9D2E0',
  blue: '#4C7DF0',
  purple: '#7A50EC',
  brown: '#C08457',
  black: '#DF0010',
} as const;

/**
 * What can be written *on* each belt accent.
 *
 * Purple and the black-belt red take white text (5.02:1 and 5.07:1). White,
 * blue and brown are light enough that white on them lands between 1.5 and
 * 3.8:1 — under AA for anything small — so they take the near-black ground,
 * which clears comfortably on all three.
 */
export const beltAccentOn = {
  white: '#080B12',
  blue: '#080B12',
  purple: '#FFFFFF',
  brown: '#080B12',
  black: '#FFFFFF',
} as const;

const scheme = {
  text: palette.text,
  background: palette.bg,
  tint: palette.lime,
  tabIconDefault: palette.textDim,
  tabIconSelected: palette.lime,
};

export const vola = palette;

export default {
  light: scheme,
  dark: scheme,
};
