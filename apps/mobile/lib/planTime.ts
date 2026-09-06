/**
 * N126/#520: the display and entry half of `PlannedSession.timeOfDayMinutes`.
 *
 * Everything here is pure arithmetic over an integer — never a `Date`, never
 * `Intl`/`toLocaleTimeString`, and never anything that reads the device's
 * timezone. `timeOfDayMinutes` is a wall-clock reading with no zone attached
 * (see `lib/plan.ts`'s own comment on the field), and the one way to
 * reintroduce a timezone bug into a value that was designed to have none is
 * to round-trip it through a `Date` object on the way to the screen.
 */

/** The last legal value — 23:59. Mirrors the server's own CHECK constraint. */
export const MAX_TIME_OF_DAY_MINUTES = 1439;

/** Whether `n` is a legal minutes-since-local-midnight clock reading. */
export function validTimeOfDayMinutes(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_TIME_OF_DAY_MINUTES;
}

/**
 * "7:00 PM" from minutes-since-midnight — the display form the reference
 * Today design uses (`UP NEXT — Today • 7:00 PM`). Returns `null` for `null`
 * or an out-of-range input, so a caller can write `formatPlanTime(p.timeOfDayMinutes) ?? fallback`
 * without a separate presence check.
 */
export function formatPlanTime(minutes: number | null): string | null {
  if (minutes === null || !validTimeOfDayMinutes(minutes)) return null;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** A short, quiet quantity for "today at" comparisons — see `useWhenLabel`. */
export function minutesOfDayLocal(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * Three tap-once presets, in minutes-since-midnight — the fast path a
 * one-handed athlete uses instead of dialing in an exact time. Backed by the
 * SAME field a precise time would set: picking "Evening" writes 1080, not a
 * separate slot value, so nothing downstream needs to know these exist.
 */
export const TIME_OF_DAY_PRESETS: { label: string; minutes: number }[] = [
  { label: 'Morning', minutes: 7 * 60 }, // 7:00 AM
  { label: 'Midday', minutes: 12 * 60 }, // 12:00 PM
  { label: 'Evening', minutes: 18 * 60 }, // 6:00 PM
];

/** Clamp a hour/minute pair (each independently wrapped) into 0..1439. */
export function clampTimeOfDay(hour24: number, minute: number): number {
  const h = ((hour24 % 24) + 24) % 24;
  const m = ((minute % 60) + 60) % 60;
  return h * 60 + m;
}
