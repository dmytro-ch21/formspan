import {
  badgeFor,
  celebratesStreak,
  downsampleRoute,
  feltFor,
  formatDuration,
  prBadgeFor,
  prEvidence,
  recordsFromSession,
  regionForRoute,
  statsFor,
  subtitleFor,
  summariseSession,
  topRecord,
  type RunningSessionDetail,
  type SessionRecord,
  type SessionSummary,
  worthCelebrating,
} from '../celebration';
import type { ExerciseRecords, PersonalRecord } from '../records';

/**
 * What the card is allowed to claim.
 *
 * Almost every assertion here is about something NOT being shown — a badge that
 * does not appear, a zero that is omitted, a self-rating that stays out of the
 * measurements. That is the shape of the risk: a celebration screen fails by
 * congratulating someone for nothing, or by presenting a number it made up
 * beside numbers it measured, and neither of those throws.
 */

const record = (over: Partial<PersonalRecord> = {}): PersonalRecord => ({
  kind: 'heaviest_weight',
  value: 100,
  reps: 5,
  weight_kg: 100,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  achieved_at: '2026-08-07T10:00:00Z',
  session_id: 'S1',
  is_recent: true,
  ...over,
});

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  title: 'Push Day A',
  sport: 'strength',
  durationSeconds: 3600,
  exercises: 4,
  sets: 12,
  reps: 96,
  tonnageKg: 4200,
  hardestRpe: null,
  records: [],
  recordExerciseIDs: [],
  ...over,
});

const kg = (n: number) => `${Math.round(n)} kg`;

describe('which records this session set', () => {
  const all: ExerciseRecords[] = [
    { exercise_id: 'bench', records: [record({ session_id: 'S1' }), record({ session_id: 'S9' })] },
    { exercise_id: 'squat', records: [record({ session_id: 'S9' })] },
  ];

  it('keeps only the ones this session produced', () => {
    // The server already decided what counts as a record and stamped the
    // session that set it. Getting this filter wrong celebrates somebody
    // else's lift on your card.
    const got = recordsFromSession(all, 'S1');
    expect(got).toHaveLength(1);
    expect(got[0].exerciseID).toBe('bench');
  });

  it('claims nothing for a session that set none', () => {
    expect(recordsFromSession(all, 'S5')).toEqual([]);
  });

  it('claims nothing when the id is missing, even against a blank-stamped record', () => {
    /*
      The fixture needs the blank record for this to mean anything.

      Against records that all carry a real session id, an empty argument
      matches nothing whether the guard exists or not — so the first version of
      this test passed with the guard deleted, proving only that '' !== 'S1'.
      A record whose own `session_id` is blank is the case the guard is for: a
      malformed or partially-written row would otherwise be handed to whichever
      session happened to finish while the id was still resolving.
    */
    const withBlank: ExerciseRecords[] = [
      ...all,
      { exercise_id: 'deadlift', records: [record({ session_id: '' })] },
    ];
    expect(recordsFromSession(withBlank, '')).toEqual([]);
    // And it still finds a real one in the same set.
    expect(recordsFromSession(withBlank, 'S1')).toHaveLength(1);
  });

  it('is empty when records could not be fetched at all', () => {
    // Offline is the ordinary case in a basement gym. Silence is not a claim.
    expect(recordsFromSession([], 'S1')).toEqual([]);
  });

  it('resolves each record to the name its own exercise id maps to (N447/#745)', () => {
    // Not the FIRST id, not a constant — the resolver has to be called per
    // exercise. A mutation that hard-coded one name or ignored the argument
    // would still pass a single-exercise fixture.
    const two: ExerciseRecords[] = [
      { exercise_id: 'bench', records: [record({ session_id: 'S1' })] },
      { exercise_id: 'squat', records: [record({ session_id: 'S1' })] },
    ];
    const names: Record<string, string> = { bench: 'Bench Press', squat: 'Back Squat' };
    const got = recordsFromSession(two, 'S1', (id) => names[id] ?? null);
    expect(got.find((r) => r.exerciseID === 'bench')?.exerciseName).toBe('Bench Press');
    expect(got.find((r) => r.exerciseID === 'squat')?.exerciseName).toBe('Back Squat');
  });

  it('carries no name at all when no resolver is given', () => {
    // The default behaviour every caller that only cares about the FILTER
    // (this file's other tests, the celebration modal) relies on.
    const got = recordsFromSession(all, 'S1');
    expect(got[0].exerciseName).toBeFalsy();
  });
});

