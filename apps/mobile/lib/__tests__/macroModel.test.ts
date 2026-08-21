import { macroColors, monoMacroColors } from '../../constants/Colors';
import { MACRO_ORDER, macroArcs, macroRows, macroRowsFromTarget } from '../macroModel';

/**
 * The macro model — the one place the four macros' order, labels, colours and
 * rules are decided.
 *
 * The acceptance criterion this covers is *"macro colours are consistent
 * everywhere they appear — tiles, donut, and the macro rows"*. Consistency is
 * only guaranteed by there being one source, so what is asserted here is that
 * the source exists and that every producer reads it — a second copy in a
 * component would pass every visual check on the day it was written and drift
 * the first time one of them changed.
 *
 * The colours' contrast and colour-blind separation are NOT asserted here.
 * That is `scripts/validate_palette.mjs`'s job and it fails the build; a
 * duplicate of that arithmetic in jest would be a second implementation to keep
 * in step, which is the thing this file exists to argue against.
 */

const SUGGESTION = { protein_g: 205, fat_g: 75, carb_g: 90, fibre_g: 25 };
const BASIS = { protein_g_per_kg: 2.2, fat_g_per_kg: 0.8 };

describe('the four, in order', () => {
  it('is protein, fat, carbs, fibre — the order every rendering shares', () => {
    // The donut's third arc is the legend's third row because both walk this.
    // Reordering it here is a legitimate design change; reordering it in one
    // renderer is a bug, and this is what makes the difference visible.
    expect(MACRO_ORDER).toEqual(['protein', 'fat', 'carbs', 'fibre']);
  });

  it('gives every macro a colour from the palette, not a literal', () => {
    const rows = macroRows(SUGGESTION, BASIS);
    for (const r of rows) {
      // Mono mode swaps the whole set at module load, so either map is a
      // legitimate answer; a hex from neither means somebody hard-coded one.
      expect([macroColors[r.key], monoMacroColors[r.key]]).toContain(r.colour);
    }
  });

  it('has a distinct colour per macro', () => {
    const rows = macroRows(SUGGESTION, BASIS);
    expect(new Set(rows.map((r) => r.colour)).size).toBe(4);
  });
});

describe('macroRows', () => {
  it('carries the suggestion straight through, without reordering the numbers', () => {
    // The obvious bug this catches is fat and carbs swapped — both are plain
    // numbers, so nothing else would ever complain.
    expect(macroRows(SUGGESTION, BASIS).map((r) => [r.key, r.grams])).toEqual([
      ['protein', 205],
      ['fat', 75],
      ['carbs', 90],
      ['fibre', 25],
    ]);
  });

  it('states the per-kilogram rules for protein and fat', () => {
    const rows = macroRows(SUGGESTION, BASIS);
    expect(rows[0].rule).toBe('2.2 g per kg');
    expect(rows[1].rule).toBe('0.8 g per kg');
  });

  it('gives carbs and fibre their consequences rather than a coefficient', () => {
    const rows = macroRows(SUGGESTION, BASIS);
    expect(rows[2].rule).toBe('Whatever the calories leave');
    expect(rows[3].rule).toBe('A floor, not a ceiling');
  });

  it('states NO rule when there is no basis, rather than inventing one', () => {
    // A typed target has no derivation. Attaching the current one to it is the
    // lie `saveManual`'s `basis: null` already refuses to tell.
    expect(macroRows(SUGGESTION, null).every((r) => r.rule === null)).toBe(true);
  });

  it('keeps the four rows with no suggestion at all, valued as unknown', () => {
    const rows = macroRows(null, null);
    expect(rows).toHaveLength(4);
    // Null, never 0 — "we do not have this" is not "your plan has no protein".
    expect(rows.every((r) => r.grams === null)).toBe(true);
  });
});

describe('macroRowsFromTarget', () => {
  it('reads a stored target, keeping an absent fibre floor absent', () => {
    const rows = macroRowsFromTarget({
      kcal: 2000,
      protein_g: 180,
      carb_g: 200,
      fat_g: 70,
      fibre_g: null,
    } as never);
    expect(rows.map((r) => r.grams)).toEqual([180, 70, 200, null]);
  });
});

describe('macroArcs', () => {
  it('divides the ring by grams, in order, summing to one', () => {
    const arcs = macroArcs(macroRows(SUGGESTION, BASIS));
    expect(arcs.map((a) => a.key)).toEqual(['protein', 'fat', 'carbs', 'fibre']);
    const total = 205 + 75 + 90 + 25;
    expect(arcs[0].fraction).toBeCloseTo(205 / total, 6);
    expect(arcs.reduce((n, a) => n + a.fraction, 0)).toBeCloseTo(1, 9);
  });

  it('draws NOTHING when there is nothing to draw', () => {
    // Four equal quarters would be a picture of a split nobody has.
    expect(macroArcs(macroRows(null, null))).toEqual([]);
    expect(macroArcs(macroRows({ protein_g: 0, fat_g: 0, carb_g: 0, fibre_g: 0 }, null))).toEqual([]);
  });

  it('drops a zero macro rather than emitting a zero-width arc', () => {
    const arcs = macroArcs(macroRows({ ...SUGGESTION, fibre_g: 0 }, null));
    expect(arcs.map((a) => a.key)).toEqual(['protein', 'fat', 'carbs']);
    expect(arcs.reduce((n, a) => n + a.fraction, 0)).toBeCloseTo(1, 9);
  });

  it('never lets a negative figure eat another macro’s arc', () => {
    // The server should never send one; if it does, the ring must not render a
    // fraction above 1 for its neighbour, which would overdraw the circle.
    const arcs = macroArcs(macroRows({ ...SUGGESTION, fibre_g: -50 }, null));
    expect(arcs.every((a) => a.fraction >= 0 && a.fraction <= 1)).toBe(true);
    expect(arcs.reduce((n, a) => n + a.fraction, 0)).toBeCloseTo(1, 9);
  });
});
