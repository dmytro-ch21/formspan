import { activeMacroColors, isMono, kcalRingColor } from '@/constants/Colors';

import type { Macros, Target } from './nutrition';

/**
 * The Today rings: what they track, and how far round each one goes.
 *
 * Pure logic, deliberately separate from the SVG in
 * `components/today/MacroRings.tsx`. Everything here is arithmetic over numbers
 * the caller already holds, so the honesty rules below are testable without
 * rendering anything — which matters, because every one of them is a rule about
 * what the ring is allowed to CLAIM.
 */

/** The four things a ring can track. Ordered outermost-first when all are on. */
export const RING_KEYS = ['kcal', 'protein', 'carbs', 'fat'] as const;

export type RingKey = (typeof RING_KEYS)[number];

export const RING_LABELS: Record<RingKey, string> = {
  kcal: 'Calories',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};

/**
 * The short form used on the macro rows beside the rings, where the reference
 * shows `PROTEIN` / `CARBS` / `FAT` in caps. Calories never appears as a row —
 * it is the number in the middle — but it carries a label anyway because the
 * ring configuration screen lists all four.
 */
export const RING_SHORT: Record<RingKey, string> = {
  kcal: 'Calories',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};

/** Everything on, which is what an athlete gets before they choose. */
export const DEFAULT_RINGS: readonly RingKey[] = RING_KEYS;

/**
 * At least one ring, or the card has no centrepiece and the whole block becomes
 * an empty circle with a number in it.
 */
export const MIN_RINGS = 1;

/**
 * Parse a stored preference back into a ring set.
 *
 * **Unknown keys are dropped rather than rejected**, and the reason is the one
 * `AccentProvider.parse` records: a build that offered a fifth ring writes it,
 * the athlete downgrades, and a strict parse would throw away their whole
 * configuration over one entry this build cannot draw. Order is normalised to
 * {@link RING_KEYS} so the rings are always nested in the same sequence no
 * matter what order the setting was written in — a ring that changes radius
 * between launches reads as a bug.
 *
 * An empty result falls back to {@link DEFAULT_RINGS}: a stored value that
 * parses to nothing is indistinguishable from a corrupt one, and "no rings" is
 * not a state the athlete can reach through the UI.
 */
export function parseRings(raw: string | null | undefined): readonly RingKey[] {
  if (!raw) return DEFAULT_RINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_RINGS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_RINGS;
  const wanted = new Set(parsed.filter((k): k is RingKey => RING_KEYS.includes(k as RingKey)));
  const ordered = RING_KEYS.filter((k) => wanted.has(k));
  return ordered.length >= MIN_RINGS ? ordered : DEFAULT_RINGS;
}

export function serialiseRings(keys: readonly RingKey[]): string {
  return JSON.stringify(RING_KEYS.filter((k) => keys.includes(k)));
}

/**
 * The colour a ring draws in, or **null when this mode does not draw it**.
 *
 * Single source of truth for the three render sites (the rings, the row dots,
 * the configuration screen's swatches), so they cannot drift — which is the
 * bug `activeMacroColors` was introduced on Goals to prevent.
 *
 * The three macros come from `activeMacroColors`, so **Today and Goals show the
 * same colour for the same macro**, in colour and in monochrome alike. That
 * shared set is N106's, arrived at by its own gamut search; N108 adopted it
 * rather than landing a second palette a day later.
 *
 * `kcal` is the exception at both ends: it is not a macro, so it takes the
 * bright neutral {@link kcalRingColor} in colour mode — and it returns **null**
 * in monochrome, where the four-grey ramp is already below the separation floor
 * and a fifth step would make it worse. A null ring is simply not drawn; the
 * calorie figure is the number in the middle of them.
 */
export function ringColor(key: RingKey): string | null {
  if (key !== 'kcal') return activeMacroColors[key];
  return isMono ? null : kcalRingColor;
}

