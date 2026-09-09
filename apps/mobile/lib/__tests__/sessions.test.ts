import {
  applyEffortEntry,
  fillForward,
  pendingSuggestableIndices,
  repairSet,
  reorderGroups,
  reorderedIndices,
  roundDistanceM,
  sessionActiveSeconds,
  sessionDistanceMeters,
  setsFromWorkout,
  type LoggedSet,
  type Measure,
} from '../sessions';
import type { WorkoutItem } from '../workouts';

/**
 * The pure set transforms behind in-session editing.
 *
 * One of these caught a real bug the day it was written: `fillForward`
 * filtered on `exercise_id` without stopping at the group boundary, so
 * squat / bench / squat filled the *second* squat block from the first —
 * contradicting the function's own doc comment.
 */

const set = (exercise: string, over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: exercise,
  position: 0,
  set_type: 'working',
  reps: null,
  weight_kg: null,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: false,
  ...over,
});

const REPS_AND_WEIGHT: Measure[] = ['reps', 'weight'];

describe('sessionDistanceMeters', () => {
  it('sums distance across completed sets', () => {
    const sets = [
      set('run', { completed: true, distance_m: 5000 }),
      set('run', { completed: true, distance_m: 3000 }),
    ];
    expect(sessionDistanceMeters(sets)).toBe(8000);
  });

  it('excludes an uncompleted set — the same gate tonnage uses', () => {
    const sets = [
      set('run', { completed: true, distance_m: 5000 }),
      set('run', { completed: false, distance_m: 3000 }),
    ];
    expect(sessionDistanceMeters(sets)).toBe(5000);
  });

  it('excludes a warm-up, same as `contributesVolume` for tonnage', () => {
    const sets = [
      set('sled-push', { completed: true, set_type: 'warmup', distance_m: 20 }),
      set('sled-push', { completed: true, distance_m: 40 }),
    ];
    expect(sessionDistanceMeters(sets)).toBe(40);
  });

  it('ignores sets with no distance recorded rather than treating null as zero-and-summed', () => {
    const sets = [set('bench-press', { completed: true, reps: 5, weight_kg: 100 })];
    expect(sessionDistanceMeters(sets)).toBe(0);
  });

  it('returns 0 for an empty set list', () => {
    expect(sessionDistanceMeters([])).toBe(0);
  });
});

// N490/#851 — a template's rows have never been performed, so nothing here
// may claim a completion time on their behalf. Only live ticking
// (`toggleDone`/`recordTimedSet` in the session screen) may ever write a
// real `performed_at`.
describe('setsFromWorkout', () => {
  const item = (over: Partial<WorkoutItem> = {}): WorkoutItem => ({
    exercise_id: 'back-squat',
    position: 0,
    target_sets: 1,
    target_reps: 5,
    target_weight_kg: 100,
    target_seconds: null,
    target_distance_m: null,
    notes: '',
    ...over,
  });

  it('every row starts with performed_at null, not omitted or inherited from the template', () => {
    const sets = setsFromWorkout([item({ target_sets: 3 })]);
    expect(sets).toHaveLength(3);
    for (const s of sets) {
      expect(s.performed_at).toBeNull();
    }
  });
});

/**
 * N473/#812, item 7: the progression suggestion's "Use" button used to
 * target every non-warm-up, not-yet-completed set — backoffs, drops, AMRAPs
 * and failures included. The prescription is computed server-side from a
 * coherent straight-set cohort, so it is only ever evidence for another
 * straight working set.
 */
describe('pendingSuggestableIndices', () => {
  it('excludes a backoff set', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: false }),
      set('back-squat', { set_type: 'backoff', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([0]);
  });

  it('excludes a drop set', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: false }),
      set('back-squat', { set_type: 'drop', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([0]);
  });

  it('excludes an AMRAP set', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: false }),
      set('back-squat', { set_type: 'amrap', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([0]);
  });

  it('excludes a failure set', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: false }),
      set('back-squat', { set_type: 'failure', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([0]);
  });

  it('still excludes a warm-up (the pre-existing behaviour)', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: false }),
      set('back-squat', { set_type: 'warmup', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([0]);
  });

  it('still excludes an already-completed working set', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: true }),
      set('back-squat', { set_type: 'working', completed: false }),
    ];
    expect(pendingSuggestableIndices([0, 1], sets)).toEqual([1]);
  });

  it('treats an undefined set_type as working, matching the backend default', () => {
    const sets = [
      { ...set('back-squat'), set_type: undefined as unknown as LoggedSet['set_type'] },
    ];
    expect(pendingSuggestableIndices([0], sets)).toEqual([0]);
  });

  it('includes every pending working set in a mixed group', () => {
    const sets = [
      set('back-squat', { set_type: 'working', completed: true }), // done
      set('back-squat', { set_type: 'working', completed: false }), // pending, eligible
      set('back-squat', { set_type: 'backoff', completed: false }), // pending, excluded
      set('back-squat', { set_type: 'working', completed: false }), // pending, eligible
    ];
    expect(pendingSuggestableIndices([0, 1, 2, 3], sets)).toEqual([1, 3]);
  });
});

