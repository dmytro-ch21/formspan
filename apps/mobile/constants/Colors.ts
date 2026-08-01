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
