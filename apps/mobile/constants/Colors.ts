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
 * The metals, and their monochrome reading.
 *
 * A personal-record medal is the one badge in the app whose whole point is that
 * it looks like a medal, so it was drawn in real gold and silver and — being
 * outside `palette` — sailed straight through the mono swap. In a black-and-white
 * app a gold disc is the only warm thing on the screen, which is exactly the
 * "everything else is silver except this" the mode exists to remove.
 *
 * The two tiers still have to separate, because they mean different things: gold
 * is a record set in the last 30 days, silver a standing one. In mono that
 * becomes bright versus mid, ΔE ~24 apart — and the gold tier's star is still
 * there underneath it, which is why `Medal` could survive greyscale even before
 * this existed.
 */
export const medalFace = { gold: '#C9A227', silver: '#8A94A6' } as const;
export const medalRim = { gold: '#F2D98A', silver: '#C3CAD6' } as const;

export const monoMedalFace = { gold: '#D7DEE8', silver: '#79839A' } as const;
export const monoMedalRim = { gold: '#F3F6FA', silver: '#A7B0BE' } as const;

/**
 * The belt accents in monochrome — a lightness ramp, lightest belt to darkest.
 *
 * Intuitive rather than clever: a white belt's card is the pale one and a black
 * belt's is the dark one, matching the belt render beside it. Encoding *rank* as
 * brightness was the alternative and it inverts that, which would put a bright
 * edge on a card showing a dark belt.
 *
 * Unlike the accent set these do not need to separate pairwise — an athlete has
 * one belt — but the Plan tab's syllabus cards show several at once, so a
 * readable ramp is worth having anyway. Each still clears 3:1, which is the
 * promise the coloured set makes and the validator checks.
 */
export const monoBeltAccent = {
  white: '#F3F6FA',
  blue: '#C2CAD8',
  purple: '#9AA4B5',
  brown: '#7A8496',
  black: '#646E82',
} as const;

/** The darkest step is too dark for near-black ink; everything above it is not. */
export const monoBeltAccentOn = {
  white: '#080B12',
  blue: '#080B12',
  purple: '#080B12',
  brown: '#080B12',
  black: '#FFFFFF',
} as const;

/**
 * The belt as a physical object, as it really is.
 *
 * Moved out of `components/Belt.tsx` so the monochrome twin below can sit beside
 * it — they were literals in the component, which is precisely why a
 * black-and-white app still had a blue belt in it.
 */
export const strap = {
  // Not pure white: #FFF on a dark ground glares, and a real belt is closer to
  // unbleached cotton anyway.
  white: '#EDEAE3',
  blue: '#1B4CC4',
  purple: '#6A2D9B',
  brown: '#5C3A21',
  // Not pure black either — it would disappear into `vola.bg`. This reads as
  // black beside the other straps while staying visible on its own.
  black: '#1A1A1A',
} as const;

/**
 * The rank bar. Red on a black belt, black on everything else — the actual
 * construction, not a stylistic choice.
 */
export const rankBar = {
  white: '#1A1A1A',
  blue: '#1A1A1A',
  purple: '#1A1A1A',
  brown: '#1A1A1A',
  black: '#B01B2E',
} as const;

/**
 * The belt as a physical object, in monochrome.
 *
 * `components/Belt.tsx` draws a real strap, and a real strap is dyed cotton —
 * so unlike everything else in this file these values are a *picture*, not a
 * signal. In mono they become the greyscale reading of that picture: the
 * lightness order of the real belts, which is already the order the ranks run
 * in, so the drawing still reads as a progression rather than as five
 * identical straps.
 *
 * Black stays nearly black and white stays nearly white — those two are already
 * achromatic and there is nothing to convert. The middle three are what change.
 */
export const monoStrap = {
  white: '#EDEAE3',
  blue: '#6E7787',
  purple: '#565E6C',
  brown: '#3E444F',
  black: '#1A1A1A',
} as const;

/** The rank bar's red has no greyscale equivalent that is not just "a bar". */
export const monoRankBar = '#8A94A6';

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