describe('sessionActiveSeconds', () => {
  // The whole reason this function exists rather than reusing a session's
  // wall-clock `ended_at - started_at`: a paused run's active time is
  // SHORTER than its wall-clock span, and pacing off the wrong one
  // understates the pace — a real self-contradiction between the live
  // tracking screen (active time) and training history (used to be
  // wall-clock) for the SAME session. This pins the active-time reading
  // directly, independent of any session timestamps.
  it('sums the sets’ own seconds field, not a wall-clock span', () => {
    const sets = [set('run', { completed: true, distance_m: 5000, seconds: 1800 })];
    expect(sessionActiveSeconds(sets)).toBe(1800);
  });

  it('sums across multiple distance-carrying sets', () => {
    const sets = [
      set('run', { completed: true, distance_m: 5000, seconds: 1800 }),
      set('run', { completed: true, distance_m: 3000, seconds: 1200 }),
    ];
    expect(sessionActiveSeconds(sets)).toBe(3000);
  });

  it('excludes a set with no distance — its seconds describe something else', () => {
    const sets = [
      set('run', { completed: true, distance_m: 5000, seconds: 1800 }),
      set('plank', { completed: true, distance_m: null, seconds: 60 }),
    ];
    expect(sessionActiveSeconds(sets)).toBe(1800);
  });

  it('excludes an uncompleted or warm-up set, same gate as the distance sum', () => {
    const sets = [
      set('run', { completed: false, distance_m: 5000, seconds: 1800 }),
      set('run', { completed: true, set_type: 'warmup', distance_m: 1000, seconds: 300 }),
    ];
    expect(sessionActiveSeconds(sets)).toBe(0);
  });

  it('returns 0 for an empty set list', () => {
    expect(sessionActiveSeconds([])).toBe(0);
  });
});

describe('fillForward', () => {
  it('fills the planned sets below with what was entered', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat'), set('squat')];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ reps: 5, weight_kg: 100 });
    expect(out[2]).toMatchObject({ reps: 5, weight_kg: 100 });
  });

  it('never overwrites a value already typed', () => {
    // A top set followed by back-offs is a real plan; flattening it silently
    // would be worse than the typing this saves.
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { weight_kg: 80 })];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1].weight_kg).toBe(80);
  });

  it('still fills the measures that are blank on a partly-filled set', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { weight_kg: 80 })];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[1].reps).toBe(5);
  });

  it('leaves a completed set alone — it records something that happened', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('squat', { completed: true })];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ reps: null, weight_kg: null });
  });

  it('stops at the next exercise', () => {
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('bench'), set('squat')];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[1].weight_kg).toBeNull();
  });

  it('does not reach a LATER block of the same exercise', () => {
    // The regression this suite was started for. Groups are adjacency-based,
    // so squat/bench/squat is two separate pieces of work.
    const sets = [set('squat', { reps: 5, weight_kg: 100 }), set('bench'), set('squat')];
    expect(fillForward(sets, 0, REPS_AND_WEIGHT)[2].weight_kg).toBeNull();
  });

  it('never carries effort', () => {
    // The third set at one weight is not the first set's effort; prefilling
    // invites recording a number nobody judged.
    const sets = [set('squat', { reps: 5, weight_kg: 100, rir: 2, rpe: 8 }), set('squat')];
    const out = fillForward(sets, 0, REPS_AND_WEIGHT);
    expect(out[1]).toMatchObject({ rir: null, rpe: null });
  });

  it('never fills a set ABOVE the one entered', () => {
    // Every other case here starts at index 0, so no fixture had a row above
    // the source — meaning `i <= index` could be deleted and nothing noticed.
    const sets = [set('squat'), set('squat', { reps: 5, weight_kg: 100 }), set('squat')];
    const out = fillForward(sets, 1, REPS_AND_WEIGHT);
    expect(out[0]).toMatchObject({ reps: null, weight_kg: null });
    expect(out[2]).toMatchObject({ reps: 5, weight_kg: 100 });
  });

  it('returns the same array when nothing changed, so callers can skip a write', () => {
    const sets = [set('squat', { reps: 5 }), set('squat', { reps: 3 })];
    expect(fillForward(sets, 0, ['reps'])).toBe(sets);
  });
});

