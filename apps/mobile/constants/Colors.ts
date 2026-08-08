import * as SecureStore from 'expo-secure-store';

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

  /**
   * The Library tile's "staying put" intent — deliberately achromatic.
   *
   * Not `textMuted`, which is what it used to be. `LibraryTile` recorded that
   * its four intents cleared every check at "worst adjacent pair ΔE 21.7 CVD";
   * running them through `validate_palette.mjs` — the tool that comment tells
   * you to use, and which did not exist when it was written — put
   * defend-versus-hold at **14.7 for a protanope**, where a mid grey and a mid
   * blue converge. This is the same idea a step darker, which separates on
   * lightness instead: worst pair now 19.5.
   */
  tileHold: '#7C8798',

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
  /**
   * **Mono is not a sixth hue — it is a MODE**, and it is the one entry here
   * that changes more than the chrome.
   *
   * Choosing it also turns the whole app greyscale, because a white accent over
   * an otherwise coloured app is not what anybody means by monochrome. That
   * happens through a real greyscale filter on the root view rather than through
   * a second palette (see `lib/palette.ts` for why), so photos, the belt
   * renders, `danger` red and every colour already baked into a `StyleSheet` go
   * with it.
   *
   * The value is a light grey rather than pure white on purpose. White measures
   * marginally better on paper but sits ΔL* 3 from `text` (#F3F6FA), so an
   * accent-coloured action and ordinary body copy become the same brightness and
   * the accent stops signalling anything. This clears `text` by ΔL* 12 while
   * still reading as "the bright one" against everything else on a near-black
   * ground.
   */
  mono: { label: 'Mono', accent: '#C9D2E0', ink: '#C9D2E0', on: '#080B12' },
} as const;

/**
 * Every colour in this file that carries a HUE, restated in grey.
 *
 * ## Why the whole palette and not a filter on the root view
 *
 * React Native 0.76 added a `filter` style with a `grayscale` function, and one
 * of those on the root view is the obvious implementation — it would reach the
 * exercise photography and every hex already frozen into a `StyleSheet`. **It
 * was built that way first, and it does not work on the runtime this app has.**
 * Measured on an iPhone 15 Pro Simulator, Expo Go SDK 57: the filter is a
 * complete no-op, applied to the root or to a single leaf view. RN implements
 * iOS `grayscale` by re-hosting the view in a SwiftUI container
 * (`RCTSwiftUIContainerViewWrapper`), and Expo Go's binary does not carry it, so
 * the property is parsed and silently dropped. Do not reach for it again without
 * a custom dev client to test against.
 *
 * ## Why not a `usePalette()` hook either
 *
 * This app has **794 colour reads across 65 files, and almost all of them sit
 * inside `StyleSheet.create` at module scope** — evaluated once when the module
 * is imported, before any hook has run and before anyone has signed in. A hook
 * would mean moving every stylesheet inside its component: sixty-five files of
 * mechanical churn in the screens where a mistake is a mis-rendered workout, to
 * serve one setting.
 *
 * ## So: the palette itself changes, at module-evaluation time
 *
 * `vola` below resolves to these values instead when mono is on, and it does so
 * *before* any screen's stylesheet is built — ES modules are evaluated
 * depth-first, so every one of those 794 reads gets a grey. Zero call sites
 * change, and nothing can be missed, because there is nothing to remember.
 *
 * The cost, and it is a real one: **the choice is read synchronously, so it
 * takes full effect on the next launch.** The accent itself moves immediately
 * (it is a context value), and everything else follows on relaunch — the picker
 * says so. See `MONO_KEY` for why the flag lives in the keychain rather than in
 * the preferences table with its sibling settings.
 *
 * ## What is in here, and what deliberately is not
 *
 * Only the hues. The greys this palette is otherwise built from — `bg`,
 * `surface`, `line`, `text`, `textMuted` — are already a desaturated blue-grey
 * ramp and read as monochrome; restating them would be churn for a difference
 * nobody can see.
 *
 * Every replacement is chosen for LIGHTNESS separation, because that is the only
 * axis left. The grid ramp and the Library tile intents are the two sets where
 * that matters most — one encodes a quantity, the other four categories — and
 * both are validated by `scripts/validate_palette.mjs` against the same
 * thresholds their coloured originals meet. **Changing a value here without
 * running it is how a ramp gets two steps nobody can tell apart.**
 *
 * The sports are the deliberate exception: they all collapse to one grey. Every
 * site that draws a sport colour draws a per-sport glyph or the sport's name
 * beside it (`components/ui/sport.ts` keeps the two together for exactly this
 * reason), so the hue was redundant encoding — and four greys that clear ΔE 15
 * pairwise *and* 4.5:1 on the card do not exist, so inventing four would be
 * claiming a distinction the eye cannot make.
 */