/**
 * The monogram discs in the feed — one per person, keyed on their handle.
 *
 * HERE rather than in `lib/monogram.ts`, and the reason is this file's own
 * history. `validate_palette.mjs` parses these blocks by name and is the first
 * link in `verify`; the metals comment above records a colour defined outside
 * the palette sailing "straight through the mono swap" and becoming the only
 * warm thing on a greyscale screen. A private eight-colour palette in a lib
 * module would have repeated both mistakes at once — ungated AND unswapped, on
 * the most prominent element of every post in the feed.
 *
 * Eight, because the colour is what makes a feed scannable before it is read,
 * and a person's is a pure function of their handle — so these need to be
 * distinguishable from EACH OTHER under colour-vision deficiency, not merely
 * legible against the ground. The validator measures exactly that; do not add
 * or reorder an entry without running it.
 *
 * They are spaced by LIGHTNESS as much as by hue, and that is the whole reason
 * they clear the gate. Colour-vision deficiency collapses hue toward a single
 * axis, so a set of eight equally-dark colours — the first attempt here — fails
 * 16 of its 28 pairs under simulation while looking perfectly varied to me.
 * Lightness survives every CVD type, so it is what carries the separation.
 *
 * Which is why each disc carries its OWN ink (`monogramInk`) rather than white
 * throughout: forcing white on all eight is what pins them all into the same
 * dark band in the first place.
 */
export const monogramColors = {
  night: '#17222F',
  ocean: '#2B7396',
  clay: '#B0783C',
  mint: '#8FBF88',
  mist: '#EEF4FA',
} as const;

/**
 * What is written on each disc — light discs take dark initials.
 *
 * Same shape as `beltAccent`/`beltAccentOn` above, for the same reason: a fill
 * and the thing written on it are two decisions, and pretending one colour of
 * ink serves every fill is what flattens a palette.
 */
export const monogramInk = {
  night: '#FFFFFF',
  ocean: '#FFFFFF',
  clay: '#1E1408',
  mint: '#12200E',
  mist: '#16202B',
} as const;

export type MonogramColor = keyof typeof monogramColors;

/**
 * The daily-tracker fills — water's cups, coffee's cups, and whatever N78's
 * athlete picks.
 *
 * **This is a PICKER's palette, not a set of constants**, and that is the whole
 * reason it is a named map rather than a hex on each tracker row. An athlete
 * authoring their own tracker (N78) chooses from these keys; the database
 * stores the key; `scripts/validate_palette.mjs` measures every entry. A free
 * colour picker cannot work here — the athlete would be choosing at a moment
 * when nothing can run a contrast check, and the first illegible fill would ship
 * to their own phone with no gate in the way.
 *
 * ## Why water is a deep teal and not the vivid cyan it wants to be
 *
 * Measured, not chosen. The obvious candidates — `#2ED9E0`, `#40E0D0`,
 * `#7FE9F0` — are beautiful on the card and land at **ΔE 8.0 / 9.5 / 10.6
 * against `info` under simulated tritanopia**, which is where the blue axis
 * collapses and the two become one hue separated only by lightness. `info` is
 * the categorical blue this app already uses, so the pair has to clear ΔE 15
 * like every other pair in that file. Nothing at that saturation does: the
 * separation has to come from LIGHTNESS, which means going darker. `#408D96`
 * measures **ΔE 16.1 (tritanopia)** and 4.76:1 on `surface` / 4.35:1 on
 * `raised`, comfortably past the 3:1 a meaningful fill needs.
 *
 * ## `coffee` is here before anything uses it, on purpose
 *
 * N77 is coffee, and the expensive way for that ticket to go is to discover
 * halfway through that its brown cannot clear ΔE 15 against this teal while two
 * cards sit on one screen. It can — **ΔE 23.4 under protanopia** — and it is
 * recorded here so that PR is a seed row rather than a colour search. Nothing
 * renders it yet.
 *
 * ## Adding a fourth is arithmetic, not taste
 *
 * Every pair in here is checked pairwise under three CVD simulations, and the
 * space runs out fast — the same wall `monoSport` documents, where four
 * distinguishable greys do not exist. A candidate that fails is not a colour to
 * fudge the threshold for: a tracker card carries its NAME and its ICON, so
 * colour is redundant encoding, and the honest answer at that point is fewer
 * colours rather than a lowered gate.
 */