describe('reorderedIndices — the permutation reorderGroups is built on', () => {
  const sets = [set('a', { reps: 1 }), set('b', { reps: 2 }), set('c', { reps: 3 })];
  const order = [[0], [1], [2]];

  it('agrees with reorderGroups, so the two cannot drift apart (N543/#981)', () => {
    // The session screen uses this to carry its collapsed-group state across
    // a move, and builds the moved set list from the same array. If these
    // two ever disagreed, the fold state would describe a list nobody has.
    for (const [gi, delta] of [
      [0, 1],
      [1, -1],
      [1, 1],
      [2, -1],
    ] as [number, -1 | 1][]) {
      const moved = reorderedIndices(order, gi, delta);
      const viaGroups = reorderGroups(sets, order, gi, delta);
      expect(moved).not.toBeNull();
      expect(viaGroups).not.toBeNull();
      expect(moved!.map((i, position) => ({ ...sets[i], position }))).toEqual(viaGroups);
    }
  });

  it('returns null off either end, same as reorderGroups', () => {
    expect(reorderedIndices(order, 0, -1)).toBeNull();
    expect(reorderedIndices(order, 2, 1)).toBeNull();
  });

  it('never mutates the order it is given', () => {
    const input = [[0], [1], [2]];
    reorderedIndices(input, 0, 1);
    expect(input).toEqual([[0], [1], [2]]);
  });
});

describe('reorderGroups', () => {
  const sets = [set('a', { reps: 1 }), set('a', { reps: 2 }), set('b', { reps: 3 })];
  const order = [
    [0, 1],
    [2],
  ];

  it('moves a group with all of its sets', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.exercise_id)).toEqual(['b', 'a', 'a']);
  });

  it('renumbers positions contiguously, because the server orders by them', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it('carries set contents through the move', () => {
    const out = reorderGroups(sets, order, 1, -1)!;
    expect(out.map((s) => s.reps)).toEqual([3, 1, 2]);
  });

  it('refuses to move off either end', () => {
    expect(reorderGroups(sets, order, 0, -1)).toBeNull();
    expect(reorderGroups(sets, order, 1, 1)).toBeNull();
  });
});

/*
 * `repairSet` — the rules the API enforces, restated where a set is read.
 *
 * Every measure is "absent, or greater than zero" server-side, and a violation
 * is a 400: a PERMANENT rejection that strands the whole session on the phone.
 * These cases are the ones `validateSets` actually refuses, so if that function
 * changes, this is what should go red.
 */
