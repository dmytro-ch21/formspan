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
