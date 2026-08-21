#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/**
 * The palette gate.
 *
 * `apps/mobile/constants/Colors.ts` and `apps/web/src/lib/libraryTiles.ts` have
 * both cited "validate_palette.js" for a while as the thing you run before
 * adding a colour. It was never committed — the numbers in those comments were
 * measured once, by hand, and every colour added since has been justified
 * against a tool that did not exist. This is that tool, written late.
 *
 * It answers two questions the eye is bad at:
 *
 * 1. **Is it visible?** WCAG contrast against the surface it sits on. 4.5:1 for
 *    body text, 3:1 for large text and for non-text graphics that carry meaning
 *    (WCAG 1.4.11) — a heatmap cell, a chart bar, a status dot.
 * 2. **Are two colours distinguishable — including to someone who does not see
 *    colour the way you do?** CIEDE2000 ΔE between adjacent steps, recomputed
 *    under simulated protanopia, deuteranopia and tritanopia. A ramp can look
 *    beautifully separated and collapse to three identical greens for the ~8%
 *    of men with a red-green deficiency, which is a large fraction of the
 *    people this app is for.
 *
 * Run it: `node scripts/validate_palette.mjs`
 * Exits non-zero on any failure, so it can join `pnpm run verify`.
 *
 * CVD simulation uses the Machado, Oliveira & Fernandes (2009) matrices at
 * severity 1.0, applied in linear RGB. They are an approximation — a real
 * check needs a person — but they are the same approximation the accessibility
 * tooling ecosystem uses, and they reliably catch the collapse case.
 */

/* ---------------------------------------------------------------- colour ---- */

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.x contrast ratio. Symmetric — order of arguments does not matter. */
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/* ------------------------------------------------------------------ CIELAB -- */

const D65 = [0.95047, 1.0, 1.08883];

function toXyz(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ];
}

function toLab(hex) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116);
  const [x, y, z] = toXyz(hex).map((v, i) => f(v / D65[i]));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIEDE2000. Long, and worth it: ΔE76 (plain Euclidean distance in Lab)
 * systematically overstates differences in the blues and understates them in
 * the greens, which is exactly the region a lime training ramp lives in.
 */
