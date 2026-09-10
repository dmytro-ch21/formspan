import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEFAULT_RINGS,
  OVERTAKE_CONTRAST_FLOOR,
  OVERTAKE_RED,
  OVERTAKE_RAMP_STEPS,
  RING_KEYS,
  contrastRatio,
  deltaE2000,
  overtakeEnd,
  overtakeRamp,
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
 * N554/#1025 — a ring past target fades into darker, redder ink as the
 * overtake grows.
 *
 * The athlete: *"lets do an effect where the ring starts to overlap we do a
 * gradient getting darker and darker and in that color add a little of red so
 * its like a sign of overtake."*
 *
 * The property under test is not "it looks nice" — it is that the ramp is
 * MONOTONIC, ends red-shifted and darker, and never darkens any ring below
 * the floor at which it stops being visible on the card.
 */
const SURFACE = vola.surface;
/** Each ring with the tint it is actually drawn with — only kcal is red. */
const RAMPS: [string, boolean][] = [
  ...Object.values(macroColors).map((h): [string, boolean] => [h, false]),
  [kcalRingColor, true],
];

describe('overtakeRamp — the colour carries how far past target', () => {
  it('darkens monotonically from start to end, tinted or not', () => {
    for (const [hex, tint] of RAMPS) {
      const ramp = overtakeRamp(hex, SURFACE, tint);
      const contrasts = ramp.map((c) => contrastRatio(c, SURFACE));
      // Against a DARK card, less light means less contrast — so a ramp that
      // genuinely darkens has strictly falling contrast along its length.
      const falling = contrasts.every((c, i) => i === 0 || c <= contrasts[i - 1] + 1e-9);
      expect({ hex, falling }).toEqual({ hex, falling: true });
    }
  });

  it('never starts identical to the ink underneath it', () => {
    // At 12 o'clock the second lap sits directly on the first. A ramp that
    // began at the base hue would be invisible exactly where the overtake
    // begins, which is the moment it most needs to register.
    for (const [hex, tint] of RAMPS) {
      expect(overtakeRamp(hex, SURFACE, tint)[0]).not.toBe(hex);
    }
  });

  it('ends red-shifted — the far end is perceptually nearer red than the base', () => {
    // A red/blue channel RATIO was tried first and is wrong for a hue that is
    // already warm: fat `#CAA021` has r/b 6.12, higher than the deep red
    // anchor's own 5.92, so mixing toward red LOWERS its ratio while plainly
    // moving it toward red. Perceptual distance to the anchor is the claim
    // actually being made, and it holds for warm and cool hues alike.
    expect(deltaE2000(overtakeEnd(kcalRingColor, SURFACE, true), OVERTAKE_RED)).toBeLessThan(
      deltaE2000(kcalRingColor, OVERTAKE_RED),
    );
  });

  it('W25 — the macros darken WITHOUT the red', () => {
    // The athlete's correction after the first cut tinted all four: "only
    // apply the red to calories, not the other macros." Red is a judgement
    // that going over is bad — true of a calorie budget, false of protein and
    // fibre, where over is usually the point. Colouring a good day as a
    // problem is the guilt-in-mechanics the no-shame rule forbids.
    //
    // The test is HUE, not distance-to-red, and the difference caught a bad
    // assertion twice. Darkening alone moves a colour NEARER the deep red
    // anchor in ΔE — measured, every macro drops 7–29 just by losing light,
    // because the anchor is itself dark. Distance to red therefore cannot
    // tell a tint from a dim. An untinted end is a pure channel scale, so its
    // channel RATIOS are unchanged; only its lightness moved.
    const ratios = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      return [r / Math.max(1, g), g / Math.max(1, b)];
    };
    for (const hex of Object.values(macroColors)) {
      const end = overtakeEnd(hex, SURFACE, false);
      const [before, after] = [ratios(hex), ratios(end)];
      expect(after[0]).toBeCloseTo(before[0], 1);
      expect(after[1]).toBeCloseTo(before[1], 1);
      // …and it did genuinely darken, so the gradient still carries magnitude.
      expect(contrastRatio(end, SURFACE)).toBeLessThan(contrastRatio(hex, SURFACE));
    }
    // The calorie ring is the one that DOES shift hue.
    const kcalEnd = overtakeEnd(kcalRingColor, SURFACE, true);
    expect(ratios(kcalEnd)[0]).not.toBeCloseTo(ratios(kcalRingColor)[0], 1);
  });

  it('keeps even the darkest step above the visibility floor', () => {
    for (const [hex, tint] of RAMPS) {
      const ramp = overtakeRamp(hex, SURFACE, tint);
      const darkest = Math.min(...ramp.map((c) => contrastRatio(c, SURFACE)));
      expect({ hex, ok: darkest >= OVERTAKE_CONTRAST_FLOOR }).toEqual({ hex, ok: true });
    }
  });

  it('separates end from base by more than the palette gate asks of two colours', () => {
    // ΔE 15 is validate_palette.mjs's floor for "these are different
    // colours". Fibre is the tightest at 15.90; every other ring clears it by
    // a wide margin.
    // Fibre is the tightest at 12.80 untinted — it runs out of room against
    // the visibility floor before the others do, and is the number this bound
    // is set by. Every other ring clears it by a wide margin.
    for (const [hex, tint] of RAMPS) {
      expect(deltaE2000(hex, overtakeEnd(hex, SURFACE, tint))).toBeGreaterThanOrEqual(12);
    }
    expect(deltaE2000(kcalRingColor, overtakeEnd(kcalRingColor, SURFACE, true))).toBeGreaterThan(15);
  });

  it('has the step count the ring is drawn with', () => {
    expect(overtakeRamp(macroColors.carbs, SURFACE, false)).toHaveLength(OVERTAKE_RAMP_STEPS);
  });
});

describe('deltaE2000', () => {
  it('is zero against itself and grows with difference', () => {
    expect(deltaE2000('#B8FF2C', '#B8FF2C')).toBeCloseTo(0, 5);
    expect(deltaE2000('#B8FF2C', '#76A31C')).toBeGreaterThan(deltaE2000('#B8FF2C', '#A8E828'));
  });

  it('matches an independent reference implementation', () => {
    // Cross-checked against a separate Python CIEDE2000 written for the
    // measurements these designs were chosen from. An implementation that
    // only agrees with itself is the trap this repo names for stubbed
    // providers, pointed at arithmetic.
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

  it('W25 — asks for the red tint on the CALORIE ring and no other', () => {
    // The library tests above prove `overtakeEnd(hex, surface, tint)` does the
    // right thing for either value of `tint`. They say nothing about which
    // ring the screen passes `true` for — and a mutation swapping `kcal` for
    // `protein` left every one of them green. That is the same shape as W21's
    // prune landing on the wrong branch of a mount effect: a correct function,
    // called wrongly, with a suite that cannot see the call site.
    //
    // Asserted at the source because there is no component test for this card
    // (`apps/mobile/lib/__tests__` is deliberately logic-only), same as
    // `hrReportWiring.test.ts` does for the HR screens.
    const src = readFileSync(join(__dirname, '..', '..', 'components/today/MacroRings.tsx'), 'utf8');
    const call = src.match(/overtakeRamp\([^)]*\)/);
    expect(call).not.toBeNull();
    expect(call![0]).toContain("reading.key === 'kcal'");
  });
});