/*
 * ## The three N78 added, and why they are those three (measured 2026-08-20)
 *
 * The picker an athlete authoring a tracker chooses from is this object, so its
 * size is a product decision made by arithmetic. Searched over an 8-bit sRGB
 * grid under every constraint below at once — 4.5:1 on `surface`, 3:1 on
 * `raised`, 4.5:1 for the ground written on the fill, ΔE ≥ 15 from `info`, and
 * ΔE ≥ 15 pairwise from every other entry, all four under normal vision plus
 * three CVD simulations. What the search found:
 *
 * - **Six is the ceiling.** A greedy maximum-spread search seeded with water
 *   and coffee stops at six, and the best seventh sits at ΔE 13.9.
 * - **Six has no margin.** The best feasible six measured **ΔE 15.12** against
 *   a floor of 15, and two of its four families had pools of 2 and 4 admissible
 *   grid points. A palette that clears the gate by 0.12 is not a design, it is
 *   a coincidence, and the next edit anywhere near it breaks the build.
 * - **Five has margin.** These five measure **ΔE 16.58** at the closest pair
 *   (water/violet), with every other pair 20.3 or better.
 *
 * So five. The doc above already says the honest answer is fewer colours rather
 * than a lowered gate; this is that sentence being followed rather than quoted.
 *
 * Per colour, on `surface` / `raised` / ink-on-fill / vs `info`:
 *
 *     water   #408D96   4.76  4.35   5.13  16.14
 *     coffee  #C08457   5.81  5.31   6.26  43.20
 *     mint    #B0FCDC  15.49 14.16  16.69  15.21
 *     amber   #F2D95E  12.93 11.82  13.93  41.68
 *     violet  #806CEC   4.59  4.20   4.94  15.57
 *
 * **`mint` is pale because a deeper one collides with water.** Six deeper mints
 * were measured and every one fell under ΔE 15 against the teal — they are
 * neighbours on the hue circle, so the separation has to come from lightness,
 * exactly as it did for water against `info`. Same wall, one hue over.
 *
 * The KEYS are provenance and the LABELS are colour names: `water` and `coffee`
 * were named after the presets that first used them and cannot be renamed
 * without rewriting stored rows, so the picker calls them Teal and Clay. See
 * `TRACKER_COLOR_LABELS`.
 */
export const trackerColors = {
  water: '#408D96',
  coffee: '#C08457',
  mint: '#B0FCDC',
  amber: '#F2D95E',
  violet: '#806CEC',
} as const;

/**
 * The monochrome twin.
 *
 * **Five greys, and unlike the colours they are NOT pairwise separable — that
 * claim is dropped here deliberately rather than fudged with a lowered
 * threshold.** It is arithmetic, not a failure of imagination, and it is the
 * same wall `MONO_TILES` documents in `validate_palette.mjs`: 4.5:1 on
 * `surface` puts the floor at `#757f96`, the ceiling is white, and the whole
 * admissible band spans ΔE 34. Four gaps of 15 do not fit in 34. The best
 * available spacing for five values is **ΔE 6.58 between adjacent steps**, with
 * **26.18 between the extremes**.
 *
 * What is still asserted, and what the gate checks: every grey clears all three
 * contrast floors, and the set keeps at least two genuinely distinguishable
 * steps, so a later edit cannot collapse monochrome mode to one flat grey.
 *
 * That is defensible here for the reason the doc above already gives — **a
 * tracker card carries its NAME and its ICON**, so the fill is redundant
 * encoding rather than the only channel. It is not defensible for the coloured
 * set, where the pairwise check stays at 15.
 *
 *     water   #D7DEE8  13.49:1
 *     mint    #BBC3D1  10.30:1
 *     amber   #A3ABBD   7.93:1
 *     violet  #8C96AA   6.14:1
 *     coffee  #79839A   4.81:1
 *
 * water's and coffee's values are N76's, unchanged: they were measured then and
 * moving them would be churn on a claim that still holds.
 */
export const monoTrackerColors = {
  water: '#D7DEE8',
  mint: '#BBC3D1',
  amber: '#A3ABBD',
  violet: '#8C96AA',
  coffee: '#79839A',
} as const;

/**
 * What the picker CALLS each colour.
 *
 * Separate from the keys because the keys are provenance — `water` and `coffee`
 * are named after the presets that first used them, and renaming a key means
 * rewriting every stored `color_key`. An athlete choosing a colour for their
 * creatine tracker should not be offered "Water"; they are offered "Teal".
 *
 * Ordered as the picker renders them: the two that already existed first, so
 * the swatch row does not reshuffle for anyone who had a preference.
 */
export const TRACKER_COLOR_LABELS: Record<TrackerColor, string> = {
  water: 'Teal',
  coffee: 'Clay',
  mint: 'Mint',
  amber: 'Amber',
  violet: 'Violet',
};