function deltaE(hexA, hexB) {
  const [L1, a1, b1] = toLab(hexA);
  const [L2, a2, b2] = toLab(hexB);
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const deg = (r) => (r * 180) / Math.PI;
  const rad = (d) => (d * Math.PI) / 180;
  const hp = (bb, ap) => {
    if (bb === 0 && ap === 0) return 0;
    const h = deg(Math.atan2(bb, ap));
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let Hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) Hbp += h1p + h2p < 360 ? 360 : -360;
    Hbp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(Hbp - 30)) +
    0.24 * Math.cos(rad(2 * Hbp)) +
    0.32 * Math.cos(rad(3 * Hbp + 6)) -
    0.2 * Math.cos(rad(4 * Hbp - 63));
  const dTheta = 30 * Math.exp(-(((Hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

/* --------------------------------------------------------------------- CVD -- */

const CVD = {
  // Machado, Oliveira & Fernandes (2009), severity 1.0.
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** Applied in linear RGB, then re-encoded — the matrices are defined there. */
function simulate(hex, kind) {
  const m = CVD[kind];
  if (!m) return hex;
  const lin = hexToRgb(hex).map(toLinear);
  const out = m.map((row) => row.reduce((s, k, i) => s + k * lin[i], 0));
  return (
    '#' +
    out
      .map((v) => Math.round(Math.min(1, Math.max(0, toSrgb(v))) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}


/* ------------------------------------------------------------------ report -- */

const failures = [];
const fmt = (n) => n.toFixed(2);
let group = '';

const heading = (t) => {
  group = t;
  console.log(`\n${t}`);
};

/** `min` is the floor the ratio must clear. `why` is printed only on failure. */
function ratio(label, fg, bg, min, why = '') {
  const c = contrast(fg, bg);
  const ok = c >= min;
  if (!ok) failures.push(`${group} — ${label}: ${fmt(c)}:1, needs ${min}:1. ${why}`.trim());
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ${fmt(c).padStart(6)}:1  (min ${min})`);
  return c;
}

/**
 * Adjacent ramp steps must stay apart for everyone, not just for you.
 *
 * 15 is the floor this repo has been holding to: the palette notes record a
 * four-step ramp rejected at ΔE 13.5 as "below where full-colour vision
 * separates them", and the three-step replacement measured 18.6+.
 */
function separation(label, a, b, min = 15) {
  const views = { normal: deltaE(a, b) };
  for (const kind of Object.keys(CVD)) {
    views[kind] = deltaE(simulate(a, kind), simulate(b, kind));
  }
  const worst = Math.min(...Object.values(views));
  const worstKind = Object.keys(views).find((k) => views[k] === worst);
  const ok = worst >= min;
  if (!ok) {
    failures.push(
      `${group} — ${label}: ΔE ${fmt(worst)} under ${worstKind}, needs ${min}. ` +
        `Normal vision sees ${fmt(views.normal)}, which is why it looks fine.`,
    );
  }
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ΔE ${fmt(worst).padStart(5)}  ` +
      `(worst: ${worstKind}; normal ${fmt(views.normal)})`,
  );
}

/* ------------------------------------------------------------- self-check --- */

/**
 * Before trusting this on a new hue, check it reproduces the numbers already
 * written down in `constants/Colors.ts` — those were measured by hand with a
 * different tool. If they disagree, this file is wrong and everything below it
 * is noise.
 */
function selfTest() {
  const recorded = [
    ['gridLevels[0] on surface', contrast('#567826', '#10151F'), 3.58],
    ['gridLevels[1] on surface', contrast('#87BC28', '#10151F'), 8.05],
    ['gridLevels[2] on surface', contrast('#B8FF2C', '#10151F'), 15.12],
    ['gridRest at old lineSoft', contrast('#1A2230', '#10151F'), 1.14],
    ['text on setDone', contrast('#F3F6FA', '#293821'), 11.5],
    ['textMuted on setDone', contrast('#949FB3', '#293821'), 4.67],
    ['textDim on setDone', contrast('#667085', '#293821'), 2.51],
  ];
  console.log('\nSelf-check — reproducing the figures recorded in Colors.ts');
  let bad = 0;
  for (const [label, got, want] of recorded) {
    const ok = Math.abs(got - want) <= 0.05;
    if (!ok) bad++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ${fmt(got).padStart(6)}  (recorded ${want})`,
    );
  }
  if (bad) {
    failures.push(
      `Self-check — ${bad} recorded figure(s) not reproduced. Fix this file before ` +
        `trusting any result below.`,
    );
  }
}

/* ------------------------------------------------------------------- main --- */

selfTest();

/**
 * The palette, read out of `constants/Colors.ts` — never copied into here.
 *
 * The first version of this file kept its own table of hexes, and within one
 * edit it was validating a colour the app no longer used: the black-belt red
 * had already changed in Colors.ts and this still reported the old one as
 * failing. A checker with its own copy of the data checks the copy.
 *
 * Regex over TypeScript rather than an import, because this is a .mjs script
 * and the alternative is a build step for one file. It fails loudly on a
 * missing key, so a rename breaks the check rather than silently skipping it.
 */
/**
 * The `accents` object, parsed out of Colors.ts.
 *
 * Every theme is checked, not just the default — a picker that offers an
 * illegible option is worse than not offering it, and the option nobody on the
 * team uses is exactly the one that ships broken.
 */
function accentBlock(src) {
  const m = src.match(/export const accents = \{([\s\S]*?)\} as const;/);
  if (!m) throw new Error('validate_palette: no `accents` block in Colors.ts');
  const out = {};
  for (const line of m[1].split('\n')) {
    const t = line.match(
      /(\w+):\s*\{[^}]*accent:\s*'(#[0-9A-Fa-f]{6})'[^}]*ink:\s*'(#[0-9A-Fa-f]{6})'[^}]*on:\s*'(#[0-9A-Fa-f]{6})'/,
    );
    if (t) out[t[1]] = { accent: t[2], ink: t[3], on: t[4] };
  }
  if (!Object.keys(out).length) throw new Error('validate_palette: `accents` parsed empty');
  return out;
}

function loadPalette() {
  const src = readFileSync(new URL('../apps/mobile/constants/Colors.ts', import.meta.url), 'utf8');
  const one = (key) => {
    const m = src.match(new RegExp(`\\b${key}:\\s*'(#[0-9A-Fa-f]{6})'`));
    if (!m) throw new Error(`validate_palette: no '${key}' in Colors.ts — renamed or removed?`);
    return m[1];
  };
  const block = (name, expected) => {
    const m = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`));
    if (!m) throw new Error(`validate_palette: no '${name}' block in Colors.ts`);
    const out = Object.fromEntries(
      [...m[1].matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)].map((x) => [x[1], x[2]]),
    );
    // A block that parses EMPTY is the failure this whole file exists to not
    // have: every `for (const [k, hex] of Object.entries(...))` below would run
    // zero times and the gate would pass having checked nothing. Reachable
    // without anyone noticing — one entry stops being an inline hex literal and
    // the regex quietly returns {}. `accentBlock` already guards this; these
    // did not.
    const n = Object.keys(out).length;
    if (n === 0) throw new Error(`validate_palette: '${name}' parsed empty — entries no longer inline hex?`);
    if (expected != null && n !== expected) {
      throw new Error(`validate_palette: '${name}' parsed ${n} entries, expected ${expected}`);
    }
    return out;
  };
  const ramp = src.match(/gridLevels:\s*\[([^\]]+)\]/);
  if (!ramp) throw new Error('validate_palette: no gridLevels in Colors.ts');
  const monoBlock = src.match(/export const mono = \{([\s\S]*?)\n\};/);
  if (!monoBlock) throw new Error('validate_palette: no `mono` block in Colors.ts');
  const monoOne = (key) => {
    const m = monoBlock[1].match(new RegExp(`\\b${key}:\\s*'(#[0-9A-Fa-f]{6})'`));
    if (!m) throw new Error(`validate_palette: no mono '${key}' — renamed or removed?`);
    return m[1];
  };
  const monoRampMatch = monoBlock[1].match(/gridLevels:\s*\[([^\]]+)\]/);
  if (!monoRampMatch) throw new Error('validate_palette: no mono gridLevels in Colors.ts');
  const monoRamp = [...monoRampMatch[1].matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]);
  if (monoRamp.length !== 3) throw new Error('validate_palette: mono gridLevels needs three steps');
  const monoSportMatch = src.match(/export const monoSport = '(#[0-9A-Fa-f]{6})'/);
  if (!monoSportMatch) throw new Error('validate_palette: no `monoSport` in Colors.ts');
  return {
    S: { bg: one('bg'), surface: one('surface'), raised: one('surfaceRaised') },
    P: {
      text: one('text'), textMuted: one('textMuted'), textDim: one('textDim'),
      accent: one('accent'), accentInk: one('accentInk'), accentOn: one('accentOn'),
      lime: one('lime'), green: one('green'), info: one('info'),
      warn: one('warn'), danger: one('danger'), gridRest: one('gridRest'),
      tileHold: one('tileHold'),
      ramp: [...ramp[1].matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]),
    },
    BELT: block('beltAccent', 5),
    BELT_ON: block('beltAccentOn', 5),
    ACCENTS: accentBlock(src),
    SPORTS: block('sportColors', 4),
    MONOGRAM: block('monogramColors', 5),
    MONOGRAM_INK: block('monogramInk', 5),
    // Five: water (N76), coffee (N77), and the three N78 added so an athlete
    // authoring their own tracker has a palette to choose from. The expected
    // count is what forces the next addition through this file — adding a
    // tracker colour without running the gate throws here rather than shipping
    // an unmeasured fill.
    //
    // **Five is the measured ceiling with margin, not a round number.** Six is
    // feasible at ΔE 15.12 against a floor of 15; five clears at 16.58. The
    // search and both figures are recorded in `trackerColors`' doc comment.
    TRACKER: block('trackerColors', 5),
    MONO_TRACKER: block('monoTrackerColors', 5),
    // Four, and four is the frontier rather than a starting point — see the
    // section below and the note on `macroColors` in Colors.ts. The asserted
    // count is what makes a fifth macro a colour search instead of a line in
    // an object.
    MACRO: block('macroColors', 4),
    MONO_MACRO: block('monoMacroColors', 4),
    MONO: {
      rest: monoOne('gridRest'),
      ramp: monoRamp,
      lime: monoOne('lime'),
      info: monoOne('info'),
      danger: monoOne('danger'),
      warn: monoOne('warn'),
      tileHold: monoOne('tileHold'),
      accent: monoOne('accent'),
      sport: monoSportMatch[1],
    },
    MONO_MEDAL: block('monoMedalFace', 2),
    MONO_BELT: block('monoBeltAccent', 5),
    MONO_BELT_ON: block('monoBeltAccentOn', 5),
  };
}

