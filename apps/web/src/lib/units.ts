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
 * Duplicated in `apps/mobile/lib/units.ts` rather than shared, matching the
 * existing convention for `measuresFor` and friends: there is no cross-app
 * package yet, and inventing one for two functions costs more than it saves.
 */

export type UnitSystem = "metric" | "imperial";

export const UNIT_SYSTEMS: { key: UnitSystem; label: string; detail: string }[] = [
  { key: "metric", label: "Metric", detail: "kilograms · metres" },
  { key: "imperial", label: "Imperial", detail: "pounds · miles" },
];

const LB_PER_KG = 2.2046226218;
const M_PER_MILE = 1609.344;
const M_PER_YARD = 0.9144;

export function weightUnit(u: UnitSystem): string {
  return u === "imperial" ? "lb" : "kg";
}

/** Storage (kg) → what to show. */
export function toDisplayWeight(kg: number, u: UnitSystem): number {
  return u === "imperial" ? round(kg * LB_PER_KG, 1) : round(kg, 2);
}

/** What was typed → storage (kg). */
export function fromDisplayWeight(v: number, u: UnitSystem): number {
  // Kept to 3 decimals so a pounds round-trip doesn't accumulate float dust
  // in the database, while still preserving 0.5 lb precision.
  return u === "imperial" ? round(v / LB_PER_KG, 3) : v;
}

export function formatWeight(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return "—";
  return `${trim(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

/**
 * Cumulative load — "volume" in the UI — which lives at a different order of
 * magnitude than a single set.
 *
 * `formatWeight` is right for "100kg" on a bar and wrong for a quarter of a
 * million: a training block's volume rendered by it reads `251147kg`, which
 * is a number nobody can take in at a glance. Tonnes above 1000kg, and
 * thousands separators throughout — `251.1t` and `553,905lb` are both read
 * instantly, which is the entire job of a headline stat.
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
  if (kg == null) return "—";
  return `${Math.round(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

export function formatVolume(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return "—";
  if (u === "metric") {
    // Rounded before the comparison, or 999.6 renders as "1,000kg" — a
    // thousand kilograms written in the unit the next bracket abbreviates.
    if (Math.round(kg) < 1000) return `${Math.round(kg).toLocaleString()}kg`;
    // One decimal is the useful precision at this scale — nobody makes a
    // decision on the last 100kg of a training block.
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
  if (metres == null) return "—";
  if (u === "imperial") {
    if (metres >= M_PER_MILE / 2) return `${trim(round(metres / M_PER_MILE, 2))} mi`;
    return `${trim(round(metres / M_PER_YARD, 0))} yd`;
  }
  if (metres >= 1000) return `${trim(round(metres / 1000, 2))} km`;
  return `${trim(round(metres, 0))} m`;
}

/** The unit a distance *input* takes — one unit, so the field is unambiguous. */
export function distanceInputUnit(u: UnitSystem): string {
  return u === "imperial" ? "yd" : "m";
}

export function toDisplayDistance(metres: number, u: UnitSystem): number {
  return u === "imperial" ? round(metres / M_PER_YARD, 0) : round(metres, 0);
}

export function fromDisplayDistance(v: number, u: UnitSystem): number {
  return u === "imperial" ? round(v * M_PER_YARD, 2) : v;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** Drops a trailing ".0" so 100 reads as "100", not "100.0". */
function trim(v: number): string {
  return String(v);
}
