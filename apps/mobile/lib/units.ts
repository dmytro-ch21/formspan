/**
 * Display units.
 *
 * The load-bearing rule, and the reason this file is small: **everything is
 * stored in kilograms and metres, always.** Units are a presentation and
 * input transform, nothing more.
 *
 * Storing converted values would make every historical row ambiguous the
 * moment someone changed the setting — was that 100 recorded as kg or lb? —
 * and it would silently break the progression rule, which compares weights
 * across sessions. So conversion happens at the last possible moment on the
 * way out, and the first possible moment on the way in.
 *
 * Duplicated in `apps/web/src/lib/units.ts` rather than shared, matching the
 * existing convention for `measuresFor` and friends: there is no cross-app
 * package yet, and inventing one for two functions costs more than it saves.
 */

export type UnitSystem = 'metric' | 'imperial';

export const UNIT_SYSTEMS: { key: UnitSystem; label: string; detail: string }[] = [
  { key: 'metric', label: 'Metric', detail: 'kilograms · metres' },
  { key: 'imperial', label: 'Imperial', detail: 'pounds · miles' },
];

const LB_PER_KG = 2.2046226218;
const M_PER_MILE = 1609.344;
const M_PER_YARD = 0.9144;

export function weightUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'lb' : 'kg';
}

/** Storage (kg) → what to show. */
export function toDisplayWeight(kg: number, u: UnitSystem): number {
  return u === 'imperial' ? round(kg * LB_PER_KG, 1) : round(kg, 2);
}

/** What was typed → storage (kg). */
export function fromDisplayWeight(v: number, u: UnitSystem): number {
  // Kept to 3 decimals so a pounds round-trip doesn't accumulate float dust
  // in the database, while still preserving 0.5 lb precision.
  return u === 'imperial' ? round(v / LB_PER_KG, 3) : v;
}

export function formatWeight(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  return `${trim(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

/**
 * Cumulative load — "volume" in the UI — which lives at a different order of
 * magnitude than a single set.
 *
 * `formatWeight` is right for "100kg" on a bar and wrong for a quarter of a
 * million: a block's volume through it reads `251147kg`, which nobody takes
 * in at a glance — least of all on a phone. Tonnes above 1000kg, separators
 * throughout.
 *
 * Deliberately not folded into `formatWeight`: abbreviating there would turn
 * every heavy single on the session screen into `0.2t`.
 */
/**
 * An estimate, rendered at the precision an estimate actually has.
 *
 * `formatWeight` keeps two decimals because a logged set is a measurement —
 * 62.55kg is what was on the bar. A one-rep max derived from a rep-max curve
 * is not, and "143.88kg" invites reading a modelled number as a measured one.
 * Rounded to whole display units: 144kg, 317lb.
 */
export function formatEstimate(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  return `${Math.round(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

export function formatVolume(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  if (u === 'metric') {
    // Rounded before the comparison, or 999.6 renders as "1,000kg".
    if (Math.round(kg) < 1000) return `${Math.round(kg).toLocaleString()}kg`;
    return `${(Math.round(kg / 100) / 10).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}t`;
  }
  // Pounds run an order of magnitude larger, so the same block that reads
  // 251.1t reads 553,684lb — the exact mouthful this function exists to
  // avoid, for the majority of the target market. Abbreviated past six
  // digits; short tons are avoided because "t" would then mean two things.
  const lb = Math.round(kg * LB_PER_KG);
  if (lb < 100_000) return `${lb.toLocaleString()}lb`;
  return `${(Math.round(lb / 100) / 10).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}k lb`;
}

/**
 * Distance switches unit by magnitude, in both systems — nobody says "0.02
 * miles" and nobody says "5000 metres" for a run.
 */
export function formatDistance(metres: number | null | undefined, u: UnitSystem): string {
  if (metres == null) return '—';
  if (u === 'imperial') {
    if (metres >= M_PER_MILE / 2) return `${trim(round(metres / M_PER_MILE, 2))} mi`;
    return `${trim(round(metres / M_PER_YARD, 0))} yd`;
  }
  if (metres >= 1000) return `${trim(round(metres / 1000, 2))} km`;
  return `${trim(round(metres, 0))} m`;
}

/** The unit a distance *input* takes — one unit, so the field is unambiguous. */
export function distanceInputUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'yd' : 'm';
}

export function toDisplayDistance(metres: number, u: UnitSystem): number {
  return u === 'imperial' ? round(metres / M_PER_YARD, 0) : round(metres, 0);
}

export function fromDisplayDistance(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * M_PER_YARD, 2) : v;
}

/**
 * Liquid volume — a daily tracker's millilitres, shown as ml or fl oz.
 *
 * **Not `formatVolume` above**, which already owns that word and means
 * cumulative barbell LOAD. The collision is real enough to be worth the
 * awkward name: a tracker card asking for "the volume" and getting tonnes is
 * exactly the kind of thing that compiles.
 *
 * Stored in millilitres, always, for the same reason weights are kilograms —
 * an athlete who flips the setting must not find last week's water rewritten.
 * The US fluid ounce (29.5735 ml), not the imperial one (28.4131): this app's
 * "imperial" is the American convention throughout (pounds, miles, yards), and
 * mixing the two ounces would put a 4% error into a number nobody would think
 * to question.
 */
const ML_PER_FL_OZ = 29.5735295625;

export function fluidUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'fl oz' : 'ml';
}

/** Storage (ml) → what to show. */
export function toDisplayFluid(ml: number, u: UnitSystem): number {
  return u === 'imperial' ? round(ml / ML_PER_FL_OZ, 1) : round(ml, 0);
}

/** What was typed → storage (ml). */
export function fromDisplayFluid(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * ML_PER_FL_OZ, 2) : v;
}

/**
 * A volume with its unit, promoted to litres past a litre in metric.
 *
 * "2000 ml" is a number you read digit by digit; "2 L" is one you take in. The
 * imperial side deliberately does NOT promote to US pints or quarts — an
 * athlete tracking water thinks in fluid ounces all the way up, and "62.5 fl
 * oz" stays comparable with the 8 fl oz glass beside it.
 */
export function formatFluid(ml: number | null | undefined, u: UnitSystem): string {
  if (ml == null) return '—';
  if (u === 'imperial') return `${trim(toDisplayFluid(ml, u))} fl oz`;
  if (Math.abs(ml) >= 1000) return `${trim(round(ml / 1000, 2))} L`;
  return `${trim(round(ml, 0))} ml`;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** Drops a trailing ".0" so 100 reads as "100", not "100.0". */
function trim(v: number): string {
  return String(v);
}