describe('the PR badge (N447/#745)', () => {
  const named = (exerciseID: string, exerciseName: string | null, over: Partial<PersonalRecord> = {}): SessionRecord => ({
    exerciseID,
    exerciseName,
    record: record(over),
  });

  describe('topRecord', () => {
    it('is null when the session set nothing', () => {
      expect(topRecord([])).toBeNull();
    });

    it('picks the FIRST record when there is more than one', () => {
      // Pins "top one only" — see the function's own doc for why. A mutation
      // that picked the last, or joined both, needs two DISTINCT records to
      // be caught, which is why this fixture uses two different exercises
      // rather than one repeated.
      const bench = named('bench', 'Bench Press');
      const squat = named('squat', 'Back Squat');
      expect(topRecord([bench, squat])).toBe(bench);
      expect(topRecord([squat, bench])).toBe(squat);
    });
  });

  describe('prEvidence', () => {
    const fmt = (kg: number) => `${Math.round(kg)}kg`;

    it('reads the measured weight and reps, in "weight × reps" order', () => {
      expect(prEvidence({ weight_kg: 152, reps: 5 }, fmt)).toBe('152kg × 5');
    });

    it('never prints the calculated 1RM — the whole point of this ticket', () => {
      // `estimated_1rm`'s `value` IS the model's output (see `RECORD_BASIS`
      // in `lib/records.ts`); the call site passes the WHOLE record, exactly
      // like `prBadgeFor` does with `top.record`, so this pins that
      // `prEvidence` reads `weight_kg`/`reps` off it and never `value` — a
      // mutation that swapped in `record.value` would print 999 here.
      const estimated1rm = record({ kind: 'estimated_1rm', value: 999, weight_kg: 100, reps: 3 });
      expect(prEvidence(estimated1rm, fmt)).toBe('100kg × 3');
      expect(prEvidence(estimated1rm, fmt)).not.toContain('999');
    });

    it('falls back to a bare rep count with no weight', () => {
      expect(prEvidence({ weight_kg: null, reps: 20 }, fmt)).toBe('20 reps');
    });

    it('is null with neither — the kinds this format does not cover', () => {
      expect(prEvidence({ weight_kg: null, reps: null }, fmt)).toBeNull();
    });
  });

  describe('prBadgeFor', () => {
    const fmt = (kg: number) => `${Math.round(kg)}kg`;

    it('matches the shape the ticket asked for', () => {
      const records = [named('back-squat', 'Back Squat', { weight_kg: 152, reps: 5 })];
      expect(prBadgeFor(records, fmt)).toBe('Back Squat · 152kg × 5 PR');
    });

    it('is null with no records', () => {
      expect(prBadgeFor([], fmt)).toBeNull();
    });

    it('is null rather than a raw id when the name never resolved', () => {
      const records = [named('back-squat', null, { weight_kg: 152, reps: 5 })];
      expect(prBadgeFor(records, fmt)).toBeNull();
    });

    it('is null when the top record has no describable evidence', () => {
      const records = [named('plank', 'Plank', { weight_kg: null, reps: null })];
      expect(prBadgeFor(records, fmt)).toBeNull();
    });

    it('captions only the top record when the session set several', () => {
      const records = [
        named('back-squat', 'Back Squat', { weight_kg: 152, reps: 5 }),
        named('bench-press', 'Bench Press', { weight_kg: 100, reps: 3 }),
      ];
      const badge = prBadgeFor(records, fmt);
      expect(badge).toContain('Back Squat');
      expect(badge).not.toContain('Bench Press');
    });
  });
});

