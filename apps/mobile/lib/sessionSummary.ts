import { formatDuration } from './history';
import { averagePaceSecPerKm } from './running';
import {
  contributesVolume,
  countsAsSet,
  sessionActiveSeconds,
  sessionDistanceMeters,
  totalWeightKg,
  type LoggedSet,
  type Session,
} from './sessions';
import { formatDistance, formatPace, formatVolume, type UnitSystem } from './units';

/**
 * The one-line summary under a logged session's name — "48 min · 14 sets ·
 * 4,120kg", or "32 min · 6.1 km · 5:15/km" for a run.
 *
 * ## Why this is a module rather than a fourth local copy
 *
 * This rule was written out three separate times before N548: `SessionRow` in
 * `app/session/history.tsx`, the day-detail rows in
 * `components/TrainingCalendar.tsx`, and (for the strength half only) the
 * resume card on Today. They already disagree — history's row has no running
 * branch at all, so a run there still reads "0 sets"-shaped even after N462
 * fixed exactly that on the calendar. Adding a fourth copy for Today's new
 * LOGGED rows would have guaranteed the divergence rather than merely risked
 * it, so the rule is written once here and the calendar now reads it.
 *
 * `app/session/history.tsx` is deliberately NOT converted in the same change:
 * its line leads with the session's DATE (a history list spanning months has
 * to) and it is a different sentence, not this one with a prefix. Folding it
 * in means deciding what that screen's line should say, which is a change to
 * a screen this ticket is not about.
 *
 * ## What each measure is, and why each can be absent
 *
 * **Nothing is ever fabricated as a zero.** A "0 sets" chip on a mat session
 * reads as an abandoned session rather than as a class, and "0kg" on a run
 * reads as a bug. Every entry below appears only when it exists, which is why
 * this returns a LIST for the caller to join rather than a fixed string.
 */

/**
 * Sets the athlete would say they did — the backend's own `countsAsSet` rule.
 *
 * A drop is part of the set above it and adds none; its work still counts in
 * {@link sessionVolumeKg} below. Lifted verbatim from the two copies this
 * replaces, both of which already carried this note.
 */
export function workingSetCount(sets: Pick<LoggedSet, 'completed' | 'set_type'>[]): number {
  return sets.filter(countsAsSet).length;
}

/**
 * Working tonnage, in kilograms.
 *
 * `totalWeightKg` returning `null` is #425's EXPLICITLY-UNRESOLVED state — an
 * offline exercise swap whose implement factor was not in the local catalog
 * yet. Left out of the sum rather than guessed, matching
 * `TrainingCalendar.tsx`'s own `sessionVolume`, which this is lifted from.
 */
export function sessionVolumeKg(sets: LoggedSet[]): number {
  let kg = 0;
  for (const set of sets) {
    if (contributesVolume(set) && set.weight_kg != null && set.reps != null) {
      const total = totalWeightKg(set);
      if (total != null) kg += total * set.reps;
    }
  }
  return kg;
}

/**
 * Wall-clock seconds between start and finish, or `null` while it is running.
 *
 * Wall-clock on purpose: this is "how long were you there", which is the
 * question a row in a day's list answers. It is deliberately NOT what
 * {@link sessionMeta} paces a run over — see there.
 */
export function sessionDurationSeconds(
  s: Pick<Session, 'started_at' | 'ended_at'>,
): number | null {
  if (!s.ended_at) return null;
  return (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
}

/**
 * The meta chips for one session, in reading order, absent ones omitted.
 *
 * Running takes a different second and third measure — distance and pace,
 * rather than sets and tonnage — because a run's local `session_sets` row
 * (written by `app/running/[id].tsx`'s `finish()`) carries distance and
 * duration against the seeded `run` exercise and no tonnage at all. Keyed on
 * the sport string for the same reason `sessionHref` is (see
 * `lib/startSession.ts`): nothing in the module registry distinguishes a
 * live-GPS-tracked discipline from a set-logged one.
 *
 * **Pace is not derived from the wall-clock duration.** The live tracking
 * screen excludes paused time from the `seconds` it writes on that set, so
 * pacing over `ended_at - started_at` would understate the pace of any run
 * that was ever paused — two different numbers for one run, one on the
 * tracking screen and another everywhere it is read back.
 * `sessionActiveSeconds` reads the identical gate as the distance sum, so the
 * two always describe the same set(s).
 */
export function sessionMeta(
  s: Pick<Session, 'sport' | 'sets' | 'started_at' | 'ended_at'>,
  units: UnitSystem,
): string[] {
  const secs = sessionDurationSeconds(s);
  const isRunning = s.sport === 'running';
  const distanceM = isRunning ? sessionDistanceMeters(s.sets) : 0;
  const activeSeconds = isRunning ? sessionActiveSeconds(s.sets) : 0;
  const paceSecPerKm =
    isRunning && distanceM > 0 && activeSeconds > 0
      ? averagePaceSecPerKm(distanceM, activeSeconds)
      : null;
  const kg = isRunning ? 0 : sessionVolumeKg(s.sets);
  const n = isRunning ? 0 : workingSetCount(s.sets);

  return [
    secs != null ? formatDuration(secs) : null,
    isRunning
      ? distanceM > 0
        ? formatDistance(distanceM, units)
        : null
      : n > 0
        ? `${n} ${n === 1 ? 'set' : 'sets'}`
        : null,
    isRunning
      ? paceSecPerKm != null
        ? formatPace(paceSecPerKm, units)
        : null
      : kg > 0
        ? formatVolume(kg, units)
        : null,
  ].filter((x): x is string => x !== null);
}