const { S, P, BELT, BELT_ON, ACCENTS, SPORTS, MONOGRAM, MONOGRAM_INK, MONO, MONO_MEDAL, MONO_BELT, MONO_BELT_ON, TRACKER, MONO_TRACKER, MACRO, MONO_MACRO } =
  loadPalette();

heading('Text');
ratio('text on surface', P.text, S.surface, 4.5);
ratio('textMuted on surface', P.textMuted, S.surface, 4.5);
ratio('textDim on surface (large/secondary only)', P.textDim, S.surface, 3);

heading(`Accent themes — every one the picker offers (${Object.keys(ACCENTS).length})`);
for (const [name, a] of Object.entries(ACCENTS)) {
  ratio(`${name} — fill on surface`, a.accent, S.surface, 3, 'A fill that carries meaning: WCAG 1.4.11.');
  ratio(`${name} — fill on raised`, a.accent, S.raised, 3);
  ratio(`${name} — ink on it`, a.on, a.accent, 4.5, 'What is written on an accent is small: "1M", "Log".');
  ratio(`${name} — as text on surface`, a.ink, S.surface, 4.5);
}

// `info` is the one hue an accent must stay clear of, because Library tiles
// carry it *as a category* beside accent-coloured chrome on the same screen.
// `warn` and `danger` are deliberately NOT hard-checked here — see the long
// note on `accents` in Colors.ts for why, and for the two themes it costs.
heading('Accents vs the categorical blue they share a screen with');
for (const [name, a] of Object.entries(ACCENTS)) {
  if (name === 'blue') continue; // a blue accent IS blue; nothing to separate.
  separation(`${name} vs info`, a.accent, P.info);
}