describe('the badge', () => {
  it('appears for a personal record', () => {
    expect(badgeFor({ records: [{ exerciseID: 'bench', record: record() }] })).toEqual({
      key: 'record',
      label: 'Personal record',
    });
  });

  it('counts them when there is more than one', () => {
    expect(
      badgeFor({
        records: [
          { exerciseID: 'bench', record: record() },
          { exerciseID: 'row', record: record() },
        ],
      })?.label,
    ).toBe('2 personal records');
  });

  it('does NOT appear for an ordinary session', () => {
    // The one that keeps the others meaningful. A badge on every session is
    // wallpaper — unread within a week, and it takes the real ones with it.
    expect(badgeFor({ records: [] })).toBeNull();
  });

  /*
    The mat's half. A BJJ first fills the same single slot, and the precedence
    lives here rather than in the card's JSX precisely so it can be pinned:
    "records, then an accomplishment, then nothing" is a rule, and a rule
    expressed as a `??` inside a render is one nothing can test.
  */
  it('shows a BJJ first when there are no records', () => {
    expect(badgeFor({ records: [] }, { label: 'First technique landed' })).toEqual({
      key: 'accomplishment',
      label: 'First technique landed',
    });
  });

  it('still shows nothing when neither exists', () => {
    expect(badgeFor({ records: [] }, null)).toBeNull();
  });

  it('prefers the record if both somehow arrive', () => {
    // Unreachable today — a session is one sport, so a strength session has no
    // accomplishment and a BJJ session has no records. Pinned anyway, because
    // the safe direction is the MEASURED thing winning rather than whichever
    // was checked first, and that should not silently invert.
    expect(
      badgeFor({ records: [{ exerciseID: 'bench', record: record() }] }, { label: 'A first' }),
    ).toEqual({ key: 'record', label: 'Personal record' });
  });
});

describe('whether to show a card at all', () => {
  it('skips a session where nothing was logged', () => {
    // Opened, nothing done, finished. Congratulating that is the hollow praise
    // that teaches people to ignore the app.
    expect(worthCelebrating({ sets: 0 })).toBe(false);
  });

  it('celebrates one logged set', () => {
    expect(worthCelebrating({ sets: 1 })).toBe(true);
  });

  it('celebrates a BJJ session with rounds but no sets', () => {
    // BJJ logs no sets at all, so a sets-only check would silently suppress
    // the card for an entire sport.
    expect(worthCelebrating({ sets: 0, rounds: 5 })).toBe(true);
  });

  describe('running', () => {
    it('skips a run with neither distance nor duration', () => {
      // A run has neither sets nor rounds — a sets-only check would silently
      // suppress the card for the WHOLE sport, the exact failure `rounds` was
      // added to fix for BJJ.
      expect(
        worthCelebrating({ sets: 0, sport: 'running', distanceM: 0, durationSeconds: 0 }),
      ).toBe(false);
    });

    it('celebrates a run with distance but no sets', () => {
      expect(
        worthCelebrating({ sets: 0, sport: 'running', distanceM: 5000, durationSeconds: 0 }),
      ).toBe(true);
    });

    it('celebrates a treadmill run tracked by time alone, with no distance', () => {
      // A manual/imported entry can legitimately have no distance — see
      // `distanceM`'s own doc — so duration alone must still be enough.
      expect(
        worthCelebrating({ sets: 0, sport: 'running', distanceM: undefined, durationSeconds: 1200 }),
      ).toBe(true);
    });

    it('does not let a stray distanceM celebrate a NON-running sport', () => {
      // Gated explicitly on `sport`, not folded into one big OR — a strength
      // summary should never carry `distanceM` in practice, but if it did,
      // this pins that it still falls through to the sets/rounds check.
      expect(
        worthCelebrating({ sets: 0, sport: 'strength', distanceM: 5000, durationSeconds: 1200 }),
      ).toBe(false);
    });
  });
});