/**
 * One ring's reading.
 *
 * `percent` is `null` when there is no target to measure against — **not zero**.
 * This is the same refusal `MacroProgress.goal` and `ProgressRing.percent` make,
 * and it is the one that matters most here: a ring drawn at 0% is a claim that
 * the athlete has eaten none of their protein, which is a different statement
 * from "nobody has said how much protein you are aiming at".
 */
export type RingReading = {
  key: RingKey;
  label: string;
  /**
   * Grams, or kcal for `kcal`. **Null when the day could not be read** — never
   * zero.
   *
   * This was `number` with an `eaten ?? 0` inside {@link readRings}, under a
   * docstring claiming it returned 0 "only when totals are known and genuinely
   * zero". It did not: a failed read produced `0`, so the card rendered `0g`
   * macro rows beside a centre reading `Day unread` — two elements on one card
   * disagreeing about the same fact, which is the W2/W4 shape. The type carries
   * it now, so the row cannot render a number the app does not have.
   */
  eaten: number | null;
  /** The target, or null when none is set. */
  goal: number | null;
  /** eaten/goal as a percentage, or null when there is no goal. Never clamped. */
  percent: number | null;
};

/**
 * How far round the ring actually draws.
 *
 * ## The decision this type exists to record: what happens past 100%
 *
 * **The ring wraps.** A second lap is drawn from 12 o'clock on top of the first,
 * exactly as Apple's activity rings do. The alternative — stopping at a full
 * ring — was rejected, and not on taste:
 *
 * > A ring that stops at 100% makes 144% and 100% look identical.
 *
 * That is this repo's most-repeated failure (an absence, or a cap, reading as an
 * answer) in a new costume, and it would sit directly beside an `Over target`
 * pill asserting the opposite. Two elements on one card disagreeing about the
 * same fact is precisely the W2/W4 shape.
 *
 * ## Where wrapping stops being honest, stated rather than hidden
 *
 * The second lap covers 100–200%. Beyond 200% `overflow` saturates at 1 and the
 * ring genuinely cannot distinguish 210% from 400% — so **the ring is not the
 * authority up there, the row's number is**, and the row always renders the real
 * percentage. Recorded here rather than fixed, because a third visual lap is
 * unreadable at this diameter and a lap counter on a ring is a puzzle, not a
 * glance. 400% of a macro target is also a data-entry mistake far more often
 * than it is a meal.
 */
export type RingSweep = {
  /** 0–1 of the first lap. */
  base: number;
  /** 0–1 of a second lap, or null when the ring never reached 100%. */
  overflow: number | null;
  /** True once the ring is past its target — what the `Over target` pill reads. */
  over: boolean;
  /** True past 200%, where `overflow` has saturated and the ring under-states. */
  saturated: boolean;
};

/**
 * `null` percent draws an empty track and nothing else — no sweep, no cap dot.
 * The caller must not substitute 0.
 */
export function sweepFor(percent: number | null): RingSweep | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  const pct = Math.max(0, percent);
  if (pct <= 100) return { base: pct / 100, overflow: null, over: false, saturated: false };
  const second = (pct - 100) / 100;
  return {
    base: 1,
    overflow: Math.min(second, 1),
    over: true,
    saturated: second > 1,
  };
}

/**
 * Whether an arc has enough body to carry a round cap.
 *
 * ## What this fixes, and why it is not a styling preference
 *
 * `MacroRings` draws every ring with `strokeLinecap: 'round'` — that is most
 * of what makes four concentric arcs read as one set, and it is recorded there
 * as a deliberate choice. But a round cap adds half a stroke width beyond each
 * END of the arc, so the mark it draws is never shorter than one stroke width
 * whatever the value behind it. At this app's proportions (13pt stroke, an
 * inner radius near 46pt) that floor is about **4.5% of the ring**, so 1% and
 * 4% draw the identical capsule, and a 2% fill renders as a rounded pill
 * detached from the track it belongs to.
 *
 * The user reported exactly that (#637): *"the nice rings but the overlapping
 * numbers dont make sense"* — four short arcs at four radii, reading as a
 * stack of floating colour pills above the centre rather than as four rings,
 * and therefore as a SECOND colour legend competing with the coloured dot each
 * macro row already carries. The pills were never a legend; they were the data,
 * drawn by a cap.
 *
 * So below the floor the cap comes off: a 2% fill draws a 2% sliver, flush on
 * the track, and the row's dot is left as the only colour key on the card.
 * Above it nothing changes, because there the cap is decoration on an arc that
 * already has a length of its own.
 *
 * `fraction` is 0–1 of one lap (`RingSweep.base` or `overflow`), and the
 * comparison is in the same units as `stroke` — points of arc length.
 */
