import { randomUUID } from 'expo-crypto';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

import { ApiError, parseRetryAfterMs } from './apiError';
import { formatDuration, type DurationUnit } from './duration';
import type { Exercise } from './exercises';
import { isDualMode, setModeOf } from './setMode';
import { newTraceId, traceparent } from './trace';
import { formatDistance, formatWeight, type UnitSystem } from './units';
import type { WorkoutItem } from './workouts';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * How the implement was held for one set.
 *
 * A property of the SET, not of the exercise — you might press neutral today
 * and regular next week, or switch on the last set because the first three
 * hurt. A catalog row per grip could express neither — it would multiply the
 * 762-row catalog toward 3,000 — and would split one exercise's history in two.
 *
 * `mixed` and `hook` joined in #266. Before that the list held four and the
 * picker was withheld from hinges, carries and olympic lifts — 93 of 762
 * exercises, and the ones where grip matters most — because a hinge that could
 * only answer `regular` would collect a false entry rather than a missing one.
 * Which values are offered where now lives in `gripsFor`.
 */
export type Grip =
  | 'regular'
  | 'neutral'
  | 'reverse'
  | 'angled'
  | 'mixed'
  | 'hook';

/** Ordered by how often they are used, so the common answer is the first tap. */
export const GRIPS: { key: Grip; label: string }[] = [
  { key: 'regular', label: 'Regular' },
  { key: 'neutral', label: 'Neutral' },
  { key: 'reverse', label: 'Reverse' },
  { key: 'angled', label: 'Angled' },
  { key: 'mixed', label: 'Mixed' },
  { key: 'hook', label: 'Hook' },
];

/**
 * Which grips to OFFER for a movement — mirrors the server's `GripsFor`.
 *
 * Two subsets look wrong until you count the catalog, so do not "tidy" them:
 * 20 of the 55 hinge rows are kettlebell, dumbbell or hex-bar, and 12 of the 25
 * olympic rows are kettlebell (11) or dumbbell (1) — none of which hook-grips
 * anything. `mixed` is on hinges ALONE, because you do not mix-grip a snatch.
 *
 * (These numbers were wrong here for two PRs: "22 of 25" counted rows NAMED
 * clean or snatch, not kettlebell/dumbbell ones. They were corrected in the Go
 * mirror and missed here, which is the duplication N16 exists to delete.)
 *
 * This mapping is duplicated from Go rather than fetched, exactly as
 * `gripApplies` was before it. That is a known drift risk and is filed rather
 * than hidden: the API could carry the list per exercise, which would also mean
 * a future grip needs no app release. See N16.
 */
export function gripsFor(movementPattern: string | undefined): Grip[] {
  switch (movementPattern) {
    case 'horizontal_push':
    case 'horizontal_pull':
    case 'vertical_push':
    case 'vertical_pull':
    case 'isolation':
      return ['regular', 'neutral', 'reverse', 'angled'];
    case 'hinge':
      return ['regular', 'neutral', 'mixed', 'hook'];
    case 'carry':
    case 'olympic':
      return ['regular', 'neutral', 'hook'];
    default:
      return [];
  }
}

/**
 * The grip chips to show: the movement's own subset, plus whatever this set
 * already holds if that is not in it.
 *
 * The second half is the UI end of #256's rule. The server decides how many
 * grips exist, so a set can legitimately carry a value this build's subset does
 * not list — a newer server's grip, or one recorded on a movement whose subset
 * has since changed. Rendering only the subset would leave that grip invisible
 * AND unclearable: the athlete can see it in the summary line but has no chip
 * to tap, so the one way back to "unrecorded" is gone. Showing it appends
 * rather than replaces, so the common answers stay in their usual positions.
 */
export function offeredGrips(
  exercise: { movement_pattern?: string; offered_grips?: string[] } | undefined,
  current: Grip | null | undefined,
): { key: Grip; label: string }[] {
  const keys = gripsToOffer(exercise);
  const shown = keys.map(
    (k) => GRIPS.find((g) => g.key === k) ?? { key: k, label: k },
  );
  if (current && !keys.includes(current)) {
    shown.push(GRIPS.find((g) => g.key === current) ?? { key: current, label: current });
  }
  return shown;
}

/**
 * The server's answer, or this build's guess when the server has not given one.
 *
 * The subsets are decided server-side now and shipped on the exercise
 * (`offered_grips`, N16), because this table existed in three hand-maintained
 * copies — Go, here, and `apps/web` — policed by a Python parity script. The
 * numbers in this file's own comment about it were wrong for two PRs.
 *
 * **`gripsFor` survives only as the OFFLINE FALLBACK**, and only for exercises
 * cached before the field existed. Those rows are real: `exercise_cache` stores
 * the whole API object, so the field appears on the next catalog fetch, but an
 * athlete who last synced before this shipped and then walks into a basement gym
 * has a catalog without it. Hiding the picker for them would be a regression
 * they cannot explain; showing this build's last known answer is wrong only if
 * the server has since changed its mind, and it self-heals on the next fetch.
 *
 * Which is why the distinction below is not truthiness: an empty array is the
 * server SAYING no grips apply, and must not be mistaken for "the server has
 * not said".
 *
 * It is `Array.isArray` rather than `!== undefined` for a reason review found.
 * The type says `string[] | undefined`, but nothing validates network JSON or
 * the `payload_json` blob it was cached from — so a `null` can reach here at
 * runtime, and `!== undefined` would hand it straight to `keys.map(...)` and
 * crash the session screen. Worse, a bad payload is CACHED, so the crash would
 * survive going offline. Today's server provably cannot send it (`scanExercise`
 * substitutes `[]`), which is why this is belt and braces rather than a fix —
 * but the cost is one word and the failure mode is a screen an athlete cannot
 * open mid-workout.
 */
function gripsToOffer(
  exercise: { movement_pattern?: string; offered_grips?: string[] } | undefined,
): Grip[] {
  if (Array.isArray(exercise?.offered_grips)) return exercise.offered_grips as Grip[];
  return gripsFor(exercise?.movement_pattern);
}

/*
  `gripApplies` used to live here — the emptiness of the offer, as a named
  boolean. It is gone, and for the reason this whole change is about: it had no
  production caller. Both pickers gate on `offeredGrips(...).length > 0`, which
  is not the same question (see the session screen's note — the offer includes a
  grip the set already holds, so it can be non-empty where the subset is empty,
  and that difference is what keeps a stray grip clearable).

  Deleting Go's `GripApplies` for exactly this and keeping the TypeScript one
  would have been the inconsistency, so it went too. Raised in review.
*/

export type SetType = 'warmup' | 'working' | 'backoff' | 'drop' | 'amrap' | 'failure';

export const SET_TYPES: { key: SetType; label: string; short: string }[] = [
  { key: 'warmup', label: 'Warm-up', short: 'W' },
  { key: 'working', label: 'Working', short: '' },
  { key: 'backoff', label: 'Back-off', short: 'B' },
  { key: 'drop', label: 'Drop', short: 'D' },
  { key: 'amrap', label: 'AMRAP', short: 'A' },
  { key: 'failure', label: 'To failure', short: 'F' },
];

export type LoggedSet = {
  exercise_id: string;
  position: number;
  set_type: SetType;
  reps: number | null;
  weight_kg: number | null;
  seconds: number | null;
  distance_m: number | null;
  /**
   * How many of `reps` somebody else helped with — a spotter, a band, an
   * assisted-pull-up machine.
   *
   * `reps` holds the FULL count, assisted included, so every volume figure
   * reads what it always did. `soloReps(set)` is the number worth progressing
   * against: "225 for 5 then 3 with a spotter" is 8 reps of work and 5 of
   * capability.
   *
   * **null is UNRECORDED and 0 is "none of them"**, and they must stay
   * distinguishable all the way to the server — nobody should have to answer
   * this on every set, and treating absent as 0 would claim every set logged
   * before the field existed was unaided.
   *
   * Optional on the type so older cached rows parse. It IS sent on writes, and
   * has to be: the server replaces a session's sets wholesale, so a shape that
   * omits it wipes the column on the first edit.
   */
  assisted_reps?: number | null;
  /** Reps in reserve. 0 is meaningful — nothing left in the tank. */
  rir: number | null;
  /** 1–10, half steps. RPE 8 is roughly 2 RIR; record whichever you think in. */
  rpe: number | null;
  notes: string;
  /**
   * How many implements of `weight_kg` were moved: 1 for a barbell, a machine
   * or one kettlebell in two hands; 2 for a PAIR of dumbbells.
   *
   * SERVER-SENT — derived from the exercise's `load_mode`, which is a property
   * of the movement, so nothing here may invent one. It IS round-tripped on a
   * write (`replaceSets` PUTs stored sets verbatim) and the API ignores it:
   * `insertSets` has a fixed column list, and every write responds from a fresh
   * read. So the value a client holds is always catalog-derived — but that
   * rests on the server continuing to ignore it, which is why the contract
   * marks it response-only rather than leaving it to this comment.
   *
   * THREE STATES, and collapsing any two of them is the bug (#425):
   *
   *  - a NUMBER is a known factor — from the server, or looked up locally
   *    from the exercise catalog after an offline swap (see `swapExercise`).
   *  - `undefined` is the LEGACY default: an older response, or any set
   *    logged before the server started sending a factor at all. Reads as
   *    1 — under-reporting a dumbbell set is a smaller lie than erasing its
   *    volume, and this is the one case where that guess is the best
   *    available answer, because nothing on the device could ever resolve it.
   *  - `null` is EXPLICITLY UNRESOLVED — an offline swap whose new exercise's
   *    `implements` was not in the local catalog (a pre-payload cache row).
   *    Unlike `undefined`, resolving this IS possible, imminently, on the
   *    next sync — so guessing 1 here would be the exact "reports half its
   *    eventual tonnage" defect #425 was filed for. `totalWeightKg`
   *    returns `null` rather than a number, and a caller must not display a
   *    tonnage it computed from one.
   */
  load_factor?: number | null;

  /**
   * How the implement was held. `undefined`/null is UNRECORDED, and that is
   * NOT `regular` — every set logged before this field existed chose no grip,
   * and showing them as overhand would assert training that never happened.
   *
   * Sent on writes, and has to be: the server replaces a session's sets
   * wholesale, so a shape that omits it wipes the column on the first edit.
   * Optional on the type so rows cached by an older build still parse.
   */
  grip?: Grip | null;

  /**
   * Done. The trigger for progressive volume — the summary counts what's
   * been performed, not what's been planned, so the header climbs as you
   * work rather than starting at the plan's total.
   */
  completed: boolean;

  /**
   * The real moment this set was actually completed — N490/#851 — stamped
   * with `new Date().toISOString()` at the exact tap that flips `completed`
   * to `true` (`toggleDone`/`recordTimedSet` in the session screen), never
   * derived later from when the session happened to be saved.
   *
   * That distinction is the whole point. The server replaces a session's
   * whole set list on every save (`replaceSets`), so a timestamp assigned
   * at SAVE time would be identical across every set in the session —
   * exactly the failure `created_at` had, and the reason this field exists.
   *
   * Cleared back to `null` whenever `completed` is un-ticked: an un-ticked
   * set is a correction ("that didn't happen" or "not yet"), and a stale
   * timestamp surviving on a set that no longer claims to be done would be
   * the wrong kind of evidence for anything windowing heart rate against it
   * — `null`/`false` stay paired, the same way `completed: false` on a
   * template set has never carried a stray weight nobody entered.
   *
   * `null` is UNRECORDED — every set completed before this field existed,
   * and any set entered as an after-the-fact reflection rather than ticked
   * live during the session. Optional on the type so a row cached by an
   * older build still parses; sent explicitly on every write (`null` when
   * unrecorded) for the same "the server replaces the whole row" reason
   * `grip`/`assisted_reps` already are.
   */
  performed_at?: string | null;
};

