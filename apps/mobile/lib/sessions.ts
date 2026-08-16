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
 * "the drop off set 3" rather than as a set with no identity.
 *
 * Extracted from the session screen for the reason `ClampLimit` and
 * `ScopeFilter` were on the server: the rule is small, easy to get subtly
 * wrong, and untestable where it was.
 */
export function setOrdinals(setsInGroup: Pick<LoggedSet, 'set_type'>[]): number[] {
  let n = 0;
  return setsInGroup.map((s) => {
    if (s.set_type !== 'drop') n++;
    // A leading drop has no parent to borrow from. It is a client bug either
    // way, and 1 keeps it readable instead of showing a zero.
    return Math.max(1, n);
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
 * The drop sets hanging off the set at `i` — the consecutive `drop` rows
 * immediately following it, of the same exercise.
 *
 * Mirrors the server's `DropsOf`, including the contiguity rule rather than
 * "nearest preceding": a drop after a DIFFERENT exercise breaks the run and is
 * orphaned, so a stray row can never attach reps to somebody else's lift. The
 * two implementations have to agree, because the relationship exists only as
 * order — there is no id linking a drop to its parent, and there cannot be one
 * while the server replaces every row on save.
 */
export function dropsOf(sets: LoggedSet[], i: number): LoggedSet[] {
  if (i < 0 || i >= sets.length || sets[i].set_type === 'drop') return [];
  const out: LoggedSet[] = [];
  for (let j = i + 1; j < sets.length; j++) {
    if (sets[j].set_type !== 'drop') break;
    if (sets[j].exercise_id !== sets[i].exercise_id) break;
    out.push(sets[j]);
  }
  return out;
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
 */
export function repairSet<T extends LoggedSet>(set: T): T {
  const measure = (v: number | null): number | null =>
    v != null && Number.isFinite(v) && v > 0 ? v : null;
  return {
    ...set,
    reps: measure(set.reps),
    weight_kg: measure(set.weight_kg),
    seconds: measure(set.seconds),
    distance_m: measure(set.distance_m),
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