describe('repairSet', () => {
  it('drops a measure the server cannot store, and keeps the ones it can', () => {
    const out = repairSet(
      set('squat', { reps: 5, weight_kg: 0, seconds: 0, distance_m: 0 }),
    );
    expect(out).toMatchObject({ reps: 5, weight_kg: null, seconds: null, distance_m: null });
  });

  /*
   * N507/#884 — `distance_m` is `*int` on the wire (unlike `weight_kg`, a
   * `*float64`), so a fractional value from a GPS haversine sum or a
   * HealthKit `HKQuantity.doubleValue` fails to DECODE server-side rather
   * than being refused by validation — collapsed into the same generic
   * "invalid JSON body" every malformed request gets, and permanently
   * stuck on the Sync screen. This is `repairSet`'s half of the fix: it is
   * the ONE gate every stored session's sets go through before either the
   * screen or a push sees them (`parseSets` in `sessionStore.ts`), so
   * rounding here — not just at each write site — is what heals a run
   * ALREADY stuck on-device with a fractional value from before this
   * shipped, the next time anything touches it.
   */
  it('rounds a fractional distance to the nearest whole metre, matching the *int wire type', () => {
    expect(repairSet(set('run', { distance_m: 2011.4523 })).distance_m).toBe(2011);
    expect(repairSet(set('run', { distance_m: 2011.5 })).distance_m).toBe(2012);
    // A whole number already — the common case, and the reason every mobile
    // fixture happened to miss this bug (JSON.stringify(2011.0) === "2011").
    expect(repairSet(set('run', { distance_m: 2011 })).distance_m).toBe(2011);
  });

  it('rounds a fractional distance down to zero into null, not 0 — zero is not data here either', () => {
    expect(repairSet(set('run', { distance_m: 0.4 })).distance_m).toBeNull();
    expect(repairSet(set('run', { distance_m: -0.4 })).distance_m).toBeNull();
  });

  it('keeps 0 RIR, which is a real answer', () => {
    // Nothing left in the tank. The server takes 0-20, so nulling this would be
    // deleting data to fix a different bug.
    expect(repairSet(set('squat', { rir: 0 })).rir).toBe(0);
    expect(repairSet(set('squat', { rir: 21 })).rir).toBeNull();
  });

  it('drops an RPE outside 1-10, including 0', () => {
    // Unlike RIR, this scale starts at 1 — so a 0 is the same unstorable
    // non-answer as a 0kg lift.
    expect(repairSet(set('squat', { rpe: 0 })).rpe).toBeNull();
    expect(repairSet(set('squat', { rpe: 11 })).rpe).toBeNull();
    expect(repairSet(set('squat', { rpe: 8 })).rpe).toBe(8);
  });

  /*
   * `assisted_reps` is clamped by `withSetChange` while a set is being edited.
   * This is the other end: rows written before that clamp existed, and rows
   * pulled from the server and stored verbatim, neither of which any editor
   * ever passes over.
   */
  it('drops assisted reps that can no longer stand', () => {
    const spotted = { ...set('bench', { reps: 8 }), assisted_reps: 3 };

    // The reachable one: edit the reps to 0 and the rep count the assisted
    // figure is "part of" disappears underneath it.
    expect(repairSet({ ...spotted, reps: 0 })).toMatchObject({
      reps: null,
      assisted_reps: null,
    });
    // More assisted than performed, and negative — both refused by name.
    expect(repairSet({ ...spotted, reps: 2 }).assisted_reps).toBeNull();
    expect(repairSet({ ...spotted, assisted_reps: -1 }).assisted_reps).toBeNull();
    // Legal, and left alone. 0 means "none of them were assisted", which is a
    // different answer from not recording it.
    expect(repairSet(spotted).assisted_reps).toBe(3);
    expect(repairSet({ ...spotted, assisted_reps: 0 }).assisted_reps).toBe(0);
  });

  it('keeps a grip this build does not recognise, because only the server owns the vocabulary', () => {
    // T4. The picker only ever writes a value from GRIPS, so an unrecognised
    // grip can only have come from the server — which means the server accepts
    // it. The old guard checked `GRIPS.some(...)` and nulled anything else, so
    // the day a fifth value shipped, every phone on an older build would read a
    // legitimate `mixed`, null it, and the wholesale PUT would write that null
    // back over data the athlete really recorded. Silently.
    //
    // **The probe must be OUTSIDE the current vocabulary, and N9 broke that
    // here.** This line read `'mixed'` until then; adding `mixed` to the union
    // turned it into a check that a KNOWN value survives — still green, and
    // covering nothing, since reverting the guard to `GRIPS.some(...)` would
    // have left it passing. Its twin in `grip.test.ts` was re-pointed and this
    // one was missed; review caught it. Whoever ships `mixed_left` must move
    // this again.
    const future = set('bench-press', { grip: 'mixed_left' as never });
    expect(repairSet(future).grip).toBe('mixed_left');

    // The six it does know are untouched, obviously.
    for (const g of ['regular', 'neutral', 'reverse', 'angled', 'mixed', 'hook'] as const) {
      expect(repairSet(set('bench-press', { grip: g })).grip).toBe(g);
    }
    // And "not recorded" still means not recorded — never coerced to a default.
    expect(repairSet(set('bench-press', { grip: null })).grip).toBeNull();
  });

  it('still nulls a grip that could not be a value at all', () => {
    // The half that survives: SHAPE is decidable here, vocabulary is not. An
    // empty string or a non-string is not a grip on any server, so it is still
    // dropped rather than left to strand the session on a permanent 400.
    expect(repairSet(set('bench-press', { grip: '' as never })).grip).toBeNull();
    expect(repairSet(set('bench-press', { grip: 7 as never })).grip).toBeNull();
  });

  it('does not give a set an assisted_reps key it never had', () => {
    // Sent on every push, so inventing the field would start claiming "none
    // were assisted" about sets nobody recorded that for.
    expect('assisted_reps' in repairSet(set('squat', { reps: 0 }))).toBe(false);
  });
});

