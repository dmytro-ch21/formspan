import { fromDisplayFluid, toDisplayFluid, type UnitSystem } from './units';
import type { TrackerUnit } from './trackerModel';

/**
 * The correction screen's one field, as pure functions — N437.
 *
 * An amount is shown in the athlete's own unit and stored in the tracker's, and
 * the two meet here rather than in the screen so the round trip can be tested.
 * It follows `TrackerForm`'s `displayIncrement`/`readDraft` rule for the same
 * reason: `toDisplayFluid` rounds to 0.1 fl oz, so an imperial athlete who opens
 * a 250 ml glass and saves without typing would store 251.37 ml. An untouched
 * field therefore hands back the stored number itself, and reports that nothing
 * changed, so the screen writes nothing and owes the server nothing.
 */

/** What the field shows for a stored amount. Volumes follow the unit preference. */
export function displayAmount(unit: TrackerUnit, amount: number, units: UnitSystem): string {
  return unit === 'ml' ? String(toDisplayFluid(amount, units)) : String(amount);
}

export type AmountRead = { amount: number; changed: boolean } | { error: string };

/**
 * Parse what the athlete typed back into the tracker's unit.
 *
 * `original` is the stored amount. Text that still reads exactly what
 * `displayAmount` put there is the stored amount, untouched.
 */
export function readAmount(
  text: string,
  unit: TrackerUnit,
  original: number,
  units: UnitSystem,
): AmountRead {
  const typed = text.trim();
  if (typed === displayAmount(unit, original, units)) return { amount: original, changed: false };
  const n = Number(typed);
  if (typed === '' || !Number.isFinite(n) || n <= 0) {
    return { error: 'Enter an amount greater than zero.' };
  }
  const amount = unit === 'ml' ? fromDisplayFluid(n, units) : n;
  return { amount, changed: amount !== original };
}