describe('the objective tiles', () => {
  it('omits volume rather than printing zero', () => {
    // A bodyweight session has no tonnage. "0 kg" on a card marking an
    // achievement reads as a failure to record something.
    const stats = statsFor(summary({ tonnageKg: 0 }), kg);
    expect(stats.map((s) => s.label)).not.toContain('Volume');
  });

  it('shows volume when there is some', () => {
    expect(statsFor(summary(), kg).find((s) => s.label === 'Volume')?.value).toBe('4200 kg');
  });

  it('never offers a BJJ session a tonnage tile', () => {
    // Structurally zero for the sport, not merely absent this time.
    const stats = statsFor(summary({ sport: 'bjj', rounds: 6, matMinutes: 42 }), kg);
    expect(stats.map((s) => s.label)).toEqual(['Time', 'Rounds', 'Rolling']);
  });

  it('omits volume when it is a silent under-count, even though it is positive (#425)', () => {
    // An offline exercise swap this session made left one set's tonnage out
    // of the sum — `tonnageKg` is real but WRONG, by an unknown amount, and
    // will change with no explanation the moment this syncs. A positive
    // number here is not "some volume", it is exactly the case `omits volume
    // rather than printing zero` above is about, just with tonnageKg > 0
    // instead of === 0 — a celebration card is not the place to assert an
    // achievement figure that is not yet the true one.
    const stats = statsFor(summary({ tonnageKg: 4200, tonnageUnknown: true }), kg);
    expect(stats.map((s) => s.label)).not.toContain('Volume');
  });

  it('shows volume normally once nothing is unresolved', () => {
    // `tonnageUnknown` defaults to undefined/false in the `summary()` fixture
    // above — this pins that the ordinary case is untouched by the new field.
    expect(statsFor(summary({ tonnageKg: 4200, tonnageUnknown: false }), kg).find((s) => s.label === 'Volume')?.value).toBe(
      '4200 kg',
    );
  });

  it('never shows a Reps tile, even when there were plenty (N447/#745)', () => {
    // Reported as "gets crowded". The PR badge now carries its own reps
    // figure when there is one; a session-wide rep COUNT sitting next to it
    // said nothing that wasn't said better elsewhere, so it was dropped —
    // Sets and Volume are what's left of the strength strip.
    const stats = statsFor(summary({ reps: 96 }), kg);
    expect(stats.map((s) => s.label)).toEqual(['Time', 'Sets', 'Volume']);
  });

  it('always leads with time, for both sports', () => {
    expect(statsFor(summary(), kg)[0].label).toBe('Time');
    expect(statsFor(summary({ sport: 'bjj' }), kg)[0].label).toBe('Time');
  });

  it('keeps the self-rating out of the measurements', () => {
    // RPE is one number somebody typed about themselves. In a row of measured
    // tiles it looks exactly like a measurement.
    const stats = statsFor(summary({ hardestRpe: 9 }), kg);
    expect(stats.map((s) => s.label)).not.toContain('Hardest set');
  });

  describe('the running strip (N461/#772)', () => {
    const run = (over: Partial<SessionSummary> = {}): SessionSummary =>
      summary({
        sport: 'running',
        sets: 0,
        rounds: undefined,
        distanceM: 5000,
        durationSeconds: 1620,
        avgPaceSecPerKm: 324,
        elevationGainM: 42,
        ...over,
      });

    it('never offers Sets or Volume — a run has neither', () => {
      const stats = statsFor(run(), kg);
      expect(stats.map((s) => s.label)).not.toContain('Sets');
      expect(stats.map((s) => s.label)).not.toContain('Volume');
    });

    it('shows Distance, Duration, Avg Pace and Elevation Gain, in that order', () => {
      expect(statsFor(run(), kg).map((s) => s.label)).toEqual([
        'Distance',
        'Duration',
        'Avg Pace',
        'Elevation Gain',
      ]);
    });

    it('does NOT lead with the shared "Time" label — it gets its own Duration tile', () => {
      // A mutation that fell through to the strength/BJJ leading tile would
      // print "Time" here instead, restoring the exact duplicate-duration
      // crowding N447 already removed Reps for.
      expect(statsFor(run(), kg).map((s) => s.label)).not.toContain('Time');
    });

    it('uses the injected distance formatter, not a hardcoded unit', () => {
      const miles = (m: number) => `${(m / 1609.344).toFixed(2)} mi`;
      const stat = statsFor(run(), kg, miles).find((s) => s.label === 'Distance');
      expect(stat?.value).toBe('3.11 mi');
    });

    it("falls back to lib/units.ts's own metric formatter with no distance formatter injected", () => {
      // Not a hand-rolled "5000 m" — the real `formatDistance('metric')`,
      // which switches to kilometres at 1000m. Reusing it, rather than a
      // second copy of the rule, is the point of the fallback.
      expect(statsFor(run(), kg).find((s) => s.label === 'Distance')?.value).toBe('5 km');
    });

    it('uses the injected pace formatter, not a hardcoded unit', () => {
      const perMile = (s: number) => `${(s / 60).toFixed(1)} min/mi`;
      const stat = statsFor(run(), kg, undefined, perMile).find((s) => s.label === 'Avg Pace');
      expect(stat?.value).toBe('5.4 min/mi');
    });

    it('falls back to minutes:seconds per kilometre with no pace formatter injected', () => {
      // 324s = 5:24/km.
      expect(statsFor(run(), kg).find((s) => s.label === 'Avg Pace')?.value).toBe('5:24/km');
    });

    it('renders elevation gain in metres', () => {
      expect(statsFor(run(), kg).find((s) => s.label === 'Elevation Gain')?.value).toBe('42 m');
    });

    it('omits Distance rather than printing zero — a manual, time-only entry', () => {
      const stats = statsFor(run({ distanceM: undefined }), kg);
      expect(stats.map((s) => s.label)).not.toContain('Distance');
      // Duration still shows: a treadmill session tracked by time alone is
      // still worth a card, and `worthCelebrating` already agrees (see above).
      expect(stats.map((s) => s.label)).toContain('Duration');
    });

    it('omits Avg Pace rather than printing zero when it was never computed', () => {
      const stats = statsFor(run({ avgPaceSecPerKm: undefined }), kg);
      expect(stats.map((s) => s.label)).not.toContain('Avg Pace');
    });

    it('omits Elevation Gain rather than printing zero on a flat run with no track', () => {
      const stats = statsFor(run({ elevationGainM: undefined }), kg);
      expect(stats.map((s) => s.label)).not.toContain('Elevation Gain');
    });

    it('always shows Duration, even with nothing else measured', () => {
      const stats = statsFor(
        run({ distanceM: undefined, avgPaceSecPerKm: undefined, elevationGainM: undefined }),
        kg,
      );
      expect(stats.map((s) => s.label)).toEqual(['Duration']);
    });

    it('omits Duration too on a genuinely zero-length run, same as every other tile', () => {
      // Defensive: `worthCelebrating` already keeps a truly empty run from
      // reaching this card, but the tile itself should not print "0m" if it
      // ever did.
      const stats = statsFor(
        run({
          distanceM: undefined,
          avgPaceSecPerKm: undefined,
          elevationGainM: undefined,
          durationSeconds: 0,
        }),
        kg,
      );
      expect(stats).toEqual([]);
    });
  });
});