heading('Consistency grid — green, and staying green');
ratio('ramp[0] on surface', P.ramp[0], S.surface, 3, 'The faintest trained day must still be a day.');
separation('rest → ramp[0]', P.gridRest, P.ramp[0]);
separation('ramp 0→1', P.ramp[0], P.ramp[1]);
separation('ramp 1→2', P.ramp[1], P.ramp[2]);

// The monochrome mode replaces every hue in the palette with a grey, resolved
// at module-evaluation time so all 794 colour reads in the app pick it up (see
// the `mono` block in Colors.ts for why that mechanism and not a filter or a
// hook). Lightness is the only axis left, so these are exactly the checks the
// coloured palette gets — and they are the checks most likely to be *newly*
// failed, because two hues that separate on chroma may not separate at all once
// the chroma is gone.
heading('Monochrome mode — the same guarantees, on one axis');
ratio('mono accent on surface', MONO.accent, S.surface, 3, 'A fill that carries meaning: WCAG 1.4.11.');
ratio('mono danger on surface', MONO.danger, S.surface, 4.5, 'Error text and destructive actions.');
ratio('mono warn on surface', MONO.warn, S.surface, 4.5);
ratio('mono sport on surface', MONO.sport, S.surface, 4.5);
// The accent must not read as body text: the whole job of an accent is being
// the brighter thing, and `text` is #F3F6FA.
separation('mono accent vs body text', MONO.accent, P.text, 8);
// Grid: a QUANTITY, so its steps have to be countable.
ratio('mono ramp[0] on surface', MONO.ramp[0], S.surface, 3, 'The faintest trained day must still be a day.');
separation('mono rest → ramp[0]', MONO.rest, MONO.ramp[0]);
separation('mono ramp 0→1', MONO.ramp[0], MONO.ramp[1]);
separation('mono ramp 1→2', MONO.ramp[1], MONO.ramp[2]);
/*
  Library tile intents, and the one place this file admits a guarantee is
  WEAKER in monochrome rather than merely different.

  In colour these four are checked pairwise at ΔE 15. Four achromatic values
  cannot meet that and 4.5:1 on the card at the same time — it is arithmetic, not
  a failure of imagination: 4.5:1 puts the floor at L* 53.4, white is the
  ceiling, and CIEDE2000's lightness compression means three gaps of 15 do not
  fit in what is left. Measured, the best available spacing puts the top pair at
  ΔE 9.9.

  So the pairwise claim is dropped rather than fudged with a lowered threshold —
  and it can be, because the tile is not colour-only: it renders the category's
  own three-letter code (SUB, SWP, PIN) inside it, and the row beside it spells
  the category out. What is still asserted is contrast, and that the set has at
  least two genuinely distinguishable steps, so mono cannot silently collapse to
  one flat grey through a later edit.
*/
const MONO_TILES = {
  attack: MONO.danger,
  advance: MONO.lime,
  defend: MONO.info,
  hold: MONO.tileHold,
};
for (const [name, hex] of Object.entries(MONO_TILES)) {
  ratio(`mono ${name} on surface`, hex, S.surface, 4.5);
}
separation('mono tiles keep two steps', MONO_TILES.advance, MONO_TILES.defend);

