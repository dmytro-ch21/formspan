/**
 * Seconds or minutes — the same relationship to a duration that kg/lb has to a
 * weight.
 *
 * **Everything is stored in seconds, always.** This is a presentation and input
 * transform and nothing else, for exactly the reason `lib/units.ts` spells out
 * for weight: a converted value in the database makes every historical row
 * ambiguous the moment somebody changes the setting, and `seconds` on
 * `LoggedSet` is what the API, the volume rollup and the progression rule all
 * read.
 *
 * The reason it exists at all: a 45-second plank and a 4-minute round are both
 * "a timed set", and one field cannot serve both. Typing `240` for four minutes
 * is the same small daily insult as converting kilograms in your head at the
 * moment you are trying to record a number — which is the problem the
 * per-exercise weight unit already solves.
 */

export type DurationUnit = 'seconds' | 'minutes';

export const DURATION_UNITS: { key: DurationUnit; label: string; detail: string }[] = [
  { key: 'seconds', label: 'Seconds', detail: 'planks, holds, sprints' },
  { key: 'minutes', label: 'Minutes', detail: 'rounds, carries, conditioning' },
];

/** The suffix an input field takes, so the field is never ambiguous. */
export function durationInputUnit(u: DurationUnit): string {
  return u === 'minutes' ? 'min' : 's';
}

/**
 * How much ±  moves the clock, by unit.
 *
 * Fifteen seconds is the right nudge on a plank and a rounding error on a
 * five-minute round, where the athlete is thinking in half-minutes. This is the
 * whole reason the unit reaches the timer rather than stopping at the input:
 * the number on the button has to mean something at the scale you are working
 * at.
 */
export function adjustStepFor(u: DurationUnit): number {
  return u === 'minutes' ? 30 : 15;
}

/**
 * Which unit a duration is naturally read in, when nobody has said.
 *
 * Two minutes is the boundary, and it is a judgement rather than a measurement:
 * below it people say "ninety seconds", above it they say "three minutes".
 * Only ever a DEFAULT — an explicit per-exercise choice always wins, which is
 * what {@link readDurationUnit} is for.
 */
export const MINUTES_FROM_SECONDS = 120;

export function defaultDurationUnit(seconds: number | null | undefined): DurationUnit {
  return seconds != null && seconds >= MINUTES_FROM_SECONDS ? 'minutes' : 'seconds';
}

/** Storage (seconds) → what an input field shows. */
export function toDisplayDuration(seconds: number, u: DurationUnit): number {
  if (u !== 'minutes') return Math.round(seconds);
  // Two decimals, so 45s round-trips through a minutes field as 0.75 rather
  // than collapsing to 0.8 and silently becoming 48s.
  return Math.round((seconds / 60) * 100) / 100;
}

/** What was typed → storage (seconds). */
export function fromDisplayDuration(v: number, u: DurationUnit): number {
  return Math.round(u === 'minutes' ? v * 60 : v);
}

/**
 * A duration as prose, at the scale its unit implies.
 *
 * Seconds read as `45s` because that is how a plank is written on a whiteboard.
 * Minutes read as a clock face — `3:00`, `1:30` — rather than as `1.5min`,
 * because a clock is what the athlete is about to watch count down and the two
 * should say the same thing.
 */
export function formatDuration(seconds: number | null | undefined, u: DurationUnit): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (u !== 'minutes') return `${s}s`;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * Per-exercise unit overrides, held on the device.
 *
 * Local rather than on the profile, and the same reasoning as the per-exercise
 * rest durations beside it in `lib/rest.ts`: the timer is mobile-only by the
 * platform rule, so there is no second client to keep in step, a server
 * round-trip would buy nothing, and it has to work in a basement gym.
 *
 * Note this deliberately does NOT follow the weight unit, which IS on the
 * profile (`getExerciseUnits`). Weight units are a fact about how an athlete
 * thinks and want to travel; whether a plank is written in seconds is a fact
 * about the plank.
 */
export const durationUnitKey = (exerciseID: string) => `dur:${exerciseID}`;

/**
 * A stored value, or null if there isn't a usable one.
 *
 * Null rather than the default, so a caller can tell "never chosen" from
 * "chosen, and it happens to be seconds" — the map on the session screen holds
 * only genuine overrides, and everything else falls through to
 * {@link defaultDurationUnit} against the prescription's own scale. Also guards
 * a value written by a build that offered a unit this one does not.
 */
export function parseDurationUnit(value: string | null): DurationUnit | null {
  return value === 'minutes' || value === 'seconds' ? value : null;
}

/**
 * What a keystroke in the timer-target field should do to the stored value.
 *
 * Three outcomes, not two, and the third is the one this exists for.
 *
 *  - **Empty** → write `null`. That is the deliberate route back to untimed,
 *    and it is unambiguous because an empty field is not on its way anywhere.
 *  - **A positive duration** → write it.
 *  - **Anything else** — zero, negative, or not a number yet → write NOTHING.
 *
 * The third case is the fix for a bug that made a sub-minute target impossible
 * to enter, and the mechanism is invisible at the call site. In minutes mode
 * `0` is the first character of `0.5`, and it converts to zero seconds, which
 * the server refuses (`seconds <= 0`) and so must never be stored. The obvious
 * reading — store `null` for anything invalid — is what broke it: `Field`
 * adopts an externally-changed value, so the store going to `null` makes the
 * field notice that `null` is not what its text parses to and overwrite the
 * text. The `0` is wiped and the `.5` lands in an empty box.
 *
 * Writing nothing leaves the stored value untouched, `Field` sees no change,
 * and the digits survive until they mean something. A `0` typed and then
 * abandoned leaves the previous target in place, which is the right way round:
 * the alternative is a row that syncs 400 or a countdown that fires instantly.
 *
 * Returned as a tagged result rather than `number | null | undefined` because
 * "write null" and "write nothing" are exactly the two states a nullable
 * number cannot tell apart, and confusing them is the whole bug.
 */
export type TimerTargetEdit = { write: false } | { write: true; seconds: number | null };

export function timerTargetEdit(text: string, u: DurationUnit): TimerTargetEdit {
  const t = text.trim();
  if (t === '') return { write: true, seconds: null };
  const raw = Number(t.replace(',', '.'));
  if (!Number.isFinite(raw)) return { write: false };
  const seconds = fromDisplayDuration(raw, u);
  return seconds > 0 ? { write: true, seconds } : { write: false };
}