/**
 * What the athlete meant this session to be, decided by them — never
 * inferred from what they actually lifted (N474).
 *
 * This is what closes the "a deliberately lighter session became my new
 * baseline" bug: the progression rule used to have no way to tell a
 * light/deload session apart from a normal one, so its top set became the
 * next suggestion's evidence in exactly the way a normal session's would.
 * `light`/`deload` sessions still count fully toward volume, history and
 * exercise stats — the ONE thing intent changes is which sessions
 * `GET /v1/sessions/suggestions` reads as evidence.
 *
 * `normal` is the default and the common case — every session logged before
 * this field existed is `normal`, which is the only reading that doesn't
 * retroactively change what an old suggestion meant.
 */
export type SessionIntent = 'normal' | 'light' | 'deload';

/** `SessionIntent`, labelled for the session-start picker. */
export const SESSION_INTENTS: { key: SessionIntent; label: string }[] = [
  { key: 'normal', label: 'Normal' },
  { key: 'light', label: 'Light' },
  { key: 'deload', label: 'Deload' },
];

export type Session = {
  id: string;
  user_id: string;
  workout_id: string | null;
  sport: string;
  name: string;
  intent: SessionIntent;
  started_at: string;
  ended_at: string | null;
  notes: string;
  sets: LoggedSet[];
  created_at: string;
  updated_at: string;
};

/**
 * The outcomes of the progression rule.
 *
 * The first four are the double-progression cycle proper; the rest are the
 * cases where the rule declines to advance and says why. Branch on these —
 * never pattern-match `reason`, which is prose and may change.
 *
 * Kept identical to apps/web's copy on purpose: the rule itself lives only on
 * the server, and these are the names it emits.
 */
export type SuggestionCode =
  /** Same load, one more rep — the first half of double progression. */
  | 'add_reps'
  /** Top of the rep range hit on every set: load moves, reps reset. */
  | 'add_load'
  /** Stalled three sessions at one load: back off ~10% and re-approach. */
  | 'deload'
  /** The range isn't finished at this load yet. Repeat it. */
  | 'hold'
  | 'no_history'
  | 'not_applicable'
  | 'repeat_hard'
  | 'repeat_unknown_effort'
  | 'repeat_stale'
  /**
   * N473/#812, behind `new_recommendation_engine` — a set logged both an RIR
   * and an RPE and they imply materially different reserve. No `target_*`
   * accompanies this: the server is declining to guess which reading is
   * right rather than letting RIR silently win, same reasoning as `abstain`.
   */
  | 'effort_conflict'
  /**
   * N473/#812 — the evidence is ambiguous rather than simply absent
   * (`repeat_unknown_effort` already covers "no effort recorded at all").
   * No `target_*` here either — an honest "can't tell" carries no guessed
   * number.
   */
  | 'abstain'
  /**
   * History exists, but every reachable session was tagged `light`/`deload`
   * — genuinely no normal-intensity evidence to build a suggestion from
   * (N474). Distinct from `no_history`: something WAS logged, repeatedly,
   * and none of it counts as evidence of capacity.
   */
  | 'no_recent_normal_session';

/**
 * Flags when today's own already-logged working sets disagree with the
 * standing prescription above — see N191. A separate code from
 * `SuggestionCode` on purpose: `code`/`reason`/`target_weight_kg`/
 * `target_reps` above stay a pure function of history, exactly as before
 * N191, and this is the note layered on top, never a silent rewrite of them.
 */
export type InSessionSignalCode = 'in_session_above' | 'in_session_below';

/**
 * The in-session note itself, present only when today's own working sets for
 * this exercise average meaningfully above or below `target_weight_kg`. Carries
 * its own `code`/`reason` for the same "argue with the number" reason `Suggestion`
 * does.
 */
export type InSessionSignal = {
  code: InSessionSignalCode;
  reason: string;
  average_weight_kg: number;
  working_sets: number;
};

/** The rep window a lift progresses inside before load moves. */
export type RepRange = { low: number; high: number };

/**
 * What to load today and for how many reps, derived from what you actually
 * did last time.
 *
 * The evidence travels with the recommendation on purpose — `last_*` is
 * always populated when there is history, even when the answer is "repeat
 * it". A number you can check beats a number you have to trust, and it is
 * the difference between a recommendation and an oracle.
 *
 * `last_weight_kg`, `last_reps`, `last_rir` and `last_rpe` all describe the
 * same single top set and are only meaningful together. `last_min_reps` /
 * `last_max_reps` are the spread across every working set.
 */
export type Suggestion = {
  exercise_id: string;
  code: SuggestionCode;
  reason: string;

  /** The prescription. Null when the exercise isn't loaded in weight. */
  target_weight_kg: number | null;
  target_reps: number | null;
  rep_range: RepRange;

  last_performed_at: string | null;
  last_weight_kg: number | null;
  last_reps: number | null;
  last_rir: number | null;
  last_rpe: number | null;
  last_min_reps: number | null;
  last_max_reps: number | null;
  working_sets: number;
  /** Consecutive recent sessions at this same load — the stall signal. */
  sessions_at_load: number;
  /** Every working set finished at or above the target reserve. */
  hit_target_effort: boolean;

  /** What the last top set implies you could lift once, effort included. */
  estimated_1rm_kg: number | null;
  /** The highest estimate anywhere in your history for this exercise. */
  best_1rm_kg: number | null;

  /**
   * Set when today's own already-logged working sets for this exercise
   * diverge meaningfully from `target_weight_kg` above — see N191. Null
   * covers "nothing logged today yet" and "today agrees closely enough that
   * saying so would be noise" alike. Never changes what `target_weight_kg`/
   * `target_reps` above say — see the type's own doc comment.
   */
  in_session_signal: InSessionSignal | null;

  /**
   * N495/#865 (phase 3 of #753) — a generated warm-up ramp, present only
   * behind `new_recommendation_engine` and only once `target_weight_kg`
   * above is non-null (see `backend/internal/modules/session/warmup.go`'s
   * `GenerateWarmupRamp`). `undefined`/absent on an older server, or under
   * `not_applicable`/`no_history`/`abstain`/`effort_conflict` — every code
   * that carries no numeric target.
   */
  warmup?: WarmupStep[];
};

/**
 * One rung of a generated warm-up ramp — see `Suggestion.warmup` and
 * `lib/warmup.ts`, which is where a completed warm-up set is checked
 * against this same prescription for #753's advisory fatigue flags.
 */
export type WarmupStep = {
  label: string;
  percent_of_work: number;
  weight_kg: number;
  rep_min: number;
  rep_max: number;
};

export type Volume = {
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  hardest_rpe: number;
  exercise_ids: string[];
  /**
   * N495/#865 — the warm-up-side mirror of `working_sets`/`total_reps`/
   * `tonnage_kg`, tracked separately rather than discarded. See
   * `localVolume`'s own doc comment.
   */
  warmup_sets: number;
  warmup_reps: number;
  warmup_tonnage_kg: number;
};

/**
 * Which measures a set of this exercise records. Same rule as the workout
 * template — driven by the catalog's `load_type`, so the logging form never
 * needs to know about specific exercises.
 */
export type Measure = 'reps' | 'weight' | 'seconds' | 'distance';

/** Which LoggedSet field each measure writes. */
const MEASURE_FIELD: Record<Measure, 'reps' | 'weight_kg' | 'seconds' | 'distance_m'> = {
  reps: 'reps',
  weight: 'weight_kg',
  seconds: 'seconds',
  distance: 'distance_m',
};

export function measuresFor(loadType: Exercise['load_type']): Measure[] {
  switch (loadType) {
    case 'weight_reps':
      return ['reps', 'weight'];
    case 'reps':
      return ['reps'];
    case 'time':
      return ['seconds'];
    case 'distance':
      return ['distance'];
    case 'distance_time':
      return ['distance', 'seconds'];
    default:
      // A server can ship a load_type before the app that renders it does —
      // the house rule for every lookup here. Without this the switch returns
      // undefined and `measures.map` throws inside fillForward, which turns
      // the done tick, the most-used control in the app, into a crash.
      return ['reps'];
  }
}