export function ringCap(
  fraction: number,
  circumference: number,
  stroke: number,
): 'round' | 'butt' {
  if (!Number.isFinite(fraction) || fraction <= 0) return 'butt';
  return fraction * circumference < stroke ? 'butt' : 'round';
}

/**
 * Read the four rings off the day's totals and target.
 *
 * Both arguments are nullable and mean different things when they are null —
 * `totals === null` is "we could not read what was eaten", `target === null` is
 * "no target is set". The caller resolves those from `EatenView`/`TargetView`
 * before getting here; this function only has to refuse to invent numbers for
 * either, which it does by returning `eaten: 0` **only** when totals are known
 * and genuinely zero, and `percent: null` whenever the goal is missing.
 */
export function readRings(
  keys: readonly RingKey[],
  totals: Macros | null,
  target: Target | null,
): RingReading[] {
  const eatenOf: Record<RingKey, number | null> = {
    kcal: totals ? totals.kcal : null,
    protein: totals ? totals.protein_g : null,
    carbs: totals ? totals.carb_g : null,
    fat: totals ? totals.fat_g : null,
  };
  const goalOf: Record<RingKey, number | null> = {
    kcal: target ? target.kcal : null,
    protein: target ? target.protein_g : null,
    carbs: target ? target.carb_g : null,
    fat: target ? target.fat_g : null,
  };

  return RING_KEYS.filter((k) => keys.includes(k)).map((key) => {
    const eaten = eatenOf[key];
    const goal = goalOf[key];
    return {
      key,
      label: RING_LABELS[key],
      eaten,
      goal,
      // A goal of zero would divide to Infinity, and a zero target is a target
      // nobody meant to set — treat it as absent rather than as a ring that is
      // instantly and permanently over.
      percent: eaten === null || goal === null || goal <= 0 ? null : (eaten / goal) * 100,
    };
  });
}

