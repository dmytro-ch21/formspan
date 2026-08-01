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
   * (CVD) / 35.6 (normal). Adding a fourth needs `validate_palette.js` — violet
   * measured ΔE 2.0 for a deuteranope against this blue.
   */
  info: '#6BB6FF',

  warn: '#FFB020',
  danger: '#FF6B6B',
};

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