export type TrackerColor = keyof typeof trackerColors;

/**
 * The four macros, as four colours — and the two of them that could not be the
 * ones the design asked for.
 *
 * N106's reference draws protein, fat, carbs and fibre as a row of tiles, a
 * four-segment donut and a colour-dotted legend, so this is a genuine
 * categorical set: four hues side by side, carrying a reading. Same rule as
 * `sportColors` — **fixed regardless of the accent**, because a measurement
 * whose colour depends on a preference is a measurement nobody can learn to
 * read.
 *
 * ## Two of the reference's four are exact and two could not be
 *
 * The reference's own values were sampled out of the supplied PNG — protein
 * `#5C9BFA`, fat `#FBC410`, carbs `#B8FF2C`, fibre `#B16AF6` — and run through
 * `scripts/validate_palette.mjs`'s CIEDE2000 + CVD maths. **Two of the six
 * pairs collapse**, both under deuteranopia:
 *
 *  - **protein blue vs fibre violet: ΔE 8.50.** Predicted, in this very file:
 *    `info`'s note already records "violet measured ΔE 2.0 for a deuteranope
 *    against this blue".
 *  - **fat amber vs carbs lime: ΔE 9.78.** Yellow and yellow-green are the same
 *    colour without the red-green axis.
 *
 * So the palette is the NEAREST set to the reference that clears the gate, and
 * it sits on a real four-colour frontier — the binding pairs measure 15.56,
 * 15.7 and 15.9, and every prettier variant tried (a brighter gold, an orange
 * fat, a bluer violet, a lighter orchid) fails at least one of them.
 *
 *  - `protein` — **exactly the reference.**
 *  - `carbs` — **exactly the reference**, which is the brand lime.
 *  - `fat` — the reference's amber, deepened. Separation from lime has to come
 *    from LIGHTNESS once the hue axis is gone, which is the same argument
 *    `trackerColors.water` records against `info`.
 *  - `fibre` — the reference's violet, rotated toward orchid until it clears
 *    the blue.
 *
 * Worst pair **ΔE 15.56**; 5.05:1 on `surface` and 4.62:1 on `surfaceRaised` at
 * the dimmest, so all four are legible as small text and as fills.
 *
 * **A fifth macro is not free space.** Four hues pairwise at ΔE 15 under three
 * simulations is already the frontier; adding one is a colour search, not a
 * line in this object, and the count asserted in `validate_palette.mjs` is what
 * makes you do it.
 */
export const macroColors = {
  protein: '#5C9BFA',
  fat: '#CAA021',
  carbs: '#B8FF2C',
  fibre: '#D657AA',
} as const;

/**
 * The monochrome twin, and it **deliberately does not meet the ΔE 15 floor.**
 *
 * Lightness is the only axis left, and four achromatic values cannot be 15
 * apart while all four also clear 4.5:1 — measured by search over the grey
 * ramp, the ceiling is **ΔE 11.24**, at which point the darkest step is already
 * at 4.52:1 on `surfaceRaised`. That is the same wall the mono library tiles
 * hit and record, and the same one `monoSport` documents by giving every sport
 * one grey rather than four bad ones.
 *
 * Four steps rather than one grey, because unlike a sport chip a **donut
 * segment carries no label** — one grey there is a ring with nothing in it. So
 * the honest trade in mono is an ordered ramp that is reliably *ordered* even
 * where two adjacent steps are not reliably *told apart*, with the legend
 * beside it carrying the names. `validate_palette.mjs` asserts the contrast and
 * states the dropped pairwise claim out loud rather than omitting the set.
 *
 * Ordered brightest → dimmest in the macro order the screen renders, so the
 * ramp reads as a sequence rather than as four arbitrary greys.
 */
export const monoMacroColors = {
  protein: '#F3F6FA',
  fat: '#CED2DE',
  carbs: '#A4A7B1',
  fibre: '#82858C',
} as const;