/**
 * How long to run a work timer for this set, or null if it cannot be timed.
 *
 * **The duration is already on the set, which is why this is a lookup and not a
 * prescription.** `setsFromWorkout` copies a template's `target_seconds` onto
 * every set it creates, and `emptySet` carries the previous set's numbers
 * forward — so "3 sets of 1 minute" arrives here as three rows already holding
 * 60, and a set added by hand inherits whatever the last one was. Reading the
 * field covers the template, the repeat and the correction with one rule.
 *
 * **An explicit duration wins over the exercise's load type, and that is the
 * whole of N4.** This used to refuse any exercise that did not measure seconds,
 * on the argument that "a countdown over a set of squats is a stopwatch pointed
 * at nothing". That argument was right about the case it was looking at — an
 * INVENTED duration — and wrong to generalise. Forty seconds of squats is a
 * real prescription; it is what a circuit is made of. The distinction is not
 * which exercise it is, it is who said the number:
 *
 *  - the athlete put a duration on this set → time it, whatever it measures
 *  - nobody did → invent nothing
 *
 * So the load-type gate now guards only the DEFAULT, which is where inventing
 * could still happen. The two nulls it protects are unchanged:
 *
 *  - **An untimed set with no duration gets no timer.** Not because squats
 *    cannot be timed, but because nothing has said how long — and a default
 *    would be the app choosing, which is the thing that would be meaningless.
 *  - **`distance_time` with no duration gets nothing either.** There the
 *    prescription is the DISTANCE — row 500m, run 400m — and how long it takes
 *    is the result, not the target. Defaulting those to 60 seconds would invent
 *    a goal the athlete never set and quietly turn a measurement into a target.
 *
 * A duration is therefore a TIMER TARGET, not a measure. `measuresForSet` is
 * untouched and still answers "what does this exercise record" — a squat with
 * 40s on it is still a weight×reps set for tonnage, records and which fields it
 * offers. (Its collapsed summary does show the duration: `describeSet` appends
 * any non-null `seconds`. That is intended — an unseen target is a forgotten
 * one — and is noted here because an earlier version of this comment claimed
 * otherwise.) Keeping the two questions apart is what stops a timed squat from
 * silently becoming a timed exercise.
 *
 * A pure `time` exercise with nothing prescribed does get a default, because a
 * plank with no number is still a plank you want to time.
 *
 * **A dual-mode exercise is timed only while it is in time mode**, which is the
 * same question read the same way — see `lib/setMode.ts`. Burpees in reps mode
 * carry no duration and get no timer button; the same burpees switched to time
 * carry one and do. Deriving both answers from `seconds` is what stops the
 * toggle and the play button from ever disagreeing.
 */
export const DEFAULT_WORK_SECONDS = 60;

/**
 * May this exercise be given a timer target it does not already measure?
 *
 * The companion to {@link workSecondsFor}: that one says whether a set IS
 * timed, this one says whether the row should offer to make it so. Two
 * exclusions, and the second is the one that bites.
 *
 *  - **It already measures seconds.** The measure field is the control; a
 *    second one would be two inputs bound to one value.
 *  - **It is DUAL-MODE.** This is not a tidiness rule. `setModeOf` derives a
 *    dual-mode set's mode FROM `seconds`, so writing a duration onto a burpee
 *    set logged in reps flips it to time mode — the reps field disappears and
 *    the row keeps its now-invisible rep count. That is precisely the row
 *    `toggleSetMode` exists to prevent ("a set holding both 12 reps and 40
 *    seconds is a row that two different readers describe two different ways —
 *    and one of them is the volume rollup"), and offering the field here would
 *    be a second, undeclared way to reach it. Dual-mode exercises already have
 *    the mode toggle, which clears the measure being left; that is the right
 *    affordance and this must not compete with it.
 *
 * Caught in review of the first version of N4, which gated on the measures
 * alone — and `measuresForSet` returns `['reps']` for a dual-mode set in reps
 * mode, so the field rendered exactly where it does the damage.
 */
/**
 * What a set's timer target starts at when the Timed switch is turned on.
 *
 * A minute, because the sets this is for are circuit and paced work, where a
 * round is the unit. Deliberately NOT `DEFAULT_MODE_SECONDS` (40), which
 * answers a different question — how long a rep-counted exercise runs once it
 * is being MEASURED in time. Sharing one constant between a measurement and a
 * target is how the two concepts start being treated as one.
 *
 * It is only a starting point: the field opens beside the switch, populated,
 * so changing it is one tap away and nothing is committed by flipping the
 * switch except the row gaining a countdown.
 */
export const DEFAULT_TIMER_SECONDS = 60;

export function offersTimerTarget(loadType: Exercise['load_type'] | undefined): boolean {
  if (loadType === undefined) return false;
  return !measuresFor(loadType).includes('seconds') && !isDualMode(loadType);
}

/**
 * When a countdown finishes, does the clock's elapsed time belong in `seconds`?
 *
 * For a plank it does, and that is the documented contract: log what was
 * actually held, never what was asked for — a 60s plank let go at 40 records
 * 40. `seconds` there is the MEASURE, and the clock is the honest source.
 *
 * For a squat given a 40s target it does not, and this is the half N4 had to
 * add. `seconds` there is the TARGET, so writing elapsed into it destroys the
 * prescription the athlete typed: rack at 25 and the row now says 25, the play
 * button next offers 25, and the number nobody chose has replaced the one they
 * did. The same path fires on early Stop and on `bankRunningWork`, which runs
 * whenever any OTHER timer starts — so a stray tap ten seconds in would have
 * rewritten the target to 10.
 *
 * The rule is therefore the exact inverse of {@link offersTimerTarget}: where
 * the row offers a target field, the target is what `seconds` means and the
 * clock does not get to overwrite it. Dual-mode lands on the right side of this
 * for free — a burpee set in time mode measures seconds, so elapsed wins there
 * as it always did.
 *
 * What this leaves undone is deliberate and recorded: on a targeted set the
 * elapsed time is simply not kept anywhere. There is no honest field for it
 * yet, and inventing one by overwriting the target is what this prevents.
 */
export function elapsedBelongsInSeconds(loadType: Exercise['load_type'] | undefined): boolean {
  return loadType !== undefined && !offersTimerTarget(loadType);
}

export function workSecondsFor(
  set: Pick<LoggedSet, 'seconds'>,
  loadType: Exercise['load_type'] | undefined,
): number | null {
  if (loadType === undefined) return null;
  // A stored 0 is not a duration to count down from, and neither is a
  // negative one: a timer over before it starts fires its completion the
  // instant it begins and logs a zero-second set. Both fall through to the
  // same answer the field-absent case gets — the default for `time`, nothing
  // for anything else.
  //
  // Checked BEFORE the load type, which is the reordering that implements N4.
  if (set.seconds != null && set.seconds > 0) return set.seconds;
  // Only `time` gets a duration nobody asked for. The load-type gate that used
  // to sit here was left in place at first and described as "guarding the
  // default"; review did the case analysis and showed it guarded nothing —
  // every type it rejected fell through this ternary to the same null, so
  // deleting it changed no behaviour and no test. Removed rather than kept as
  // belt-and-braces, because a line that cannot fail is a line that will be
  // read as load-bearing by the next person.
  return loadType === 'time' ? DEFAULT_WORK_SECONDS : null;
}

/**
 * Is the row a countdown was started against still the row at that index?
 *
 * **A work countdown identifies its set by POSITION, and positions move.**
 * `LoggedSet` carries no stable id, so the only handle is where the row sat
 * when the timer started. Delete a set above it, reorder the exercises, or
 * swap one out, and that index now names a different set — at which point a
 * finishing countdown writes `seconds` onto, and ticks, somebody else's squat.
 *
 * The session screen also cancels the countdown on every structural change,
 * which is the fix; this is the backstop that does not depend on a future
 * mutator remembering to. A mutator that forgets loses the elapsed seconds,
 * which is a shame. Writing them to the wrong exercise is a lie, and it is
 * SILENT — which is why this is a named, tested function rather than an inline
 * `?.` comparison nobody would notice going missing.
 */
export function timedSetStillAt(
  sets: Pick<LoggedSet, 'exercise_id'>[],
  index: number,
  exerciseID: string,
): boolean {
  return sets[index]?.exercise_id === exerciseID;
}

export function emptySet(exerciseID: string, position: number, from?: LoggedSet): LoggedSet {
  // Carrying the previous set's numbers forward is the single biggest
  // reduction in taps: sets in a session are usually the same weight and
  // reps, so the common case becomes "confirm", not "type".
  return {
    exercise_id: exerciseID,
    position,
    set_type: from?.set_type ?? 'working',
    reps: from?.reps ?? null,
    weight_kg: from?.weight_kg ?? null,
    seconds: from?.seconds ?? null,
    distance_m: from?.distance_m ?? null,
    // Effort is per-set and never carried: the third set at the same weight
    // is not the same effort as the first, and prefilling it would invite
    // recording a number nobody actually judged.
    rir: null,
    rpe: null,
    // Carried, unlike effort: you do not change your grip between sets of the
    // same exercise unless you mean to, so prefilling it records what actually
    // happened rather than inviting a guess. `undefined` stays undefined — a
    // set carried forward from an unrecorded one is still unrecorded, and must
    // not gain a `regular` nobody chose.
    grip: from?.grip,
    notes: '',
    completed: false,
    // Never carried forward, like completed itself — a new row has not been
    // performed yet, whatever the row it was copied from once recorded.
    performed_at: null,
  };
}

/**
 * Turns a template into the sets to start from: one row per prescribed set,
 * pre-filled with the prescribed numbers.
 *
 * Pre-filling is the point. Starting a planned session from an empty list
 * means retyping the plan you already wrote, and the gap between prescribed
 * and actual — the whole reason sessions and workouts are separate — only
 * exists if the prescription is what you start from and then change.
 */
export function setsFromWorkout(items: WorkoutItem[]): LoggedSet[] {
  const out: LoggedSet[] = [];
  for (const item of items) {
    // A template with no set count still means "do this exercise" — one row.
    const count = Math.min(Math.max(item.target_sets ?? 1, 1), 20);
    for (let i = 0; i < count; i++) {
      out.push({
        exercise_id: item.exercise_id,
        position: out.length,
        set_type: 'working',
        reps: item.target_reps,
        weight_kg: item.target_weight_kg,
        seconds: item.target_seconds,
        distance_m: item.target_distance_m,
        rir: null,
        rpe: null,
        notes: '',
        completed: false,
        performed_at: null,
      });
    }
  }
  return out;
}

/**
 * Swaps every set of one exercise for another, in place.
 *
 * The measures carry over only when the two exercises are measured the same
 * way — swapping a barbell squat for a goblet squat keeps your reps, but
 * swapping a plank for a run cannot keep anything, and inventing a number
 * there would be worse than an empty field. Effort is always cleared: the
 * replacement is a different movement, so a judgement about the old one
 * doesn't transfer.
 */
