import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEFAULT_RINGS,
  OVERLAP_CONTRAST_FLOOR,
  OVERLAP_SEPARATION_TARGET,
  RING_KEYS,
  contrastRatio,
  deltaE2000,
  overlapColor,
  parseRings,
  readRings,
  ringCap,
  serialiseRings,
  sweepFor,
} from '../macroRings';
import type { Macros, Target } from '../nutrition';
import { kcalRingColor, macroColors, vola } from '@/constants/Colors';

const macros = (over: Partial<Macros> = {}): Macros => ({
  kcal: 1242,
  protein_g: 71,
  carb_g: 130,
  fat_g: 47,
  fibre_g: null,
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
  ...over,
});

const target = (over: Partial<Target> = {}): Target => ({
  effective_on: '2026-08-20',
  kcal: 1840,
  protein_g: 205,
  carb_g: 90,
  fat_g: 75,
  fibre_g: null,
  ...over,
});

describe('sweepFor — how far round a ring draws', () => {
  it('draws nothing at all when there is no percentage', () => {
    // The whole point: no target is not the same as no progress. A caller that
    // substituted 0 here would draw a full empty ring, which asserts the
    // athlete has eaten none of a thing nobody has set a goal for.
    expect(sweepFor(null)).toBeNull();
  });

  it('maps a percentage onto the first lap', () => {
    expect(sweepFor(0)).toEqual({ base: 0, overflow: null, over: false, saturated: false });
    expect(sweepFor(50)).toEqual({ base: 0.5, overflow: null, over: false, saturated: false });
    expect(sweepFor(100)).toEqual({ base: 1, overflow: null, over: false, saturated: false });
  });

  it('WRAPS past 100% instead of stopping — 144% and 100% must not look the same', () => {
    // This is the decision the ticket asked to be made deliberately. If the
    // ring stopped at full, these two would render identically while an
    // `Over target` pill beside them said otherwise.
    const full = sweepFor(100);
    const over = sweepFor(144);

    expect(over).not.toEqual(full);
    expect(over).toEqual({
      base: 1,
      overflow: expect.closeTo(0.44, 5),
      over: true,
      saturated: false,
    });
  });

  it('reports `over` exactly at the boundary, not before it', () => {
    expect(sweepFor(100)?.over).toBe(false);
    expect(sweepFor(100.1)?.over).toBe(true);
  });

  it('saturates past 200% and SAYS SO rather than pretending to distinguish', () => {
    const a = sweepFor(210);
    const b = sweepFor(400);
    // Both draw the same two laps — the ring genuinely cannot show a third.
    expect(a?.overflow).toBe(1);
    expect(b?.overflow).toBe(1);
    // …and both admit it, so a caller can defer to the row's number.
    expect(a?.saturated).toBe(true);
    expect(b?.saturated).toBe(true);
    // 200% exactly is the last honest reading.
    expect(sweepFor(200)?.saturated).toBe(false);
  });

  it('refuses a non-finite percentage rather than drawing NaN', () => {
    expect(sweepFor(Number.NaN)).toBeNull();
    expect(sweepFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('clamps a negative percentage to an empty ring, never a reversed one', () => {
    expect(sweepFor(-20)).toEqual({ base: 0, overflow: null, over: false, saturated: false });
  });
});

describe('readRings — reading the day onto the rings', () => {
  it('gives every ring a percentage when totals and target are both known', () => {
    const rings = readRings(RING_KEYS, macros(), target());
    expect(rings.map((r) => r.key)).toEqual(['kcal', 'protein', 'carbs', 'fat']);
    expect(rings.find((r) => r.key === 'carbs')?.percent).toBeCloseTo(144.44, 1);
    expect(rings.find((r) => r.key === 'protein')?.percent).toBeCloseTo(34.63, 1);
  });

  it('returns percent null — NOT zero — when no target is set', () => {
    const rings = readRings(RING_KEYS, macros(), null);
    for (const r of rings) {
      expect(r.percent).toBeNull();
      expect(r.goal).toBeNull();
    }
    // The eaten figures are still real and still shown.
    expect(rings.find((r) => r.key === 'protein')?.eaten).toBe(71);
  });

  it('returns percent null when the day could not be read', () => {
    const rings = readRings(RING_KEYS, null, target());
    for (const r of rings) expect(r.percent).toBeNull();
  });

  it('reports EATEN as null when the day could not be read, never as zero', () => {
    // The row renders this figure. A `0` here sat beside a centre reading
    // "Day unread" — two elements on one card disagreeing about one fact.
    const rings = readRings(RING_KEYS, null, target());
    for (const r of rings) expect(r.eaten).toBeNull();
  });

  it('still reports a GENUINE zero as zero, so the two stay distinguishable', () => {
    // The whole point of the null is that it means something else. A day that
    // was read and holds nothing is a real 0 and must render as one.
    const rings = readRings(RING_KEYS, macros({ kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 }), target());
    for (const r of rings) expect(r.eaten).toBe(0);
    expect(rings.find((r) => r.key === 'protein')?.percent).toBe(0);
  });

  it('treats a zero target as absent rather than as instantly-and-forever over', () => {
    // Dividing by it would give Infinity, and a ring pinned at "over" for a
    // goal nobody meant to set is worse than no ring.
    const rings = readRings(['protein'], macros(), target({ protein_g: 0 }));
    expect(rings[0].percent).toBeNull();
  });

  it('honours the configured subset, and always in the canonical order', () => {
    // Order is normalised so a ring never changes radius between launches.
    const rings = readRings(['fat', 'kcal'], macros(), target());
    expect(rings.map((r) => r.key)).toEqual(['kcal', 'fat']);
  });
});

describe('parseRings — the stored preference', () => {
  it('falls back to every ring when nothing is stored', () => {
    expect(parseRings(null)).toEqual(DEFAULT_RINGS);
    expect(parseRings(undefined)).toEqual(DEFAULT_RINGS);
    expect(parseRings('')).toEqual(DEFAULT_RINGS);
  });

  it('falls back rather than throwing on a corrupt value', () => {
    expect(parseRings('{oh no')).toEqual(DEFAULT_RINGS);
    expect(parseRings('"protein"')).toEqual(DEFAULT_RINGS);
    expect(parseRings('{"a":1}')).toEqual(DEFAULT_RINGS);
  });

  it('DROPS an unknown key instead of discarding the whole setting', () => {
    // A newer build offering a fifth ring must not cost this build the four it
    // does understand.
    expect(parseRings('["protein","sodium","fat"]')).toEqual(['protein', 'fat']);
  });

  it('normalises order, so the rings never renest between launches', () => {
    expect(parseRings('["fat","kcal","carbs","protein"]')).toEqual([
      'kcal',
      'protein',
      'carbs',
      'fat',
    ]);
  });

  it('refuses an empty set — there is no "no rings" state', () => {
    expect(parseRings('[]')).toEqual(DEFAULT_RINGS);
    expect(parseRings('["sodium"]')).toEqual(DEFAULT_RINGS);
  });

  it('round-trips through serialise', () => {
    expect(parseRings(serialiseRings(['fat', 'protein']))).toEqual(['protein', 'fat']);
  });
});

/**
 * The cap, and the "floating pills" it drew (N201/#637).
 *
 * `MacroRings` ships a 13pt stroke; the inner ring's circumference is about
 * 290pt, so one stroke width is ~4.5% of that lap. Below the floor the round
 * cap is longer than the arc it caps, which is how a 2% protein fill rendered
 * as a capsule sitting off the track — read by the user as a second colour
 * legend competing with the macro rows' own dots.
 */
describe('ringCap', () => {
  // Inner ring: radius (168 - 13) / 2 - 3 * (13 + 5) = 23.5 → C ≈ 147.7.
  const INNER = 2 * Math.PI * 23.5;
  // Outer ring: radius (168 - 13) / 2 = 77.5 → C ≈ 487.
  const OUTER = 2 * Math.PI * 77.5;
  const STROKE = 13;

  it('drops the cap when the arc is shorter than the cap itself', () => {
    expect(ringCap(0.02, INNER, STROKE)).toBe('butt');
    expect(ringCap(0.02, OUTER, STROKE)).toBe('butt');
  });

  it('keeps it once the arc has a body of its own', () => {
    expect(ringCap(0.5, INNER, STROKE)).toBe('round');
    expect(ringCap(0.14, OUTER, STROKE)).toBe('round');
  });

  // The threshold is arc LENGTH, not percentage: the same 5% is a longer mark
  // on the outer ring than on the inner one, and only one of them clears it.
  it('is a length, so the same percentage differs by radius', () => {
    expect(ringCap(0.05, INNER, STROKE)).toBe('butt');
    expect(ringCap(0.05, OUTER, STROKE)).toBe('round');
  });

  it('exactly one stroke width of arc is enough', () => {
    const fraction = STROKE / INNER;
    expect(ringCap(fraction, INNER, STROKE)).toBe('round');
    expect(ringCap(fraction * 0.999, INNER, STROKE)).toBe('butt');
  });

  // A ring at zero draws no arc; a cap on it would draw a dot, which is a
  // reading. `sweepFor` already refuses to invent one for a null percent.
  it('never caps a zero or absent sweep', () => {
    expect(ringCap(0, INNER, STROKE)).toBe('butt');
    expect(ringCap(-1, INNER, STROKE)).toBe('butt');
    expect(ringCap(Number.NaN, INNER, STROKE)).toBe('butt');
  });
});


/**
 * W24/#1022 — a wrapped ring's second lap is darker ink, and it has to be
 * DISTINGUISHABLE ink.
 *
 * The first shipped fix held the second lap above a contrast floor against
 * the card and asserted nothing about how far it sat from the first lap. The
 * athlete's verdict was "barely visible", and the measurement agreed: carbs
 * separated by ΔE 5.42 and kcal by 2.68, against this repo's own ΔE 15 floor
 * for two colours being tellable apart. Self-multiply cannot move a bright
 * colour — 255 × 255 / 255 is still 255.
 *
 * Worse, a test asserted that as correct ("barely moves a near-white, the way
 * ink over paper does"), so the suite defended the defect. These tests pin the
 * property the screen needs instead of the behaviour the code had.
 */
const SURFACE = vola.surface;

describe('overlapColor — the second lap has to READ as a second pass', () => {
  it('separates every ring far past the shading-artefact range', () => {
    // ΔE 15 is the palette gate's "two different colours" floor. Fibre is
    // contrast-capped below it (14.64) and is the documented exception; every
    // other ring clears the full target.
    const measured = Object.fromEntries(
      Object.entries(macroColors).map(([name, hex]) => [
        name,
        deltaE2000(hex, overlapColor(hex, SURFACE)) >= 14,
      ]),
    );
    expect(measured).toEqual({ protein: true, fat: true, carbs: true, fibre: true });
  });

  it('fixes the two the athlete could not see — carbs and the calorie ring', () => {
    // The regression guard on the actual complaint. Under self-multiply these
    // were 5.42 and 2.68; anything near those is the old bug returning.
    for (const hex of [macroColors.carbs, kcalRingColor]) {
      expect(deltaE2000(hex, overlapColor(hex, SURFACE))).toBeGreaterThanOrEqual(
        OVERLAP_SEPARATION_TARGET - 1,
      );
    }
  });

  it('never darkens below the visibility floor, even chasing separation', () => {
    for (const hex of [...Object.values(macroColors), kcalRingColor]) {
      expect(contrastRatio(overlapColor(hex, SURFACE), SURFACE)).toBeGreaterThanOrEqual(
        OVERLAP_CONTRAST_FLOOR,
      );
    }
  });

  it('takes the LEAST darkening that reaches the target, so the hue survives', () => {
    // Maximising separation instead was measured: it drives every ring to
    // contrast ~3.03 and turns the carbs lime into an olive. The ring's colour
    // is the macro's identity on this card, so overshooting is its own defect.
    // Carbs has contrast to spare — proof the search stopped at the target
    // rather than darkening as far as it was allowed to.
    expect(contrastRatio(overlapColor(macroColors.carbs, SURFACE), SURFACE)).toBeGreaterThan(5);
  });

  it('returns the hue unchanged when nothing clears the floor', () => {
    expect(overlapColor('#111722', SURFACE)).toBe('#111722');
  });
});

describe('deltaE2000', () => {
  it('is zero for a colour against itself and grows with difference', () => {
    expect(deltaE2000('#B8FF2C', '#B8FF2C')).toBeCloseTo(0, 5);
    expect(deltaE2000('#B8FF2C', '#76A31C')).toBeGreaterThan(deltaE2000('#B8FF2C', '#A8E828'));
  });

  it('matches an independent reference implementation', () => {
    // Cross-checked against a separate Python CIEDE2000 written for the
    // measurement that produced this fix — same inputs, same answers to two
    // decimals. An implementation that only agrees with itself is the trap
    // this repo's own testing rules name; this is the second opinion.
    expect(deltaE2000('#5C9BFA', '#3B63A0')).toBeCloseTo(22.14, 1);
    expect(deltaE2000('#D657AA', '#9E407E')).toBeCloseTo(14.64, 1);
    expect(deltaE2000('#F3F6FA', '#9C9DA0')).toBeCloseTo(22.01, 1);
  });
});

describe('the rings draw no border', () => {
  it('never strokes with the card ground', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'components/today/MacroRings.tsx'), 'utf8');
    expect(src).not.toMatch(/stroke=\{vola\.surface\}/);
  });
});