/*
  The sets that live OUTSIDE `palette` and therefore outside the mono spread.

  Every one of these shipped still in full colour after the first monochrome
  pass — a gold PR medal, a blue belt edge — because `vola` is one object and
  these are not in it. They are checked here so the next one added is caught by
  a failing gate rather than by looking at a phone.
*/
heading('Monochrome — the sets that are not part of `vola`');
ratio('mono medal gold on surface', MONO_MEDAL.gold, S.surface, 3, 'A badge is a graphic that carries meaning.');
ratio('mono medal silver on surface', MONO_MEDAL.silver, S.surface, 3);
// The two tiers mean different things — a live record versus a standing one —
// so unlike the sports these still have to separate. The gold tier's star is
// redundant encoding on top, not instead.
separation('mono medal gold vs silver', MONO_MEDAL.gold, MONO_MEDAL.silver);
for (const [belt, hex] of Object.entries(MONO_BELT)) {
  // Same 3:1 on both grounds the coloured belt accents promise.
  ratio(`mono belt ${belt} on raised`, hex, S.raised, 3);
  ratio(`mono belt ${belt} on surface`, hex, S.surface, 3);
  ratio(`mono belt ${belt} — ink on it`, MONO_BELT_ON[belt], hex, 4.5);
}

// Sports DO co-occur — a Recent list mixes them in one column — so unlike the
// belts these must be distinguishable from each other, pairwise, under CVD.
heading('Sport colours — categorical, and they share a list');
for (const [name, hex] of Object.entries(SPORTS)) ratio(`${name} on surface`, hex, S.surface, 4.5);
const sports = Object.entries(SPORTS);
for (let i = 0; i < sports.length; i++) {
  for (let j = i + 1; j < sports.length; j++) {
    separation(`${sports[i][0]} vs ${sports[j][0]}`, sports[i][1], sports[j][1]);
  }
}

// The feed's monogram discs. Categorical in the hardest way: one per PERSON,
// derived from their handle, sitting adjacent down a scrolling list — and the
// whole value of the feature is being able to tell two friends apart at a
// glance without reading. So pairwise separation matters more here than for any
// other set in this file, and there are eight of them rather than four.
//
// White text sits on every disc, so the contrast check is ink-on-fill, not
// fill-on-surface: the disc is a filled shape carrying a label, not a signal
// read against the background.
heading('Monogram discs — one per person, adjacent in a scrolling list');
for (const [name, hex] of Object.entries(MONOGRAM)) {
  ratio(`ink on ${name}`, MONOGRAM_INK[name], hex, 4.5, 'Two initials, small, on a filled disc.');
}
const monograms = Object.entries(MONOGRAM);
for (let i = 0; i < monograms.length; i++) {
  for (let j = i + 1; j < monograms.length; j++) {
    separation(`${monograms[i][0]} vs ${monograms[j][0]}`, monograms[i][1], monograms[j][1]);
  }
}