export function swapExercise(
  sets: LoggedSet[],
  fromID: string,
  to: Exercise,
  fromLoadType: Exercise['load_type'] | undefined,
): LoggedSet[] {
  const sameShape = fromLoadType === to.load_type;
  return sets.map((s) =>
    s.exercise_id !== fromID
      ? s
      : {
          ...s,
          exercise_id: to.id,
          // Cleared ALWAYS, not just when the shape changes — for the reason
          // rir and rpe are cleared two lines down, and for a harder one.
          //
          // The soft reason: assistance is a judgement about one set on one
          // movement, and it does not transfer to a different movement.
          //
          // The one that wedges sync: a shape-changing swap nulls `reps`, and a
          // surviving `assisted_reps` then describes a set with no rep count.
          // The database CHECK refuses that row, so the next push 400s — and the
          // Assisted field unmounts when there are no reps, so the value is
          // invisible AND un-clearable. The session stays dirty and re-fails
          // every sync until the set is deleted.
          assisted_reps: null,
          // Cleared for the soft reason above and a structural one: the picker
          // is gated on the exercise's movement pattern, so swapping a pull-up
          // for a leg press leaves a grip that is still on the row, still sent
          // on every write, and has no control anywhere that can clear it.
          // Invisible and unclearable is the same shape as the sync wedge
          // above, minus the 400 that would at least announce it.
          grip: null,
          // LOOKED UP, never carried over — a factor describes the exercise,
          // so the OLD one cannot survive becoming a different movement.
          // Swapping dumbbells for a barbell used to keep the ×2 and count
          // the barbell double; and because the pull skips dirty rows, that
          // fabricated number survived a whole offline session, one tab from
          // the Today header.
          //
          // `to.implements` is what fixes it (#425): the picker's `Exercise`
          // — whether freshly fetched or read back from `cachedExercises`,
          // which round-trips the server's whole payload — carries the NEW
          // exercise's own factor, so a swap performed with zero signal still
          // lands on the right tonnage the moment a weight is typed. That
          // covers the ordinary case, because `implements` has been on every
          // catalog response since migration 000057, long before this field
          // existed on the TS type.
          //
          // `?? null`, not `?? 1` or `?? undefined`, for the residual case
          // where it genuinely is not there — a cache row from before
          // `payload_json` existed, hitting `cachedExercises`'s reconstructed
          // fallback, which has no `implements` to hand back. Defaulting to 1
          // there is exactly the bug this fixes, just with extra steps: a
          // silent guess that is right for a barbell and wrong, by half, for
          // a swapped-in pair of dumbbells. `null` is the honest answer —
          // "not yet known" — and `totalWeightKg`/`describeSet` read it as
          // exactly that, showing no tonnage rather than a wrong one until
          // the next sync corrects it from the server.
          load_factor: to.implements ?? null,
          reps: sameShape ? s.reps : null,
          weight_kg: sameShape ? s.weight_kg : null,
          seconds: sameShape ? s.seconds : null,
          distance_m: sameShape ? s.distance_m : null,
          rir: null,
          rpe: null,
          completed: false,
          // The old set's completion moment described the OLD movement — a
          // swap is a different exercise, so a stale performed_at surviving
          // the swap would misrepresent when the (never-performed) new
          // exercise happened.
          performed_at: null,
        },
  );
}

/**
 * Suggestions for replacing `base`, in two labelled tiers.
 *
 * **Muscle first, and that reordering is the whole point.** The previous rule
 * scored only `movement_pattern` and `load_type` and never looked at
 * `primary_muscles` at all — so swapping a barbell bench press offered other
 * horizontal presses, which is usually right by accident, while swapping a
 * leg press could suggest anything sharing the `squat` pattern regardless of
 * what it trained. The question an athlete is actually asking is "the rack is
 * taken, what else trains this?", and the answer starts with the muscle.
 *
 * Matched on the muscle GROUP rather than the raw `primary_muscles` string,
 * because the catalog carries 58 distinct values across 761 exercises and
 * nobody swaps a lift looking for another one that hits `teres-minor`. The
 * groups are the same ones the Library filters on, so the app has one
 * vocabulary for "what does this train" rather than two.
 *
 * Deterministic and explainable, like every other recommendation here: within
 * a tier, candidates that also share the movement pattern come first, then
 * those whose numbers carry over, then alphabetically.
 *
 * **Equipment is deliberately not scored.** The old rule treated shared
 * equipment as a point in favour, which is backwards for the case the swap
 * screen exists for — if the barbell is occupied, another barbell movement is
 * the one suggestion that cannot help. But the opposite rule would be a guess
 * too: people also swap for a niggle, or because they prefer a machine. So the
 * ranking stays out of it and the row shows the equipment instead, which is
 * the one thing that lets the athlete decide in a second.
 */
export type SwapSuggestions = {
  /** Trains the same muscle group. The answer to "what else hits this?". */
  muscle: Exercise[];
  /** Same movement shape, a different muscle group. */
  movement: Exercise[];
};

/**
 * Per tier, not overall.
 *
 * The old cap was 8 across everything, which with muscle-first ranking would
 * have let a well-covered muscle crowd the movement tier off the screen
 * entirely. These render in a list header rather than the virtualised list, so
 * the number is about how much someone will read, not about performance.
 */
export const MAX_SWAP_SUGGESTIONS = 10;

export function swapSuggestions(
  base: Exercise,
  all: Exercise[],
  /**
   * Injected rather than imported, so this module keeps knowing nothing about
   * the facet vocabulary — and so a test can pin the tiering without also
   * pinning the muscle taxonomy.
   */
  sharesMuscleGroup: (a: Exercise, b: Exercise) => boolean,
): SwapSuggestions {
  const rank = (e: Exercise): number => {
    const pattern = e.movement_pattern === base.movement_pattern;
    // "Carries" means the logged numbers still mean something in the same
    // row — the same test `swapExercise` uses to decide whether to keep them.
    const carries = e.load_type === base.load_type;
    if (pattern && carries) return 3;
    if (pattern) return 2;
    if (carries) return 1;
    return 0;
  };
  const order = (a: Exercise, b: Exercise) => rank(b) - rank(a) || a.name.localeCompare(b.name);

  const muscle: Exercise[] = [];
  const movement: Exercise[] = [];
  for (const e of all) {
    if (e.id === base.id) continue;
    if (sharesMuscleGroup(base, e)) muscle.push(e);
    else if (e.movement_pattern === base.movement_pattern) movement.push(e);
  }

  return {
    muscle: muscle.sort(order).slice(0, MAX_SWAP_SUGGESTIONS),
    movement: movement.sort(order).slice(0, MAX_SWAP_SUGGESTIONS),
  };
}

/**
 * `duration` is how this exercise's seconds are written — see `lib/duration.ts`.
 * Defaulted rather than required so the several read-only surfaces that
 * summarise a set (history, the celebration card, VoiceOver) keep working
 * unchanged; only the logging screen, which knows the per-exercise choice, needs
 * to pass it.
 */
export function describeSet(
  s: LoggedSet,
  // Required — see the note on `summariseTargets` in lib/workouts.ts. The
  // `duration` default below stays: a seconds/minutes display mode cannot
  // render the wrong unit SYSTEM, which is the failure being closed here.
  units: UnitSystem,
  duration: DurationUnit = 'seconds',
): string {
  const parts: string[] = [];
  const w = formatWeight(s.weight_kg, units);
  // A pair of dumbbells moves double what is stamped on one of them, and one
  // is what was typed. Say so on the row, because the Volume tile above it
  // has already doubled and an athlete checking 8 × 30 against it otherwise
  // finds the app off by exactly a factor of two — and concludes the app is
  // wrong rather than that it knew something they did not.
  //
  // Derived from the total rather than from `load_factor == 2`, so a factor
  // this code has never seen still annotates, and 1 / 0 / undefined — which
  // `totalWeightKg` already flattens to "times one" — say nothing at all.
  //
  // `total == null` (the EXPLICITLY-UNRESOLVED state, #425) falls into the
  // same "say nothing" branch as "times one" — `null !== s.weight_kg` is
  // true, so the guard below needs its own null check rather than relying on
  // that comparison. Silence is correct either way: an athlete reading plain
  // `30kg` cannot tell "this is the whole story" from "the total is not
  // known yet", but neither claims a total this row does not have, which is
  // what "absent beats wrong" means here.
  const total = totalWeightKg(s);
  const shown =
    s.weight_kg != null && total != null && total !== s.weight_kg
      ? `${w} (${formatWeight(total, units)} total)`
      : w;
  if (s.reps != null && s.weight_kg != null) parts.push(`${s.reps} × ${shown}`);
  else if (s.reps != null) parts.push(`${s.reps} reps`);
  else if (s.weight_kg != null) parts.push(shown);
  if (s.seconds != null) parts.push(formatDuration(s.seconds, duration));
  if (s.distance_m != null) parts.push(formatDistance(s.distance_m, units));
  if (s.rpe != null) parts.push(`RPE ${s.rpe}`);
  else if (s.rir != null) parts.push(`${s.rir} RIR`);
  // Only when recorded — an unrecorded grip shows nothing at all rather than
  // "regular", which would be the app answering a question nobody asked.
  if (s.grip) parts.push(GRIPS.find((g) => g.key === s.grip)?.label ?? s.grip);
  return parts.join(' · ') || 'Not recorded';
}

async function request<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  const res = await netFetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
      parseRetryAfterMs(res.headers?.get('Retry-After')),
    );
  }
  return body as T;
}

/**
 * `goal` picks the rep range the rule progresses inside — the same squat is a
 * 3-rep lift in a strength block and a 10-rep lift in a hypertrophy one. Pass
 * the goal of the workout being performed; omitting it falls back to a general
 * 5-8 range rather than failing.
 *
 * `todaySets` is the session CURRENTLY OPEN's own sets — see N191. Sent
 * straight from whatever the caller already has in hand (state, or the
 * SQLite row `readLocalSession` returned), never re-read from anywhere else:
 * that's what makes this work before a set has synced, in a gym with no
 * signal, which is the whole point (`lib/db.ts` writes locally first). Only
 * sets the athlete would call a SET travel — `countsAsSet` (completed, not a
 * warm-up, not a drop) — with a recorded weight; a warm-up or an unticked
 * set says nothing about what the athlete can do today, and a drop is
 * always lighter than the set it hangs off BY DEFINITION, so including it
 * would drag the average down against a TargetWeightKg that's derived from
 * the top set — manufacturing a false "lighter day" note on a session that
 * went exactly to plan. Found in review.
 *
 * `unitSystem` is N473/#812's own fix for the reported 68.9lb — behind
 * `new_recommendation_engine`, the server rounds a suggestion in whichever
 * unit this names rather than a kilogram grid that can land on an unloadable
 * number once converted for display. The one global preference from
 * `useUnits()`, not a per-exercise override (`unitFor` in the session
 * screen) — this is a single request for a whole workout, same simplifying
 * choice `goal` already makes. Omitted entirely reads as metric on the
 * server, which is this endpoint's behaviour without this parameter at all,
 * so a caller that doesn't have a unit preference in hand yet loses nothing
 * by leaving it out.
 */