/**
 * The colour a ring's SECOND lap is drawn in — W24/#1022.
 *
 * ## Why this exists instead of a border
 *
 * A ring past 100% wraps, and the two laps have to be tellable apart. The
 * first cut separated them with a hairline of the card's own ground drawn
 * under the second lap. On a dark card that is a black outline, and the
 * athlete asked instead for what a highlighter does: *"if we draw one line it
 * is clean and if we draw another line on top the line becomes darker... no
 * borders just darker."*
 *
 * ## The first attempt was measurably wrong, and the tests said it was fine
 *
 * It darkened by MULTIPLYING the hue with itself — physically what a second
 * pass of ink does — and held the result above a contrast floor against the
 * card. Shipped, the athlete's verdict was *"barely visible"*, and the
 * measurement agrees. CIEDE2000 between the two laps, as shipped:
 *
 * | ring    | ΔE2000 |
 * |---------|--------|
 * | protein | 19.86  |
 * | fat     | 21.01  |
 * | fibre   | 14.50  |
 * | carbs   |  5.42  |
 * | kcal    |  2.68  |
 *
 * Self-multiply cannot move a bright colour: `255 * 255 / 255` is still 255,
 * so the lime and the near-white barely shifted at all. This repo's own
 * palette gate uses ΔE 15 as the floor for two colours being tellable apart;
 * carbs and kcal were nowhere near it.
 *
 * **The enforced constraint was the wrong pair.** The floor asserted the
 * second lap stayed visible against the BACKGROUND — and nothing anywhere
 * asserted it differed from the FIRST LAP, which is the only thing the
 * athlete is actually trying to see. Worse, a test asserted the defect as
 * intended behaviour ("barely moves a near-white, the way ink over paper
 * does"), so the suite defended it. That is this repo's "check that cannot
 * fail" in its most embarrassing form: a test written to describe what the
 * code did rather than what the screen needed.
 *
 * ## What it does now
 *
 * Darken by SCALING the channels — less light, which is what "darker" means
 * on a screen — and choose the amount by measuring both things that matter:
 *
 *  - **separation** from the first lap, ΔE2000 ≥ {@link OVERLAP_SEPARATION_TARGET};
 *  - **visibility** against the card, WCAG contrast ≥ {@link OVERLAP_CONTRAST_FLOOR}
 *    (1.4.11's 3:1 for non-text graphics that carry meaning).
 *
 * It takes the LEAST darkening that reaches the separation target, rather than
 * the most the contrast floor allows. Maximising was tried and measured: it
 * drives every ring to contrast ~3.03 and turns the carbs lime into an olive
 * (`#4F6E13`) and the kcal near-white into a mid grey. The ring's colour IS
 * the macro's identity on this card — the row's dot is keyed to it — so a
 * second lap that has lost the hue is a different failure, not a fix.
 *
 * Where the two constraints cannot both be met the contrast floor wins and
 * the separation is whatever remains: fibre `#D657AA` tops out at ΔE 14.64,
 * because darkening it further puts it under 3:1. Capped, stated, and still
 * an order of magnitude better than the 2.68 it replaces for kcal.
 */
export const OVERLAP_CONTRAST_FLOOR = 3;

/**
 * ΔE2000 the second lap aims to differ from the first by.
 *
 * Above the palette gate's own ΔE 15 "these are two different colours" floor,
 * deliberately: 15 is the bar for two colours being *distinguishable when
 * compared*, and these two are adjacent arcs of the SAME hue on a small
 * ring, read at a glance rather than compared side by side. Measured at 15
 * the step reads as a shading artefact; at 22 it reads as two passes.
 */
export const OVERLAP_SEPARATION_TARGET = 22;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function linear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x contrast ratio. Exported for the tests that pin the floor. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = channels(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000. The same metric `scripts/validate_palette.mjs` uses to judge
 * whether two palette entries are tellable apart, so "distinguishable" means
 * one thing in this repo rather than two.
 */
export function deltaE2000(hexA: string, hexB: string): number {
  const [L1, a1, b1] = toLab(hexA);
  const [L2, a2, b2] = toLab(hexB);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = Cb > 0 ? 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7))) : 0;
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (((Math.atan2(b1, a1p) / rad) % 360) + 360) % 360;
  const h2p = (((Math.atan2(b2, a2p) / rad) % 360) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dhp = C1p * C2p === 0 ? 0 : ((((h2p - h1p + 180) % 360) + 360) % 360) - 180;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** Less light, which is what "darker" means on a screen. */
function darken(hex: string, k: number): string {
  return toHex(channels(hex).map((v) => v * k) as [number, number, number]);
}

/**
 * The second lap's colour: the least darkening that reads as a second pass,
 * never so much that it drops under the contrast floor.
 *
 * Returns the base unchanged only when nothing clears the floor — a hue that
 * dark has nowhere to go, and drawing the wrap in the same colour is the
 * honest failure. It never returns something invisible.
 */
export function overlapColor(hex: string, surface: string): string {
  let best: { hex: string; separation: number } | null = null;
  for (let step = 100; step >= 20; step--) {
    const candidate = darken(hex, step / 100);
    if (contrastRatio(candidate, surface) < OVERLAP_CONTRAST_FLOOR) continue;
    const separation = deltaE2000(hex, candidate);
    if (separation >= OVERLAP_SEPARATION_TARGET) return candidate;
    if (!best || separation > best.separation) best = { hex: candidate, separation };
  }
  return best?.hex ?? hex;
}