// The Library tile intents. `components/LibraryTile.tsx` records that the
// obvious one-hue-per-category scheme failed at ΔE 2.0 for a deuteranope, and
// that these four clear every check — a claim that was measured by hand and,
// until now, against a validator that did not exist.
heading('Library tile intents — four hues carrying nine categories');
const TILES = { attack: P.danger, advance: P.lime, defend: P.info, hold: P.tileHold };
const tiles = Object.entries(TILES);
for (const [name, hex] of tiles) ratio(`${name} on surface`, hex, S.surface, 4.5);
for (let i = 0; i < tiles.length; i++) {
  for (let j = i + 1; j < tiles.length; j++) {
    separation(`${tiles[i][0]} vs ${tiles[j][0]}`, tiles[i][1], tiles[j][1]);
  }
}

/*
  Daily-tracker fills. Categorical, and unusually exposed:

  - TWO different floors, because the colour does two jobs. On `surface` it is
    also TEXT — the card's value line ("4 of 8 cups") is tinted, so 4.5:1. On
    `raised` it is only ever a filled glyph, which WCAG 1.4.11 puts at 3:1, the
    same floor `beltAccent` is held to on the same ground. Holding a fill to
    4.5:1 is stricter than the standard and stricter than anything else in this
    file; the two candidates it rejected here (4.35 and 4.40) were rejected for
    a rule nothing else obeys, which is how a gate stops meaning anything.
    **If a tracker colour is ever used for text on `raised`, this becomes 4.5
    and two of these values have to move.**
  - several cards sit on Today at once (water and coffee, then whatever N78's
    athlete adds), so the set has to separate pairwise under CVD;
  - `info` is the categorical blue the app already uses, and a water-blue is the
    one hue in the product most likely to collide with it. That pair is why
    water is a deep teal rather than the vivid cyan it wants to be — see the
    measurements in the `trackerColors` doc comment.

  This is a loop over the whole block, not a list of named checks, so adding a
  colour for N77 or N78 is one line in Colors.ts and the gate covers it
  automatically. The `block(..., 2)` count above is what stops that line being
  added without anybody running this.
*/
heading('Daily-tracker fills — several cards share Today');
const trackers = Object.entries(TRACKER);
for (const [name, hex] of trackers) {
  ratio(`${name} on surface`, hex, S.surface, 4.5, 'The value line renders in this colour.');
  ratio(`${name} on raised`, hex, S.raised, 3, 'A filled glyph on a raised ground: WCAG 1.4.11.');
  ratio(`${name} — ink on a filled glyph`, S.bg, hex, 4.5);
  separation(`${name} vs info`, hex, P.info);
}
for (let i = 0; i < trackers.length; i++) {
  for (let j = i + 1; j < trackers.length; j++) {
    separation(`${trackers[i][0]} vs ${trackers[j][0]}`, trackers[i][1], trackers[j][1]);
  }
}