export async function fetchSuggestions(
  getToken: TokenGetter,
  exerciseIDs: string[],
  goal?: string | null,
  todaySets?: readonly Pick<LoggedSet, 'exercise_id' | 'weight_kg' | 'completed' | 'set_type'>[],
  signal?: AbortSignal,
  unitSystem?: UnitSystem | null,
  /**
   * N494/#864 (phase 2 of #753) — which workout this is for, so the server
   * can consult a requested exercise's own configured `protocol` (rep
   * range, target effort, progression strategy…) instead of only the
   * workout-wide goal-based range. Appended last, same reasoning
   * `unitSystem` above already followed: no existing positional caller
   * shifts. Omitted entirely (a call site with no workout in scope, e.g.
   * the exercise detail screen) reads as "no per-item configuration to
   * consult" — exactly today's behaviour.
   */
  workoutId?: string | null,
): Promise<Map<string, Suggestion>> {
  const unique = [...new Set(exerciseIDs)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const q = new URLSearchParams({ exercise_ids: unique.join(',') });
  if (goal) q.set('goal', goal);
  if (unitSystem) q.set('unit_system', unitSystem);
  if (workoutId) q.set('workout_id', workoutId);
  if (todaySets && todaySets.length > 0) {
    const pairs = todaySets
      .filter((s) => countsAsSet(s) && s.weight_kg != null && s.weight_kg > 0)
      .map((s) => `${s.exercise_id}:${s.weight_kg}`);
    if (pairs.length > 0) q.set('today_sets', pairs.join(','));
  }
  const b = await request<{ suggestions: Suggestion[] }>(
    getToken,
    `/sessions/suggestions?${q}`,
    {},
    signal,
  );
  return new Map((b.suggestions ?? []).map((s) => [s.exercise_id, s]));
}

/**
 * Fills in the weight and reps for sets that don't already carry them.
 *
 * A template's own prescription always wins — it's an instruction, not a
 * guess. Where it's silent, the recommendation goes in, so a planned session
 * opens at numbers that mean something rather than empty boxes.
 *
 * Reps are filled now where they deliberately weren't before. The old rule
 * only ever moved load, so inventing reps would have overwritten the
 * programme; under double progression the rep target *is* half the
 * recommendation, and leaving it blank drops the half that moves most often.
 */
export function applySuggestions(
  sets: LoggedSet[],
  suggestions: Map<string, Suggestion>,
  /**
   * The catalog, so a dual-mode set in time mode is left alone.
   *
   * Optional, because most callers have no catalog to hand and the rule only
   * bites on `reps` exercises. Without it a burpee set switched to 40 seconds
   * would silently acquire a rep target too — and a row holding both numbers is
   * the one thing `lib/setMode.ts` derives its mode from, so the set would flip
   * itself back to reps with a duration still attached.
   */
  loadTypeOf?: (exerciseID: string) => Exercise['load_type'] | undefined,
): LoggedSet[] {
  return sets.map((s) => {
    const hit = suggestions.get(s.exercise_id);
    if (!hit) return s;
    let next = s;
    if (next.weight_kg == null && hit.target_weight_kg != null) {
      next = { ...next, weight_kg: hit.target_weight_kg };
    }
    const timed = setModeOf(next, loadTypeOf?.(next.exercise_id)) === 'time';
    if (!timed && next.reps == null && hit.target_reps != null) {
      next = { ...next, reps: hit.target_reps };
    }
    return next;
  });
}

export async function listSessions(
  getToken: TokenGetter,
  // `offset` added for N85's fresh-install backfill (`sessionStore.ts`
  // `runSync`), which pages through a device's full history in bounded
  // requests rather than one unbounded pull. Kept on this function, rather
  // than only on `listSessionsPage` below, so the sync path's existing
  // `listSessions as pullSessions` import and its test mocks (which all
  // return a plain array) don't have to change shape.
  opts: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<Session[]> {
  // Every session carries all of its sets, so a screen showing five recent
  // ones must not pull the API's default fifty.
  const qs = sessionQS(opts);
  const b = await request<{ sessions: Session[] }>(getToken, `/sessions${qs}`, {}, signal);
  return b.sessions ?? [];
}

/** One page of sessions, plus how many the filter matched in total — the
 * mobile mirror of apps/web's `SessionPage` (`apps/web/src/lib/api.ts`). */
export type SessionPage = {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * The full session query the backend's `GET /v1/sessions` supports (see
 * `backend/internal/modules/session/handler.go`'s `List`): a name search,
 * a sport filter, a date range, and paging.
 */
export type SessionQuery = {
  limit?: number;
  offset?: number;
  sport?: string;
  from?: string;
  to?: string;
  /** Free text matched against the session name, case-insensitively. */
  q?: string;
  /** IANA zone `from`/`to` are resolved in — see `listSessionsPage`'s note on
   *  why the search screen always sends this. */
  tz?: string;
};

function sessionQS(opts: SessionQuery): string {
  const p = new URLSearchParams();
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.offset) p.set('offset', String(opts.offset));
  if (opts.sport) p.set('sport', opts.sport);
  if (opts.from) p.set('from', opts.from);
  if (opts.to) p.set('to', opts.to);
  if (opts.q) p.set('q', opts.q);
  if (opts.tz) p.set('tz', opts.tz);
  const query = p.toString();
  return query ? `?${query}` : '';
}

/**
 * N85 — the network-backed search VOLA's mobile session history did not
 * have. `listSessions` above returns a bare array because the sync path that
 * calls it never needed anything else; a search/browse screen needs the
 * `total` a page reports itself for, so this is a second function rather
 * than a breaking change to the first one's return type.
 *
 * This is a direct hit against `GET /v1/sessions` — it does not go through
 * local SQLite — because the whole point is to reach sessions the device may
 * never have pulled down (see `docs/decisions/phone-impossible-audit.md`
 * row 12: a fresh install's local cache holds at most the routine sync's
 * most recent rows). It therefore needs a connection; callers should fall
 * back to `listLocalSessions` (`sessionStore.ts`) and say so when this
 * throws offline, the way `apps/mobile/app/session/history.tsx` does.
 *
 * A period filter's `from`/`to` should be sent alongside a `tz` — the
 * backend resolves both in that zone (`handler.go`'s `List`), and web's
 * `apps/web/src/lib/api.ts` already does this. Without it, a session logged
 * near midnight can fall on the wrong side of a period boundary compared to
 * what web shows for the same athlete, the same filter, the same moment.
 */
export async function listSessionsPage(
  getToken: TokenGetter,
  opts: SessionQuery = {},
  signal?: AbortSignal,
): Promise<SessionPage> {
  const b = await request<SessionPage>(getToken, `/sessions${sessionQS(opts)}`, {}, signal);
  return {
    sessions: b.sessions ?? [],
    total: b.total ?? 0,
    limit: b.limit ?? 0,
    offset: b.offset ?? 0,
  };
}

export async function getSession(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}`, {}, signal);
}

export async function startSession(
  getToken: TokenGetter,
  input: {
    sport: string;
    name: string;
    /** Omitted means `normal` — see `SessionIntent`'s own doc comment. */
    intent?: SessionIntent;
    workout_id?: string | null;
    sets?: LoggedSet[];
    /** Supplied when pushing a session that was started offline. */
    id?: string;
    started_at?: string;
    /**
     * Sent when the session was already over before it was ever pushed — a
     * reflection log rather than a live one.
     *
     * Carried on the CREATE rather than left to the follow-up finish call,
     * because a session's duration must not depend on a later request
     * succeeding. Training history derives every duration from
     * `ended_at - started_at`, so a create that omits it produces a session
     * worth nothing until the finish lands — and anything that can fail
     * between the two (a refused reflection, a dropped connection) would
     * take the session's mat time with it.
     */
    ended_at?: string | null;
  },
): Promise<{ session: Session; volume: Volume }> {
  // Client-generated ID, so starting a session is idempotent on retry — the
  // same contract offline activity logging relies on, and what lets the
  // offline store push a session it created hours earlier.
  return request(getToken, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id ?? randomUUID(),
      started_at: input.started_at ?? new Date().toISOString(),
      ...input,
    }),
  });
}

export async function replaceSets(
  getToken: TokenGetter,
  id: string,
  sets: LoggedSet[],
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/sets`, {
    method: 'PUT',
    body: JSON.stringify({ sets }),
  });
}

export async function finishSession(
  getToken: TokenGetter,
  id: string,
  /** Supplied when pushing a session finished offline — the real end time,
   *  not the time the sync happened to run. */
  endedAt?: string,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/finish`, {
    method: 'POST',
    body: JSON.stringify({ ended_at: endedAt ?? new Date().toISOString() }),
  });
}

/**
 * Change a session's name, and nothing else.
 *
 * PATCH rather than a full update: the name is the only field a client may
 * change after the fact. Everything else either decides which screen renders
 * the session (sport), is what history counts (the timestamps), or has its own
 * replace endpoint (sets).
 */
export async function renameSession(
  getToken: TokenGetter,
  id: string,
  name: string,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

/**
 * Change a session's own date — `started_at` — and nothing else.
 *
 * Its own endpoint rather than folded into `renameSession`'s PATCH body,
 * matching `/sets` and `/finish`'s sub-resource shape. Added for N436: an
 * athlete correcting a BJJ class logged under the wrong day previously had no
 * way to fix it, even though the reflection wizard already let them freely
 * edit everything else about the session.
 */
export async function rescheduleSession(
  getToken: TokenGetter,
  id: string,
  startedAt: string,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/schedule`, {
    method: 'PATCH',
    body: JSON.stringify({ started_at: startedAt }),
  });
}