/**
 * The CALORIE ring on Today, which is not a macro and deliberately not in
 * {@link macroColors}.
 *
 * N108 draws calories as the outermost of four concentric rings, with the three
 * macros inside it. Calories is the **total** those macros add up to, not a
 * fourth category beside them — so it takes a bright neutral rather than a hue,
 * and the coloured rings read as parts of the white one.
 *
 * That is also what makes the arithmetic work. #106 had already spent the
 * four-hue budget (see the note above: four pairwise at ΔE 15 under three
 * simulations is the frontier), so a fifth HUE was not available. This value is
 * `text`'s, and it clears every macro comfortably — worst pair `carbs` at
 * **ΔE 16.87**, measured, with the rest between 27 and 32. `validate_palette.mjs`
 * asserts all four separations.
 *
 * **There is no monochrome twin, and that is a refusal rather than an
 * oversight.** `monoMacroColors` already runs from #F3F6FA down, so a mono
 * calorie ring would either collide with `protein` at the top of that ramp or
 * add a fifth step to a set that the file records as *already* below the ΔE 15
 * floor at four. Monochrome therefore draws the three macro rings and no
 * calorie ring; the calorie figure is the large number in the middle of them,
 * in words, which is where it is legible anyway.
 */
export const kcalRingColor = '#F3F6FA';

export type MacroColor = keyof typeof macroColors;

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
/** The five belts, named once. `Medal`'s tiers likewise. */
export type BeltKey = keyof typeof beltAccent;
export type MedalTier = 'gold' | 'silver';

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
/**
 * The monogram discs, mode-aware.
 *
 * Under mono every person gets the SAME grey, and that is the honest answer
 * rather than a loss: this file already proves eight distinguishable greys do
 * not exist (see `monoSport`, one grey for four sports). Identity survives on
 * the initials and the `@handle` beside them, which is what mono mode asks of
 * every other signal here.
 *
 * The alternative — eight saturated discs on a greyscale app, one per post —
 * would make the feed the loudest colour surface in the product in exactly the
 * mode chosen to remove colour.
 */
export const activeMonogramColors: Record<MonogramColor, string> = isMono
  ? {
      night: monoSport,
      ocean: monoSport,
      clay: monoSport,
      mint: monoSport,
      mist: monoSport,
    }
  : monogramColors;

export const activeSportColors: Record<SportKey, string> = isMono
  ? { strength: monoSport, bjj: monoSport, running: monoSport, nutrition: monoSport }
  : sportColors;

/**
 * The rest of the sets that live outside `palette` and therefore outside the
 * spread that swaps it.
 *
 * Every one of these was still in full colour after the first monochrome pass —
 * a gold PR medal, a blue belt edge — because `vola` is one object and these are
 * not in it. Same shape as `activeSportColors`: the literal stays parseable for
 * the validator, and the swap happens here where the components read it.
 */
export const activeMedalFace: Record<MedalTier, string> = isMono ? monoMedalFace : medalFace;
export const activeMedalRim: Record<MedalTier, string> = isMono ? monoMedalRim : medalRim;
export const activeBeltAccent: Record<BeltKey, string> = isMono ? monoBeltAccent : beltAccent;
export const activeBeltAccentOn: Record<BeltKey, string> = isMono
  ? monoBeltAccentOn
  : beltAccentOn;

/** The strap itself — a picture rather than a signal. See `monoStrap`. */
export const activeStrap: Record<BeltKey, string> = isMono ? monoStrap : strap;
// Spread rather than four re-typed literals: only the black belt's bar has a
// colour to lose, and hand-copying the other four is how a mono twin silently
// diverges from the original it is supposed to mirror.
export const activeRankBar: Record<BeltKey, string> = isMono
  ? { ...rankBar, black: monoRankBar }
  : rankBar;

/**
 * A tracker's fill, mode-aware, with a DEFAULT for a key this build has never
 * heard of.
 *
 * The fallback is load-bearing rather than defensive: `color_key` comes from the
 * server, and an athlete who authors a tracker on a newer build (or on web)
 * then opens an older phone would otherwise get `undefined` straight into a
 * `backgroundColor` — a transparent cup that reads as empty, which is the one
 * thing this card must never render wrongly.
 */
export function trackerFill(key: string): string {
  const set: Record<string, string> = isMono ? monoTrackerColors : trackerColors;
  return set[key] ?? (isMono ? monoTrackerColors.water : trackerColors.water);
}

/**
 * The macro palette this build actually draws with.
 *
 * Same shape as `activeSportColors`: the two literals stay parseable by
 * `validate_palette.mjs`, and the mode switch happens here rather than at each
 * of the dozen render sites — a screen that reached for `macroColors` directly
 * would keep its colour in monochrome mode and quietly be the one card that
 * ignores the setting.
 */
export const activeMacroColors: Record<MacroColor, string> = isMono
  ? monoMacroColors
  : macroColors;

export default {
  light: scheme,
  dark: scheme,
};
