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
  green: '#42F58D',
  navy: '#0B1220',

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