/**
 * Change a session's intent — `normal`/`light`/`deload` — and nothing else
 * (N474). Its own endpoint, matching `/schedule`'s shape: reachable both
 * before a session starts (the session-start picker is just this call made
 * early, folded into `startSession`) and afterward, for an athlete who only
 * realises partway through — or scrolling history later — that a session
 * wasn't a normal one.
 */
export async function setSessionIntent(
  getToken: TokenGetter,
  id: string,
  intent: SessionIntent,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/intent`, {
    method: 'PATCH',
    body: JSON.stringify({ intent }),
  });
}

export async function deleteSession(
  getToken: TokenGetter,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Fill the *planned* sets below `index` with what was just entered.
 *
 * "+ Set" has always carried the previous set's numbers forward, but sets that
 * came from a template arrive already existing and empty — so a 3×5 plan meant
 * typing the same weight three times. The request was exactly that: enter it
 * once, adjust the rest as you go.
 *
 * The rules that keep it from being destructive:
 *
 *  - **Only later sets of the same exercise**, stopping at the next one.
 *    Groups are adjacency-based, same as the display.
 *  - **Only measures still blank.** A number already typed is never
 *    overwritten — a top set followed by back-offs is a real plan, and
 *    flattening it silently would be worse than the typing this saves.
 *  - **Never a completed set.** That is a record of something that happened.
 *  - **Never effort.** Same reason `emptySet` won't carry it: the third set at
 *    one weight is not the third set's effort, and prefilling invites
 *    recording a number nobody judged.
 *
 * Returns the same array identity when nothing changed, so callers can skip a
 * write.
 */
export function fillForward(
  sets: LoggedSet[],
  index: number,
  measures: Measure[],
): LoggedSet[] {
  const source = sets[index];
  if (!source) return sets;
  const keys = measures.map((m) => MEASURE_FIELD[m]);

  // Where this group ends. Adjacency defines a group, so the FIRST row of a
  // different exercise is the boundary — not "every row with a different id".
  // Filtering on the id alone reaches a *later* block of the same exercise:
  // squat / bench / squat would fill the second squat block from the first,
  // which is a different piece of work with different numbers. Caught by a
  // test; the original code contradicted this function's own doc comment.
  let end = index + 1;
  while (end < sets.length && sets[end].exercise_id === source.exercise_id) end++;

  let changed = false;
  const next = sets.map((s, i) => {
    if (i <= index || i >= end || s.completed) return s;
    const patch: Partial<LoggedSet> = {};
    for (const k of keys) {
      if (s[k] == null && source[k] != null) patch[k] = source[k] as never;
    }
    if (Object.keys(patch).length === 0) return s;
    changed = true;
    return { ...s, ...patch };
  });
  return changed ? next : sets;
}

/**
 * Splits the rows into exercise groups, so "+ Set" sits under the movement it
 * belongs to and nobody has to re-pick the exercise for every set.
 *
 * A group is a maximal run of ADJACENT rows sharing an `exercise_id` — the
 * same adjacency `DropsOf` walks server-side
 * (backend/internal/modules/session/session.go), and for the same reason:
 * squat / bench / squat is two separate blocks of work, not one squat group
 * that swallows the bench in between.
 *
 * **Deliberately blind to `set_type`.** Grouping only needs to know where one
 * exercise's rows end and the next begins, and `exercise_id` alone already
 * answers that correctly — a drop can never pull rows from the wrong exercise
 * into its group, because its `exercise_id` matches its real exercise, same
 * as any other row. What adjacency-by-id does NOT know is whether the first
 * row of a group is a legitimate one to lead with — a drop opening a group
 * has no preceding same-exercise row to have come from, i.e. no real parent.
 * That is `setOrdinals`'s job, not this function's: this function only ever
 * has to answer "which exercise", and answering "and is this row's `set_type`
 * sane here" as well would make it responsible for two rules a caller could
 * get right independently and wrong together.
 *
 * Extracted from the session screen (L9, #664) alongside `setOrdinals` — an
 * inline `sets.forEach` building this had no test coverage for either the
 * ordinary case or the orphaned-drop one the ordinal fix above depends on.
 */
export function groupSets(
  sets: Pick<LoggedSet, 'exercise_id'>[],
): { exerciseID: string; indices: number[] }[] {
  const groups: { exerciseID: string; indices: number[] }[] = [];
  sets.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && last.exerciseID === s.exercise_id) last.indices.push(i);
    else groups.push({ exerciseID: s.exercise_id, indices: [i] });
  });
  return groups;
}

/**
 * Move a whole exercise up or down, taking its sets with it.
 *
 * `order` is the current grouping as arrays of indices into `sets` — passed in
 * rather than recomputed so this can't disagree with what is on screen.
 *
 * Positions are renumbered because the server orders by them; leaving them
 * stale makes a reorder that looks right locally and reverts on next load.
 * Returns null when the move would go off either end, so the caller writes
 * nothing.
 */
export function reorderGroups(
  sets: LoggedSet[],
  order: number[][],
  groupIndex: number,
  delta: -1 | 1,
): LoggedSet[] | null {
  const target = groupIndex + delta;
  if (target < 0 || target >= order.length) return null;
  const moved = order.map((g) => g.slice());
  [moved[groupIndex], moved[target]] = [moved[target], moved[groupIndex]];
  return moved.flat().map((i, position) => ({ ...sets[i], position }));
}

/**
 * What was actually moved, which is not always the number that was typed.
 *
 * `weight_kg` holds what is stamped on the implement, because that is what an
 * athlete reads. For a pair of dumbbells it is ONE of the two, so the total is
 * double — and every local volume sum has to agree with the server about that,
 * or the week on your phone disagrees with the history behind it.
 *
 * Undefined and zero both mean one. Every set logged before the server started
 * sending a factor has none, and reading that as zero would erase their volume
 * rather than merely under-reporting the dumbbell ones.
 *
 * **`null` returns `null`, not a guessed number (#425).** That is the
 * EXPLICITLY-UNRESOLVED state `LoggedSet.load_factor`'s doc describes — an
 * offline exercise swap whose new exercise's factor could not be found in the
 * local catalog. `undefined` and `0` both fail toward under-reporting, which
 * is the right default when nothing will ever tell the client more. `null` is
 * different: the true factor is knowable, imminently, on the next sync — so
 * guessing here is not a safe fallback, it is the "reports half its eventual
 * tonnage" bug itself. A caller receiving `null` must not display a number it
 * computed from this — see `describeSet` and `localVolume`.
 */
export function totalWeightKg(set: {
  weight_kg: number | null;
  load_factor?: number | null;
}): number | null {
  if (set.weight_kg == null) return 0;
  if (set.load_factor === null) return null;
  const factor = set.load_factor && set.load_factor > 1 ? set.load_factor : 1;
  return set.weight_kg * factor;
}

/**
 * What the athlete did unaided — the number worth training against.
 *
 * Mirrors the server's `SoloReps`. Unrecorded assistance means all of them were
 * solo: that is what every set logged before the field existed needs, and it
 * credits what `reps` already claimed rather than revising history downward.
 */
export function soloReps(set: { reps: number | null; assisted_reps?: number | null }): number {
  if (set.reps == null) return 0;
  if (set.assisted_reps == null) return set.reps;
  return Math.max(0, set.reps - set.assisted_reps);
}

/**
 * Apply a change to a set, keeping `assisted_reps` inside `reps`.
 *
 * **The clamp has to live on BOTH edits, not just the assisted one.** Set 10
 * reps with 8 assisted, then correct the reps down to 5, and the set now claims
 * more help than work — which the server and the database CHECK both refuse,
 * so the next save fails with a 400 naming a field the athlete did not touch.
 * Clamping only where assistance is typed catches the obvious direction and
 * misses this one entirely.
 *
 * Clearing the reps clears the assistance with them: "3 of them were assisted"
 * is a claim about a rep count, and a claim about nothing is not a smaller
 * claim, it is an invalid row.
 */
export function withSetChange(set: LoggedSet, patch: Partial<LoggedSet>): LoggedSet {
  const next = { ...set, ...patch };
  if (next.reps == null) {
    // Nothing to be assisted with.
    return next.assisted_reps == null ? next : { ...next, assisted_reps: null };
  }
  if (next.assisted_reps != null && next.assisted_reps > next.reps) {
    return { ...next, assisted_reps: next.reps };
  }
  return next;
}

/**
 * Set numbers for one exercise's rows, where a drop does not get one.
 *
 * "225x3 then 185x8" is ONE set with a drop off it. Numbering them 3 and 4
 * tells the athlete they did four sets when they did three — and that count is
 * the one they carry around and compare to last week, so it has to be the
 * number of efforts, not the number of rows.
 *
 * A drop carries its parent's number, which is what lets the row read as
 * "the drop off set 3" rather than as a set with no identity — but only when
 * it HAS a parent. `groupSets` groups purely by exercise adjacency (see its
 * own doc comment), so the first row handed to this function is sometimes a
 * drop with nothing above it in the group at all: the drop is the first set
 * of the whole session, or the first set of a new exercise. That is
 * `DropsOf`'s "orphaned" case (backend/internal/modules/session/session.go) —
 * a drop belongs only to the immediately preceding same-exercise, non-drop
 * row, and one with no such row is skipped rather than attached to anybody
 * else's lift.
 *
 * **L9 (#664): an orphaned drop gets its OWN ordinal, counted like a working
 * set, rather than borrowing whatever the next real set is about to claim.**
 * The previous behaviour clamped it to 1 — which is also exactly the ordinal
 * the following legitimate working set would then get, so the drop's row
 * (and its accessibility label, "drop off set 1", spoken even though the row
 * itself only ever shows "↳") read as though it hung off that set's effort.
 * It never did: an orphaned drop has no real parent, by definition, so
 * sharing an identity with an unrelated set is a false attachment, not a
 * kindness. Giving it its own number keeps every ordinal a claim about one
 * specific set — never a shared one — while still never showing a bare zero.
 *
 * Extracted from the session screen for the reason `ClampLimit` and
 * `ScopeFilter` were on the server: the rule is small, easy to get subtly
 * wrong, and untestable where it was.
 */
export function setOrdinals(setsInGroup: Pick<LoggedSet, 'set_type'>[]): number[] {
  let n = 0;
  // Whether the current run of drops has a real (non-drop) row above it in
  // this group to borrow a number from. Starts false: nothing has been seen
  // yet, so a drop in the very first slot has nothing to attach to.
  let hasParent = false;
  return setsInGroup.map((s) => {
    if (s.set_type !== 'drop') {
      n++;
      hasParent = true;
      return n;
    }
    if (hasParent) return n; // A real drop — shares its parent's number.
    // An orphaned drop: skipped from the borrowing mechanism, not attached to
    // whichever set happens to be adjacent. See the function doc above.
    n++;
    return n;
  });
}

/**
 * A drop set to hang off `from` — the next rung down in a drop.
 *
 * Weight carries forward UNCHANGED rather than at some percentage. A drop is
 * lighter by definition, so an invented 80% looks helpful and is a guess about
 * somebody's training: they would have to clear it and retype, which is worse
 * than editing down from the number they just lifted.
 *
 * Reps are cleared, and that is the difference from an ordinary added set. The
 * whole point of a drop is that you get a different number at the lower weight;
 * carrying the parent's reps forward would prefill the one field that is
 * certainly wrong.
 *
 * `assisted_reps` is not carried either, for the same reason effort is not: it
 * is a judgement about one set, and prefilling it would record something nobody
 * assessed.
 */
export function emptyDropSet(from: LoggedSet, position: number): LoggedSet {
  return {
    ...emptySet(from.exercise_id, position, from),
    set_type: 'drop',
    reps: null,
    rir: null,
    rpe: null,
  };
}

/**
 * Round a distance in metres to the nearest whole metre — the shape the wire
 * actually requires. `Set.distance_m` is `*int` on the backend
 * (`backend/internal/modules/session/session.go`, `distance_m INTEGER` in
 * `backend/migrations/000010_create_sessions.up.sql`), so a fractional value
 * — a haversine sum, a HealthKit `HKQuantity.doubleValue`, anything derived
 * from a real GPS or watch measurement — is essentially never a whole number
 * and Go's `encoding/json` refuses to decode a float into an `int` field at
 * all: `UnmarshalTypeError`, collapsed by the handler into a generic
 * `"invalid JSON body"` 400 (N507/#884) before this app's own set validation
 * ever runs. Unlike a genuinely unstorable measure (see `repairSet` below),
 * this is a REPRESENTABLE value the server would happily take — it just has
 * to arrive as an integer, so rounding (not nulling) is the correct repair.
 *
 * **The one shared mechanism for all three running write paths**
 * (`healthkitSync.ts`, `detectedActivity.ts`, `app/running/[id].tsx`'s finish
 * handler) — matching the `Math.round(...)` precedent the manual strength
 * editor already uses (`app/session/[id].tsx`) — rather than four independent
 * inline `Math.round` calls that a fifth write path could fail to copy.
 *
 * **Also the fix for a run already stuck on-device with a fractional value
 * from before this shipped.** `repairSet` below calls this on every read, and
 * `parseSets` (`sessionStore.ts`) is the ONE gate every stored session goes
 * through before either the screen or a push sees it — so a `session_sets`
 * row already sitting in `local_sessions` with e.g. `2011.4523` heals on the
 * very next retry, with no separate migration needed. See `parseSets`'s own
 * doc comment for why that gate is where a repair belongs.
 *
 * Applies the same "zero is not data" rule `repairSet` uses for every other
 * measure: a distance that rounds to zero or below is not a valid distance,
 * so it becomes `null` rather than `0`.
 */
export function roundDistanceM(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const rounded = Math.round(v);
  return rounded > 0 ? rounded : null;
}

/**
 * Drop every measure the server will refuse, turning it back into "not
 * recorded".
 *
 * **This is the fix for a session that can never sync.** The API validates each
 * measure as "absent, or greater than zero" (`validateSets` in the session
 * handler, backed by the table's own CHECK), and returns a 400 naming the set:
 * `set 10: weight must be greater than 0`. A 400 classifies as a PERMANENT
 * rejection, so the row stays dirty forever, the repair screen lists it forever,
 * and no amount of retrying helps — the phone is asking the server to store
 * something the schema cannot hold.
 *
 * Nothing stopped the phone writing one. The set editor parses whatever is
 * typed, so a `0` in the weight field is stored as `0` rather than as nothing,
 * and one keystroke in a gym strands a whole session. That is what happened.
 *
 * **Zero is not data here, and that is why this is a repair rather than a
 * deletion.** There is no reading under which a set was performed with 0 kg,
 * for 0 seconds or over 0 metres; the athlete either did not record it or typed
 * a digit they did not mean. `null` is what the app already renders as "—" and
 * what every consumer already handles, so this restores the meaning the value
 * was always going to have — the alternative is not "keep the zero", it is
 * "keep the session off the server".
 *
 * `rir` is deliberately EXEMPT from the rule. 0 RIR is a real answer — nothing
 * left in the tank — and the server accepts 0-20. `rpe` is not exempt: its
 * range starts at 1, so a 0 there is the same unstorable non-answer.
 *
 * Applied where the row is READ rather than where it is typed, and that is
 * deliberate: nulling on input would wipe the field the instant someone typed
 * the `0` of `0.5`, making a decimal weight impossible to enter.
 *
 * `distance_m` goes through `roundDistanceM` rather than the plain `measure`
 * every other field uses — see that function's own doc comment for why a
 * fractional distance is a ROUNDING problem, not a nulling one, and why
 * running that repair here (not just at each write site) is what heals a run
 * already stuck on-device with a fractional value from before N507.
 */
export function repairSet<T extends LoggedSet>(set: T): T {
  const measure = (v: number | null): number | null =>
    v != null && Number.isFinite(v) && v > 0 ? v : null;
  const reps = measure(set.reps);

  /*
    `assisted_reps`, which `withSetChange` already clamps — and this still has
    to check.

    The two are not the same guard. `withSetChange` is the EDITOR's rule and
    holds the invariant while a set is being typed; its own comment explains
    why the clamp has to sit on both edits. This is the READ, and it covers
    what an editor cannot reach: rows already written before that clamp existed,
    and rows that arrive from the server. A pulled set is stored verbatim, so
    whatever the server holds is what the next push replays.

    Left unchecked, the failure is the one this whole function exists to
    prevent — `assisted reps need a rep count to be part of`, a permanent 400,
    on a field an athlete has no way to connect to anything they did.

    REMOVED rather than nulled when it cannot stand, so a set that never carried
    the key does not gain one: every set is sent on every push, and an invented
    `assisted_reps: null` would start claiming "none were assisted" about sets
    nobody recorded that for.
  */
  const assisted = set.assisted_reps;
  const assistedStands =
    assisted != null &&
    Number.isFinite(assisted) &&
    assisted >= 0 &&
    reps != null &&
    assisted <= reps;

  /*
    Grip is checked for SHAPE, never for vocabulary, and that distinction is
    the whole point.

    Every other repair in this function is decidable here and now: a weight of
    zero, an RIR of 25, more assisted reps than reps. Those are illegal on any
    server, forever, and nulling them is safe.

    A grip is not like that. This build knows a FIXED list; the server decides
    how many there are. Checking `set.grip` against `GRIPS` therefore answers
    "do I recognise this?" while pretending to answer "would the server take
    it?" — and the moment the server grows one, every phone still on this build
    reads a legitimate value, nulls it, and the wholesale PUT writes that null
    back over real data. Silent, on rows the athlete did record, with no error
    anywhere.

    The erasure itself never shipped — #256 removed the nulling BEFORE the
    server grew a value, which is why N9 was safe to widen. What did happen is
    smaller and worth guarding against anyway: this paragraph said "four" and
    "a fifth value" and "`mixed`" until the day N9 merged, at which point it
    described the wrong world in six files at once. Do not write the current
    count here in present tense.

    Note where an unknown value can come FROM. The picker only ever writes
    `g.key` for `g` in `GRIPS`, so nothing local can produce one; a grip this
    build does not recognise arrived from the server, which means the server
    accepts it. Erasing it is not a conservative choice, it is the wrong one.

    So: null only what could not be a value at all — a non-string, or an empty
    one — and let the server adjudicate its own vocabulary. Display already
    tolerates the unknown case (`GRIPS.find(...)?.label ?? s.grip` above), and
    the 400-driven repair screen is still the backstop if genuinely corrupt text
    ever reaches the wire. That trade is deliberate: a stranded session is loud,
    visible and rare, while erased data is silent and permanent.
  */
  const gripStands =
    set.grip == null || (typeof set.grip === 'string' && set.grip.length > 0);

  return {
    ...set,
    ...(assisted != null && !assistedStands ? { assisted_reps: null } : {}),
    // Only when it cannot be a value at all — see the shape-versus-vocabulary
    // note above. An unrecognised-but-plausible grip is preserved and sent, so
    // a server that has grown its enum keeps the value it gave us.
    ...(gripStands ? {} : { grip: null }),
    reps,
    weight_kg: measure(set.weight_kg),
    seconds: measure(set.seconds),
    distance_m: roundDistanceM(set.distance_m),
    // Range-checked rather than sign-checked, because both ends are refused
    // and an out-of-range effort is as unstorable as a zero one.
    rir: set.rir != null && Number.isFinite(set.rir) && set.rir >= 0 && set.rir <= 20
      ? set.rir
      : null,
    rpe: set.rpe != null && Number.isFinite(set.rpe) && set.rpe >= 1 && set.rpe <= 10
      ? set.rpe
      : null,
  };
}

/**
 * Does this set contribute VOLUME — reps and tonnage?
 *
 * Warm-ups do not. Everything else performed does, drops included: the weight
 * was moved.
 */
export function contributesVolume(set: Pick<LoggedSet, 'completed' | 'set_type'>): boolean {
  return set.completed && set.set_type !== 'warmup';
}

/**
 * Is this one of the sets the athlete would say they did?
 *
 * Narrower than `contributesVolume`, by exactly one clause: **a drop is not a
 * set.** 225x3 stripped to 185x8 is one approach to the bar and one rest
 * period, so it is one set with a drop off it — which is how the session screen
 * already numbers the rows. Counting it as two told the athlete they did four
 * sets when they did three, on the same screen as the rows saying three.
 *
 * Two functions rather than one with a flag: they differ by a clause and are
 * called within lines of each other, so the risk is picking the wrong one, and
 * a name at the call site makes that visible where a boolean would not. The
 * server keeps the same pair — `workingSet` and `countsAsSet`.
 */
export function countsAsSet(set: Pick<LoggedSet, 'completed' | 'set_type'>): boolean {
  return contributesVolume(set) && set.set_type !== 'drop';
}

/**
 * Which of a group's set indices the progression suggestion's "Use" button
 * may write onto — N473/#812, item 7.
 *
 * The prescription itself is computed server-side from a coherent
 * SAME-WEIGHT, STRAIGHT-SET cohort (see `straightWorkingSetsWithWeight` in
 * `backend/internal/modules/session/progression_v2.go`), so it is only ever
 * evidence for another straight working set. A backoff is deliberately
 * lighter than the top set the plan reasons from; a drop exists only
 * because the set before it hit failure; an AMRAP or failure set is
 * measuring something the plan doesn't reason about at all. Writing the
 * plan's weight/reps onto any of those overwrites a number the athlete chose
 * on purpose with one that was never evidence for it.
 *
 * Before this, the button targeted every non-warm-up, not-yet-completed
 * set — backoffs, drops, AMRAPs and failures included — which is exactly the
 * mismatch N473/#812 reports.
 *
 * `set_type` is never blank on a set that has round-tripped through the
 * server — `session_sets.set_type` defaults to `'working'` at the database
 * column, and the backend's own insert path applies that same default to an
 * empty client value before it's ever written. A freshly template-authored
 * set not yet synced can still carry `undefined` here, and that reads as
 * `'working'` too, for the same reason.
 */
export function pendingSuggestableIndices(
  indices: readonly number[],
  sets: readonly Pick<LoggedSet, 'completed' | 'set_type'>[],
): number[] {
  return indices.filter(
    (i) => !sets[i]?.completed && (sets[i]?.set_type ?? 'working') === 'working',
  );
}

/**
 * Metres of distance-measured work in a set of sets.
 *
 * A finished run (`app/running/[id].tsx`'s `finish()`) writes exactly one
 * `session_sets` row against the seeded `run` exercise — `distance_m` and
 * `seconds` set, everything strength-shaped left null — so a running
 * session's distance already lives on the same `LoggedSet[]` every other
 * total in this file reads. This sums it with the identical gate
 * `contributesVolume` already uses for tonnage: a warm-up doesn't count and
 * neither does an uncompleted set, for the same reason a warm-up doesn't
 * contribute kilograms.
 *
 * Not running-only: a strength exercise measured in distance (a sled push, a
 * farmer's carry) sets `distance_m` too, and there is nothing sport-specific
 * about a sum. `leadMeasure` is what decides whether a given sport's total is
 * worth leading with.
 */
export function sessionDistanceMeters(
  sets: Pick<LoggedSet, 'completed' | 'set_type' | 'distance_m'>[],
): number {
  let m = 0;
  for (const s of sets) {
    if (contributesVolume(s) && s.distance_m != null) m += s.distance_m;
  }
  return m;
}

/**
 * Active seconds behind a distance-measured session — the SAME set(s)
 * {@link sessionDistanceMeters} reads, summed on their OWN `seconds` field
 * rather than the session's wall-clock `ended_at - started_at`.
 *
 * The distinction is not cosmetic. `app/running/[id].tsx`'s `finish()`
 * deliberately writes `elapsedMsRef` here — active time, pauses excluded on
 * purpose, per that file's own doc — while a session's timestamps span the
 * WHOLE outing, pause included. Pacing a run's distance over the wall-clock
 * span therefore UNDERSTATES the pace the moment a run is paused even once:
 * the same run would read a faster pace on the live tracking screen (which
 * uses this same active-time figure) than in training history (which used
 * to recompute wall-clock duration instead) — two numbers for one session,
 * for no reason a set ever changed. Gated identically to the distance sum
 * so the two can never disagree about which sets they're describing.
 */
export function sessionActiveSeconds(
  sets: Pick<LoggedSet, 'completed' | 'set_type' | 'distance_m' | 'seconds'>[],
): number {
  let s = 0;
  for (const set of sets) {
    if (contributesVolume(set) && set.distance_m != null && set.seconds != null) s += set.seconds;
  }
  return s;
}

/**
 * The server's `Summarise`, computed locally so a session in progress has
 * numbers before it has been saved.
 *
 * **EXTRACTED FROM THE SESSION SCREEN, and the reason is a measurement rather
 * than a preference.** It lived in a ~2,700-line file, promised in a comment to
 * "match the server's rule exactly", and was the site missed TWICE — once when
 * per-side load landed, so the tile showed half the history's tonnage, and
 * again when drops stopped counting as sets. A comment did not prevent either.
 * It is here now, beside the predicates it depends on and covered by tests, for
 * the same reason `setOrdinals` was moved.
 *
 * Two rules, and the difference is the whole point: `countsAsSet` gates the
 * COUNT, `contributesVolume` gates the sums. A drop adds work and adds no set.
 */
export function localVolume(sets: LoggedSet[]): Volume {
  const v: Volume = {
    working_sets: 0,
    total_reps: 0,
    tonnage_kg: 0,
    hardest_rpe: 0,
    exercise_ids: [],
    warmup_sets: 0,
    warmup_reps: 0,
    warmup_tonnage_kg: 0,
  };
  for (const s of sets) {
    if (!v.exercise_ids.includes(s.exercise_id)) v.exercise_ids.push(s.exercise_id);

    // N495/#865: a completed warm-up set's own reps/tonnage are not simply
    // discarded — they land on the SEPARATE warmup_* fields, mirroring the
    // server's `Summarise` exactly. Still excluded from every WORKING total
    // below, which `contributesVolume` already guards for every other
    // (non-warm-up) case.
    if (s.completed && s.set_type === 'warmup') {
      if (s.reps != null) {
        v.warmup_sets++;
        v.warmup_reps += s.reps;
        if (s.weight_kg != null) {
          const total = totalWeightKg(s);
          if (total != null) v.warmup_tonnage_kg += s.reps * total;
        }
      }
      continue;
    }

    // Must match the server's rule exactly. Missing this on the first pass
    // showed the plan's full volume against a column of unticked sets —
    // precisely the drift this duplicated arithmetic risks.
    if (!contributesVolume(s)) continue;
    // The COUNT takes the narrower rule while the sums below take the wider
    // one — a drop adds work but not a set. Both live in `lib/sessions.ts`
    // rather than being spelled out here, because this function has now been
    // the one missed TWICE: once when per-side load landed and the tile read
    // half the history's tonnage, and again here. Inline predicates are how a
    // duplicated rule drifts, and this is the duplicate furthest from the
    // original.
    if (countsAsSet(s)) {
      v.working_sets++;
    }
    if (s.rpe != null && s.rpe > v.hardest_rpe) v.hardest_rpe = s.rpe;
    if (s.reps != null) {
      v.total_reps += s.reps;
      // `totalWeightKg`, not the raw number: for a PAIR of dumbbells
      // `weight_kg` is one of the two. The comment above promises this matches
      // the server's rule, and for a while it silently did not — this tile and
      // the finish-card sat next to a Today header and a calendar that had all
      // been converted, so one session read half on one screen and double on
      // another. Same phone, same session.
      //
      // `total == null` is the EXPLICITLY-UNRESOLVED state (#425) — an
      // offline swap whose factor could not be looked up. Its contribution is
      // left OUT of the sum rather than guessed, which under-counts this
      // number by exactly that set's tonnage until sync resolves it. That is
      // deliberate: `hasUnresolvedLoad` below is what tells a caller the
      // total itself is not trustworthy yet, so it can withhold the whole
      // figure rather than show a number that is merely a little short. See
      // its own doc for why the two functions divide the work this way
      // instead of `Volume.tonnage_kg` itself carrying the unknown.
      if (s.weight_kg != null) {
        const total = totalWeightKg(s);
        if (total != null) v.tonnage_kg += s.reps * total;
      }
    }
  }
  return v;
}

/**
 * True when any set `localVolume` would count carries an EXPLICITLY
 * UNRESOLVED `load_factor` (`null`) — an offline exercise swap whose new
 * exercise's `implements` was not in the local catalog.
 *
 * A caller checks this BEFORE trusting `localVolume(sets).tonnage_kg`.
 * `Volume` itself stays a plain `number` — it mirrors the server's response
 * shape (`session.Volume` on the wire), and a nullable field there would leak
 * this mobile-only, offline-swap-specific state into a type synced sessions
 * decode into too. Splitting the two is what lets `localVolume` under-count
 * by the unresolved set's own tonnage (see its comment) while this function
 * gives the session screen what it needs to show "—" instead of that
 * under-count — which is the "absent beats wrong" rule #425 asks for, applied
 * to the one number an athlete actually reads after a swap.
 */
export function hasUnresolvedLoad(
  sets: Pick<LoggedSet, 'completed' | 'set_type' | 'weight_kg' | 'load_factor'>[],
): boolean {
  return sets.some(
    (s) => contributesVolume(s) && s.weight_kg != null && s.load_factor === null,
  );
}

/**
 * Whether a timestamp belongs to a calendar day already closed, in the
 * device's own local time.
 *
 * Backs "Correct this session" (N435): the product owner's ruling reversed
 * the finished-session-is-locked design, but only for *past* sessions — a
 * session that finished five minutes ago still gets the "is this locked in"
 * moment the read-only state exists for, so the edit affordance is withheld
 * until the day it happened is actually over. `session.started_at` is what
 * this is compared against (not `ended_at`), matching the day-bucketing
 * `trainingSince`'s SQL already uses (`date(started_at, 'localtime')`) —
 * two conventions for "which day does this session belong to" would let them
 * disagree at exactly the boundary either one is for.
 *
 * Compared as calendar days rather than elapsed hours: a session that ended
 * at 11:58pm is still "today" for two more minutes, and an elapsed-time
 * cutoff would make the answer flip depending on when you happen to look,
 * which a calendar-day boundary does not. `now` is a parameter (defaulting to
 * the real clock) so this is testable without faking system time.
 */
export function isPastLocalDay(iso: string, now: Date = new Date()): boolean {
  // Strictly LESS THAN, not merely "a different day" — `!==` would also call
  // a FUTURE local day "past" (a rolled-back device clock, or a session
  // synced from a device several timezones east), which would unlock
  // "Correct this session" on something that hasn't happened locally yet.
  const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return startOfLocalDay(new Date(iso)) < startOfLocalDay(now);
}