describe('the subjective one', () => {
  it('is absent when effort tracking is off', () => {
    // Null is "not collected", which is a real and common state — the switch
    // exists and people use it.
    expect(feltFor({ hardestRpe: null })).toBeNull();
  });

  it('does not report a confident zero', () => {
    expect(feltFor({ hardestRpe: 0 })).toBeNull();
  });

  it('reports a real rating', () => {
    expect(feltFor({ hardestRpe: 8 })?.value).toBe('RPE 8');
  });
});

describe('duration', () => {
  it('drops the hour when there is not one', () => {
    expect(formatDuration(24 * 60)).toBe('24m');
  });

  it('pads the minutes past the hour', () => {
    expect(formatDuration(3600 + 4 * 60)).toBe('1h 04m');
  });

  it('never renders a negative time', () => {
    expect(formatDuration(-90)).toBe('0m');
  });
});

describe('the subtitle', () => {
  it('states what happened without praising it', () => {
    // No "Great work!". After four sets that is not encouragement, it is the
    // app not paying attention, and everyone can tell.
    expect(subtitleFor(summary())).toBe('12 sets across 4 exercises');
  });

  it('gets the singulars right', () => {
    expect(subtitleFor(summary({ sets: 1, exercises: 1 }))).toBe('1 set across 1 exercise');
  });

  it('speaks BJJ in rounds, not sets', () => {
    expect(subtitleFor(summary({ sport: 'bjj', rounds: 6 }))).toBe('6 rounds logged');
  });

  it('speaks running in duration, not sets or exercises', () => {
    expect(subtitleFor(summary({ sport: 'running', durationSeconds: 1620 }))).toBe('27m run');
  });
});