export const mono = {
  lime: '#E7EBF1',
  green: '#C9D2E0',
  info: '#98A3B5',
  warn: '#B9C2D0',
  danger: '#EAEEF4',
  setDone: '#2B313A',
  gridRest: '#333B48',
  gridLevels: ['#6E7787', '#A7B0BE', '#FFFFFF'] as const,
  tileHold: '#7E8899',
  accent: '#C9D2E0',
  accentInk: '#C9D2E0',
  accentOn: '#080B12',
};

/** One grey for every discipline — see the note above on why. */
export const monoSport = '#98A3B5';

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
 * The belt, as a colour — **for surfaces that are about one specific belt.**
 *
 * A belt is the one thing on the You screen that is genuinely personal, so the
 * masthead takes its accent from the athlete's rank rather than from the app.
 * The Plan tab's belt-syllabus cards are the second such surface, and the only
 * other one: each card is *about* a belt, so its edge is that belt.
 *
 * This said "the rank card and nothing else" until that second card existed.
 * The line it was drawing is still the right one and is unchanged — what is
 * banned is belt-coloured *chrome*, a tab bar or a background that inherits
 * the athlete's rank, because that means five validated accent sets and three
 * of the five do not survive contact with a dark UI. A single element naming
 * a single belt is the sanctioned use, not the exception to it.
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

/**
 * Where the monochrome flag lives, and why it is not in `prefs`.
 *
 * Every other device preference is a row in the SQLite `prefs` table, which is
 * the right home for them and the wrong one for this: opening that database is
 * asynchronous, and this answer is needed during module evaluation, before the
 * first stylesheet is built. `expo-secure-store` is the one store in this app
 * with a **synchronous** read, which is the entire reason it is used here — not
 * because a colour preference is a secret.
 *
 * Written alongside the ordinary `PREF_ACCENT` row rather than instead of it, so
 * the accent picker keeps one source of truth for *which* accent is chosen and
 * this is only a cache of the one bit that has to be readable early.
 */
export const MONO_KEY = 'vola.mono';

/**
 * Is this launch monochrome?
 *
 * Wrapped in a try/catch that swallows everything, because it runs at module
 * scope: an unavailable keychain here would take the colour palette down with
 * it, and every screen in the app with it. Colour is the safe default.
 */
function monoAtLaunch(): boolean {
  try {
    return SecureStore.getItem(MONO_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The palette this launch is actually using.
 *
 * Resolved once, here, before anything imports it — see the note on {@link mono}
 * for why that is the mechanism. Consumers see one object either way and need to
 * know nothing about the mode.
 */
export const isMono = monoAtLaunch();

export const vola = isMono ? { ...palette, ...mono } : palette;

/**
 * The legacy `Colors.light`/`Colors.dark` shape, kept for the Themed components.
 *
 * `tint` reads `vola` rather than `palette`, and is declared after it for that
 * reason: the literal was the one place in this file that could hand out a lime
 * after mono had swapped everything else. Nothing consumes it today, which is
 * exactly why it was worth fixing rather than leaving as a trap.
 */
const scheme = {
  text: palette.text,
  background: palette.bg,
  tint: vola.lime,
  tabIconDefault: palette.textDim,
  tabIconSelected: vola.lime,
};

/**
 * A discipline's colour, mode-aware.
 *
 * `sportColors` above stays the literal map — the palette validator parses it,
 * and a mode-dependent export would make it unparseable — so the swap happens
 * here, where `components/ui/sport.ts` already reads it.
 */
export const activeSportColors: Record<SportKey, string> = isMono
  ? { strength: monoSport, bjj: monoSport, running: monoSport, nutrition: monoSport }
  : sportColors;

export default {
  light: scheme,
  dark: scheme,
};
