/**
 * The four macros as one ordered, coloured, explainable set.
 *
 * N106's reference renders the same four things three times over — a row of
 * tiles at the top of the authority card, a four-segment donut, and a legend
 * beside it — and the acceptance criterion is that the colours are consistent
 * *everywhere they appear*. Three render sites reaching independently for a
 * colour map is exactly how three sites come to disagree, so the order, the
 * labels, the colours and the one-line rules all live here and the components
 * are dumb.
 *
 * Colour comes from `activeMacroColors`, never `macroColors` — the former is
 * the monochrome-aware one, and a component that reaches past it is the one
 * card in a black-and-white app that stays coloured.
 */

import { activeMacroColors, type MacroColor } from '@/constants/Colors';
import type { Basis, Suggestion } from '@/lib/nutritionApi';
import type { Target } from '@/lib/nutrition';
import { formatMacroCoefficient, type UnitSystem } from '@/lib/units';

export type MacroKey = MacroColor;

/**
 * The order every rendering uses, and it is the reference's.
 *
 * Protein first because it is the one the athlete is being asked to hit rather
 * than to land near; fibre last because it is a floor rather than a share.
 * The donut is drawn in this order too, so the legend's third row is the third
 * arc clockwise — which is the only thing making a legend and a ring one
 * object rather than two pictures.
 */
export const MACRO_ORDER: readonly MacroKey[] = ['protein', 'fat', 'carbs', 'fibre'] as const;

export const MACRO_LABEL: Record<MacroKey, string> = {
  protein: 'Protein',
  fat: 'Fat',
  carbs: 'Carbs',
  fibre: 'Fibre',
};

/** The colour, monochrome-aware. Every render site goes through this. */
export function macroColor(key: MacroKey): string {
  return activeMacroColors[key];
}

export type MacroRow = {
  key: MacroKey;
  label: string;
  colour: string;
  /** Grams. Null when the derivation could not produce one. */
  grams: number | null;
  /**
   * How this number was arrived at, in one line — "2.2g per kg", "Whatever the
   * calories leave". Null when there is no rule to state, which is the case for
   * a target somebody typed: it has no derivation, and inventing one is the
   * lie `saveManual`'s `basis: null` already refuses to tell.
   */
  rule: string | null;
};

/**
 * The four rows, from a suggestion and the basis behind it.
 *
 * `basis` may be null — a typed target has none — and the rules go with it
 * rather than being faked. The grams survive, because those are real either
 * way.
 */
export function macroRows(
  s: Pick<Suggestion, 'protein_g' | 'fat_g' | 'carb_g' | 'fibre_g'> | null,
  b: Pick<Basis, 'protein_g_per_kg' | 'fat_g_per_kg'> | null,
  // Defaults to metric so every existing caller — including every test in
  // this file's own suite — keeps behaving exactly as it did before N111
  // (#494), rather than every call site needing an update the same day the
  // parameter was added.
  units: UnitSystem = 'metric',
): MacroRow[] {
  return MACRO_ORDER.map((key) => ({
    key,
    label: MACRO_LABEL[key],
    colour: macroColor(key),
    grams: s ? gramsOf(s, key) : null,
    rule: b ? ruleOf(b, key, units) : null,
  }));
}

/** The same four rows for a target that is already in force. */
export function macroRowsFromTarget(t: Target | null): MacroRow[] {
  return MACRO_ORDER.map((key) => ({
    key,
    label: MACRO_LABEL[key],
    colour: macroColor(key),
    grams: t ? targetGramsOf(t, key) : null,
    // A stored target's own basis is not read back here — the screen shows the
    // live row's provenance in words instead, and a rule lifted from the
    // CURRENT derivation would describe a different number.
    rule: null,
  }));
}

function gramsOf(
  s: Pick<Suggestion, 'protein_g' | 'fat_g' | 'carb_g' | 'fibre_g'>,
  key: MacroKey,
): number {
  switch (key) {
    case 'protein':
      return s.protein_g;
    case 'fat':
      return s.fat_g;
    case 'carbs':
      return s.carb_g;
    case 'fibre':
      return s.fibre_g;
  }
}

function targetGramsOf(t: Target, key: MacroKey): number | null {
  switch (key) {
    case 'protein':
      return t.protein_g;
    case 'fat':
      return t.fat_g;
    case 'carbs':
      return t.carb_g;
    // Nullable on the row, and null is not zero: a target that never stated a
    // fibre floor is not a target of no fibre.
    case 'fibre':
      return t.fibre_g;
  }
}

/**
 * One line saying where the number came from.
 *
 * Protein and fat are per-bodyweight rules, so they carry their coefficient —
 * through `formatMacroCoefficient`, in the athlete's own units, resolved N111
 * (#494). Carbs are the remainder — deliberately phrased as a consequence
 * rather than as a rule, because that is what they are. Fibre is a floor, and
 * saying so is what stops it being read as a cap somebody is failing to stay
 * under.
 */
function ruleOf(
  b: Pick<Basis, 'protein_g_per_kg' | 'fat_g_per_kg'>,
  key: MacroKey,
  units: UnitSystem,
): string {
  switch (key) {
    case 'protein':
      return formatMacroCoefficient(b.protein_g_per_kg, units);
    case 'fat':
      return formatMacroCoefficient(b.fat_g_per_kg, units);
    case 'carbs':
      return 'Whatever the calories leave';
    case 'fibre':
      return 'A floor, not a ceiling';
  }
}

/**
 * The donut's arcs.
 *
 * **By grams, and the section says so out loud** — the reference's `g per day`
 * pill is not decoration, it is what makes this ring honest. An energy donut
 * would be the obvious alternative and is unavailable: fibre is a carbohydrate,
 * so protein + fat + carbs + fibre is not a partition of the calories and a
 * four-slice energy ring would count some of them twice. By grams the ring is a
 * picture of the four numbers listed beside it and of nothing else, which is a
 * claim it can actually keep. The `MACROS` explanation says the same thing in
 * words, for anyone who wonders.
 *
 * Returns fractions of the whole in {@link MACRO_ORDER}, so a caller can lay
 * arcs end to end without re-deriving the total. Empty when there is nothing to
 * draw — an all-zero set returns no segments rather than four zero-width arcs,
 * because a ring drawn from nothing is a ring claiming something.
 */
export function macroArcs(rows: readonly MacroRow[]): { key: MacroKey; colour: string; fraction: number }[] {
  const total = rows.reduce((n, r) => n + Math.max(0, r.grams ?? 0), 0);
  if (total <= 0) return [];
  return rows
    .map((r) => ({ key: r.key, colour: r.colour, fraction: Math.max(0, r.grams ?? 0) / total }))
    .filter((a) => a.fraction > 0);
}