describe('building the summary from a finished session', () => {
  const session = {
    name: 'Push Day A',
    sport: 'strength',
    started_at: '2026-08-07T10:00:00Z',
    ended_at: '2026-08-07T11:04:00Z',
    sets: [
      { exercise_id: 'bench', completed: true, reps: 8, set_type: 'working' as const, weight_kg: 100 },
      { exercise_id: 'bench', completed: true, reps: 8, set_type: 'working' as const, weight_kg: 100 },
      { exercise_id: 'row', completed: true, reps: 10, set_type: 'working' as const, weight_kg: 50 },
      { exercise_id: 'row', completed: false, reps: null, set_type: 'working' as const, weight_kg: null },
    ],
  };
  const vol = { working_sets: 3, total_reps: 26, tonnage_kg: 1200, hardest_rpe: 8 };

  it('reports the same set count as the screen behind it', () => {
    // Taken from `volume.working_sets`, which excludes warmups — the figure
    // the session header already shows. Counting logged rows here instead made
    // the card say one number and the screen underneath another, about the
    // same session, one tap apart.
    expect(summariseSession(session, vol, true).sets).toBe(vol.working_sets);
  });

  it('counts distinct exercises, not rows', () => {
    expect(summariseSession(session, vol, true).exercises).toBe(2);
  });

  it('asks the records endpoint only about what was trained', () => {
    expect(summariseSession(session, vol, true).recordExerciseIDs).toEqual(['bench', 'row']);
  });

  it('takes the duration from the timestamps', () => {
    expect(summariseSession(session, vol, true).durationSeconds).toBe(64 * 60);
  });

  it('reports NO effort when the athlete turned effort tracking off', () => {
    // The distinction the whole objective/subjective split rests on: a session
    // with no ratings looks identical to one from someone who opted out, and
    // only the SETTING knows which. Reading it off the data would show the same
    // thing for two different facts.
    expect(summariseSession(session, vol, false).hardestRpe).toBeNull();
    expect(summariseSession(session, vol, true).hardestRpe).toBe(8);
  });

  it('starts with no records — they arrive later, or not at all', () => {
    expect(summariseSession(session, vol, true).records).toEqual([]);
  });

  it('is not flagged unknown when every set has a resolved factor', () => {
    expect(summariseSession(session, vol, true).tonnageUnknown).toBe(false);
  });

  it('is flagged unknown when a completed, weighted set carries the EXPLICITLY UNRESOLVED sentinel (#425)', () => {
    // The offline-swap case: this is what `hasUnresolvedLoad` is reading off
    // `session.sets` directly, independent of `vol` — `volume.tonnage_kg`
    // itself is already an under-count by then (see `localVolume`'s own
    // comment) and cannot tell the caller that on its own, which is the whole
    // reason this is a separate field rather than folded into that number.
    const swapped = {
      ...session,
      sets: [...session.sets, { exercise_id: 'incline-bench', completed: true, reps: 5, set_type: 'working' as const, weight_kg: 40, load_factor: null }],
    };
    expect(summariseSession(swapped, vol, true).tonnageUnknown).toBe(true);
  });
});