heading('Daily-tracker fills in monochrome — the same guarantees, on one axis');
const monoTrackers = Object.entries(MONO_TRACKER);
if (monoTrackers.length !== trackers.length) {
  failures.push(
    `Daily-tracker fills in monochrome — ${monoTrackers.length} greys for ` +
      `${trackers.length} colours. A hue with no mono twin stays coloured in a ` +
      `black-and-white app, which is how a gold medal and a blue belt survived ` +
      `the first mono pass.`,
  );
}
for (const [name, hex] of monoTrackers) {
  if (!(name in TRACKER)) {
    failures.push(`Daily-tracker fills in monochrome — '${name}' has no coloured original`);
  }
  ratio(`mono ${name} on surface`, hex, S.surface, 4.5);
  ratio(`mono ${name} on raised`, hex, S.raised, 3);
  ratio(`mono ${name} — ink on a filled glyph`, S.bg, hex, 4.5);
}
/*
  **The pairwise claim is DROPPED for the monochrome trackers, and this is the
  second place in this file that admits a guarantee is weaker in monochrome
  rather than merely different.** Same arithmetic as MONO_TILES above, one set
  over: 4.5:1 on `surface` puts the achromatic floor at #757f96, white is the
  ceiling, and CIEDE2000's lightness compression leaves the whole admissible
  band spanning ΔE 34. Four gaps of 15 do not fit in 34 — measured, the best
  spacing available for five values is 6.58 between adjacent steps.

  Until N78 there were two greys and they cleared 15 easily. That is not
  evidence the rule scales; it is what two values in a 34-wide band look like.

  It is dropped rather than fudged with a lowered threshold because a threshold
  nobody can state a reason for is how a gate stops meaning anything — the same
  argument the tracker-fill comment above makes about holding a fill to 4.5:1.
  And it is SAFE to drop for exactly the reason `trackerColors`' own doc gives:
  a tracker card renders its NAME and its ICON, so the fill is redundant
  encoding here, never the only channel. The COLOURED set keeps the pairwise
  check at 15, because there the fill is doing more work.

  What is still asserted: every grey clears all three contrast floors (above),
  adjacent steps stay apart by a stated amount, and the extremes stay ΔE 15
  apart — so monochrome cannot silently collapse to one flat grey through a
  later edit, which is the failure this section actually exists to catch.
*/
const MONO_ADJACENT_MIN = 5;
const byLightness = [...monoTrackers].sort(
  (a, b) => contrast(a[1], S.surface) - contrast(b[1], S.surface),
);
for (let i = 1; i < byLightness.length; i++) {
  separation(
    `mono ${byLightness[i - 1][0]} → ${byLightness[i][0]} (adjacent)`,
    byLightness[i - 1][1],
    byLightness[i][1],
    MONO_ADJACENT_MIN,
  );
}
if (byLightness.length >= 2) {
  separation(
    'mono trackers span at least two real steps',
    byLightness[0][1],
    byLightness[byLightness.length - 1][1],
  );
}

/*
  The four macros — the densest categorical set in the app, and the one whose
  reference design this file had to overrule.

  N106's Goals screen draws protein, fat, carbs and fibre three times over: a
  row of tiles, a four-segment donut, and a colour-dotted legend. The donut is
  the reason the full pairwise claim is asserted here rather than waived the way
  the belts' is — a segment carries no label, so colour is the ONLY channel
  telling one arc from the next.

  The supplied reference's own four values were sampled from the PNG and
  measured here first: protein #5C9BFA / fat #FBC410 / carbs #B8FF2C /
  fibre #B16AF6. Two of the six pairs fail under deuteranopia — blue vs violet
  at ΔE 8.50, and amber vs lime at ΔE 9.78 — so what ships is the nearest set
  that clears this gate rather than the reference's literal hues. Two of the
  four are unchanged; the two that moved are exactly the two the arithmetic
  forbids. The binding pairs now measure ~15.6, so this is a frontier: a
  "nicer" gold or a bluer violet fails, and the failure is the point.
*/
heading('Macro colours — four categories, three renderings, one screen');
const macros = Object.entries(MACRO);
for (const [name, hex] of macros) {
  ratio(`${name} on surface`, hex, S.surface, 4.5, 'The legend value renders in this colour, at 13pt.');
  ratio(`${name} on raised`, hex, S.raised, 4.5, 'The tile label sits on a raised card, same size.');
  ratio(`${name} — ink on a filled glyph`, S.bg, hex, 4.5);
}
for (let i = 0; i < macros.length; i++) {
  for (let j = i + 1; j < macros.length; j++) {
    separation(`${macros[i][0]} vs ${macros[j][0]}`, macros[i][1], macros[j][1]);
  }
}