/*
 * `roundDistanceM` — the one shared mechanism behind ALL of N507/#884's fix,
 * per this ticket's own acceptance criterion: `healthkitSync.ts`,
 * `detectedActivity.ts` and `app/running/[id].tsx`'s finish handler all call
 * this rather than each rolling its own `Math.round`, and `repairSet` above
 * calls it too, which is what heals an already-stuck on-device row. See its
 * own doc comment in `sessions.ts` for the full argument.
 */
describe('roundDistanceM', () => {
  it('rounds to the nearest whole metre', () => {
    expect(roundDistanceM(2011.4523)).toBe(2011);
    expect(roundDistanceM(2011.5)).toBe(2012);
    expect(roundDistanceM(2011)).toBe(2011);
  });

  it('treats null, undefined and non-finite input as no distance', () => {
    expect(roundDistanceM(null)).toBeNull();
    expect(roundDistanceM(undefined)).toBeNull();
    expect(roundDistanceM(NaN)).toBeNull();
    expect(roundDistanceM(Infinity)).toBeNull();
  });

  it('rounds a value that rounds to zero or below into null — zero is not a distance', () => {
    expect(roundDistanceM(0.4)).toBeNull();
    expect(roundDistanceM(0)).toBeNull();
    expect(roundDistanceM(-5)).toBeNull();
  });
});

/**
 * N525/#940 — RIR and RPE are two views of one quantity, and letting a set
 * carry both is what produced `effort_conflict` abstentions in the v2
 * progression engine (599 of 944 real sets carried both; 139 disagreed by
 * 2+ points of implied reserve, and v2 then refused to suggest anything on
 * 26 of 100 athlete/exercise pairs). Entry is now exclusive.
 */
describe('applyEffortEntry — RIR and RPE are mutually exclusive (N525/#940)', () => {
  const base = { rir: null as number | null, rpe: null as number | null };

  it('a real RIR displaces an existing RPE', () => {
    const got = applyEffortEntry({ ...base, rpe: 8 }, 'rir', '2');
    expect(got).toEqual({ rir: 2, rpe: null });
  });

  it('a real RPE displaces an existing RIR', () => {
    const got = applyEffortEntry({ ...base, rir: 2 }, 'rpe', '8');
    expect(got).toEqual({ rir: null, rpe: 8 });
  });

  it('CLEARING a field displaces nothing — deleting RIR must not wipe an RPE', () => {
    // The counterpart cannot normally be set at the same time any more, but a
    // historical set (or a mid-edit state) can carry both, and emptying one
    // is a correction rather than a choice of which scale to log in.
    expect(applyEffortEntry({ rir: 2, rpe: 8 }, 'rir', '')).toEqual({ rir: null, rpe: 8 });
    expect(applyEffortEntry({ rir: 2, rpe: 8 }, 'rpe', '   ')).toEqual({ rir: 2, rpe: null });
  });

  it('unparseable text clears its own field and still displaces nothing', () => {
    expect(applyEffortEntry({ rir: 2, rpe: 8 }, 'rpe', 'hard')).toEqual({ rir: 2, rpe: null });
  });

  it('rounds RIR to whole reps but keeps RPE fractional', () => {
    // You cannot leave 1.5 reps in the tank; RPE 7.5 is conventional.
    expect(applyEffortEntry(base, 'rir', '1.6')).toEqual({ rir: 2, rpe: null });
    expect(applyEffortEntry(base, 'rpe', '7.5')).toEqual({ rir: null, rpe: 7.5 });
  });

  it('accepts a comma decimal separator, as the other numeric fields do', () => {
    expect(applyEffortEntry(base, 'rpe', '7,5')).toEqual({ rir: null, rpe: 7.5 });
  });

  it('keeps RIR 0 — "nothing left in the tank" is a real answer, not absence', () => {
    const got = applyEffortEntry({ ...base, rpe: 9 }, 'rir', '0');
    expect(got.rir).toBe(0);
    expect(got.rpe).toBeNull();
  });

  it('preserves every other field on the set', () => {
    const set = { exercise_id: 'squat', position: 1, reps: 5, rir: null, rpe: 8 };
    expect(applyEffortEntry(set, 'rir', '2')).toEqual({
      exercise_id: 'squat',
      position: 1,
      reps: 5,
      rir: 2,
      rpe: null,
    });
  });

  it('a set that already carries both survives being opened and stays editable', () => {
    // The 599 historical sets are not rewritten by this change; they are only
    // reconciled when the athlete next touches one of the two fields.
    const historical = { rir: 0, rpe: 8 };
    expect(applyEffortEntry(historical, 'rir', '0')).toEqual({ rir: 0, rpe: null });
  });
});