describe('building a running summary from a finished session (N461/#772)', () => {
  // A running session, exactly as `running.SessionDetail`'s own doc says one
  // is usually built: an ordinary `sessions` row plus (in practice) one
  // `session_sets` row against a "run" exercise, so the generic PR pipeline
  // has something to key its longest_time/furthest_distance lookup on.
  const runSession = {
    name: 'Morning Run',
    sport: 'running',
    started_at: '2026-08-30T07:00:00Z',
    ended_at: '2026-08-30T07:32:00Z',
    sets: [
      { exercise_id: 'run', completed: true, reps: null, set_type: 'working' as const, weight_kg: null },
    ],
  };
  const noVolume = { working_sets: 0, total_reps: 0, tonnage_kg: 0, hardest_rpe: 0 };
  const detail: RunningSessionDetail = {
    distance_m: 5230,
    duration_seconds: 1860,
    avg_pace_sec_per_km: 356,
    elevation_gain_m: 61,
    route_points: [
      { lat: 40.7128, lng: -74.006 },
      { lat: 40.713, lng: -74.0058 },
      { lat: 40.7135, lng: -74.005 },
    ],
  };

  it('tags the summary running, not strength', () => {
    // The strength/BJJ fallback used to be a two-way ternary
    // (`sport === 'bjj' ? 'bjj' : 'strength'`) — a mutation that deleted the
    // running branch entirely would still compile and would mislabel every
    // run as strength.
    expect(summariseSession(runSession, noVolume, true, detail).sport).toBe('running');
  });

  it('carries no sets, reps or tonnage — a run has none of those', () => {
    const s = summariseSession(runSession, noVolume, true, detail);
    expect(s.sets).toBe(0);
    expect(s.reps).toBe(0);
    expect(s.tonnageKg).toBe(0);
  });

  it('takes distance, pace and elevation from the running detail', () => {
    const s = summariseSession(runSession, noVolume, true, detail);
    expect(s.distanceM).toBe(5230);
    expect(s.avgPaceSecPerKm).toBe(356);
    expect(s.elevationGainM).toBe(61);
  });

  it("prefers the running module's own duration over the timestamp diff", () => {
    // The timestamps here span exactly 1920s (32m); the detail's own
    // 1860s (31m) should win — it can exclude paused time a plain diff
    // cannot, per `running.SessionDetail.DurationSeconds`'s own doc.
    expect(summariseSession(runSession, noVolume, true, detail).durationSeconds).toBe(1860);
  });

  it('falls back to the timestamp diff when there is no running detail yet', () => {
    // A running session read back before its detail has synced — a real,
    // offline-first state, not an error.
    expect(summariseSession(runSession, noVolume, true, undefined).durationSeconds).toBe(1920);
  });

  it('falls back to the timestamp diff on a genuine zero, not a confident zero-length run', () => {
    // `duration_seconds: 0` is a real, if unusual, wire value (an imported
    // entry with a broken clock, say) — `??` alone treats it as present and
    // would render a zero-length run instead of falling back, exactly the
    // "confident zero" `feltFor`'s own doc warns this file exists to avoid.
    const s = summariseSession(runSession, noVolume, true, { ...detail, duration_seconds: 0 });
    expect(s.durationSeconds).toBe(1920);
  });

  it('leaves distance/pace/elevation undefined with no running detail', () => {
    const s = summariseSession(runSession, noVolume, true, undefined);
    expect(s.distanceM).toBeUndefined();
    expect(s.avgPaceSecPerKm).toBeUndefined();
    expect(s.elevationGainM).toBeUndefined();
  });

  it('reports no session-level effort — running tracks none today', () => {
    expect(summariseSession(runSession, noVolume, true, detail).hardestRpe).toBeNull();
  });

  it('asks the records endpoint about the run exercise, the same generic way strength does', () => {
    // Unchanged machinery: PR detection goes through the same
    // `recordExerciseIDs` → `/v1/records` → `recordsFromSession` path
    // BJJ/strength already use — this is what wires it up for running.
    expect(summariseSession(runSession, noVolume, true, detail).recordExerciseIDs).toEqual(['run']);
  });

  it('starts with no records — they arrive later, or not at all, same as every other sport', () => {
    expect(summariseSession(runSession, noVolume, true, detail).records).toEqual([]);
  });

  it('downsamples a long route before it reaches the summary', () => {
    const longTrack = Array.from({ length: 200 }, (_, i) => ({ lat: 40 + i * 0.0001, lng: -74 }));
    const s = summariseSession(runSession, noVolume, true, { ...detail, route_points: longTrack });
    expect(s.routePoints?.length).toBeLessThanOrEqual(61);
    // And still ends on the true finish line.
    expect(s.routePoints?.at(-1)).toEqual(longTrack.at(-1));
  });

  it('carries an empty route rather than throwing for a manual entry with no track', () => {
    const s = summariseSession(runSession, noVolume, true, { ...detail, route_points: [] });
    expect(s.routePoints).toEqual([]);
  });
});