/*
  The macros in monochrome, and the second place this file admits a WEAKER
  guarantee rather than a different one.

  Same arithmetic as the library tiles above: four achromatic values cannot be
  ΔE 15 apart while all four also clear 4.5:1. Measured by search over the grey
  ramp, the ceiling is ΔE 11.24 — at which point the darkest step is already at
  4.52:1 on `raised`. So the pairwise claim is dropped here too.

  It is a worse trade than the tiles', and worth saying so: a tile carries its
  own three-letter code, and a donut segment carries nothing. What mono keeps is
  ORDER — the ramp runs brightest to dimmest in the order the legend lists — and
  the legend beside it carries the names. What is still asserted is contrast,
  and that the ramp has not collapsed: the two ENDS must stay genuinely apart,
  so a later edit cannot quietly flatten four steps into one grey.
*/
/*
  The calorie ring (N108), which is not a macro and is checked against all of
  them.

  Calories is the TOTAL the macros sum to, so it takes a bright neutral rather
  than a fifth hue — the four-hue budget was already spent, and this reads as
  the whole with the coloured parts inside it. It is drawn as a ring stroke and
  never as text, but it is held to the text floor anyway because it is the same
  value `text` uses and a weaker assertion here would be misleading.

  No monochrome twin is checked because none exists: `monoMacroColors` already
  starts at this value, so mono draws the three macro rings and no calorie ring.
  See the note on `kcalRingColor` in Colors.ts.
*/
heading('The calorie ring — a total, not a fourth macro');
const kcalRingMatch = readFileSync(new URL('../apps/mobile/constants/Colors.ts', import.meta.url), 'utf8')
  .match(/export const kcalRingColor = '(#[0-9A-Fa-f]{6})'/);
if (!kcalRingMatch) {
  failures.push('kcalRingColor missing from Colors.ts — renamed, or no longer an inline hex?');
} else {
  ratio('calorie ring on surface', kcalRingMatch[1], S.surface, 4.5);
  ratio('calorie ring on raised', kcalRingMatch[1], S.raised, 3, 'A ring stroke: WCAG 1.4.11.');
  for (const [name, hex] of macros) {
    separation(`calorie ring vs ${name}`, kcalRingMatch[1], hex);
  }
}

heading('Macro colours in monochrome — order survives, hue does not');
const monoMacros = Object.entries(MONO_MACRO);
if (monoMacros.length !== macros.length) {
  failures.push(
    `Macro colours in monochrome — ${monoMacros.length} greys for ${macros.length} ` +
      `colours. A macro with no mono twin stays coloured in a black-and-white app.`,
  );
}
for (const [name, hex] of monoMacros) {
  if (!(name in MACRO)) {
    failures.push(`Macro colours in monochrome — '${name}' has no coloured original`);
  }
  ratio(`mono ${name} on surface`, hex, S.surface, 4.5);
  ratio(`mono ${name} on raised`, hex, S.raised, 4.5);
}
separation('mono macros keep their two ends apart', monoMacros[0][1], monoMacros[monoMacros.length - 1][1]);

heading('Belt accents — the rank card and the belt-syllabus cards');
for (const [belt, hex] of Object.entries(BELT)) {
  ratio(`${belt} on raised`, hex, S.raised, 3);
  // `surface` too, since the Plan tab's syllabus cards took the second
  // sanctioned use of this set and their rule sits on `surface`, not `raised`.
  // Arithmetically it cannot fail while `raised` passes — surface is the darker
  // of the two, so every ratio is strictly higher — but the doc comment in
  // Colors.ts promises 3:1 on BOTH, and an unchecked promise is how the strip
  // shipped with the strap colours at 1.05:1 in the first place.
  ratio(`${belt} on surface`, hex, S.surface, 3);
  ratio(`${belt} — ink on it`, BELT_ON[belt], hex, 4.5);
}
// Belts are NOT checked against each other: an athlete has exactly one, so two
// of them never appear together and "distinguishable" is not a requirement. The
// collision that IS real is with `danger`, which can sit on the same screen as
// the rank card whenever the profile fails to load.
separation('black-belt red vs danger', BELT.black, P.danger);
separation('black-belt red vs warn', BELT.black, P.warn);

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log('\nAll checks pass.\n');
