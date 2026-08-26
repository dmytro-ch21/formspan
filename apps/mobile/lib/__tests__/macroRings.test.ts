import {
  DEFAULT_RINGS,
  RING_KEYS,
  parseRings,
  readRings,
  serialiseRings,
  sweepFor,
} from '../macroRings';
import type { Macros, Target } from '../nutrition';

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