describe('the route thumbnail (N461/#772)', () => {
  describe('downsampleRoute', () => {
    it('returns the route untouched when it is already small', () => {
      const points = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
      expect(downsampleRoute(points, 60)).toEqual(points);
    });

    it('thins a long route down to the cap', () => {
      const points = Array.from({ length: 1000 }, (_, i) => ({ lat: i, lng: i }));
      expect(downsampleRoute(points, 60).length).toBeLessThanOrEqual(61);
    });

    it('always keeps the true last point, not wherever the stride lands', () => {
      // A mutation that dropped this guard would pass for most lengths — it
      // only shows up when the stride does not land exactly on the last
      // index, which 1000 points at a cap of 60 reliably triggers.
      const points = Array.from({ length: 1000 }, (_, i) => ({ lat: i, lng: i }));
      const out = downsampleRoute(points, 60);
      expect(out.at(-1)).toEqual(points.at(-1));
    });

    it('spreads the kept points across the WHOLE run, not just the start', () => {
      // A naive `slice(0, max)` would pass "thins a long route" above too —
      // this is the test that actually distinguishes striding from slicing.
      const points = Array.from({ length: 1000 }, (_, i) => ({ lat: i, lng: i }));
      const out = downsampleRoute(points, 60);
      expect(out[out.length - 2].lat).toBeGreaterThan(500);
    });
  });

  describe('regionForRoute', () => {
    it('is null for an empty route — nothing to draw', () => {
      expect(regionForRoute([])).toBeNull();
    });

    it('is null for a single point — nothing to connect it to', () => {
      expect(regionForRoute([{ lat: 40.71, lng: -74.0 }])).toBeNull();
    });

    it('centres on the midpoint of the route’s bounding box', () => {
      const region = regionForRoute([
        { lat: 40.0, lng: -74.0 },
        { lat: 41.0, lng: -73.0 },
      ]);
      expect(region?.latitude).toBeCloseTo(40.5);
      expect(region?.longitude).toBeCloseTo(-73.5);
    });

    it('frames the route with margin, not a tight crop', () => {
      // A margin-free region would set latitudeDelta to exactly the span
      // (1.0 here); a mutation that dropped the margin multiplier would pass
      // an assertion of `toBe(1.0)` but fail this one.
      const region = regionForRoute([
        { lat: 40.0, lng: -74.0 },
        { lat: 41.0, lng: -73.0 },
      ]);
      expect(region?.latitudeDelta).toBeGreaterThan(1.0);
    });

    it('floors the zoom for a short out-and-back near one point', () => {
      // Two points a few metres apart should not zoom in past what a
      // postage-stamp map can usefully show.
      const region = regionForRoute([
        { lat: 40.71280, lng: -74.00600 },
        { lat: 40.71281, lng: -74.00601 },
      ]);
      expect(region?.latitudeDelta).toBeGreaterThanOrEqual(0.004);
      expect(region?.longitudeDelta).toBeGreaterThanOrEqual(0.004);
    });
  });
});

describe('whether the streak chime plays', () => {
  const at = (o: Partial<Parameters<typeof celebratesStreak>[0]>) =>
    celebratesStreak({ recordsSettled: true, hasRecords: false, carried: true, ...o });

  it('plays when this session carried the streak and set no record', () => {
    expect(at({})).toBe(true);
  });

  it('yields to the PR chime when the session also set a record', () => {
    // The precedence that matters: a PR is rare, a streak recurs weekly.
    expect(at({ hasRecords: true })).toBe(false);
  });

  it('waits for the records lookup rather than racing it', () => {
    // THE case this gate exists for. Without it a fast history chimes the
    // streak and latches the PR out — the wrong sound, and only sometimes,
    // which is the worst kind of bug to be told about.
    expect(at({ recordsSettled: false })).toBe(false);
    // ...and once records answer "none", it plays.
    expect(at({ recordsSettled: true })).toBe(true);
  });

  it('stays quiet on a session that did not carry the streak', () => {
    expect(at({ carried: false })).toBe(false);
  });

  it('stays quiet when nothing applies', () => {
    expect(at({ recordsSettled: false, hasRecords: true, carried: false })).toBe(false);
  });
});
