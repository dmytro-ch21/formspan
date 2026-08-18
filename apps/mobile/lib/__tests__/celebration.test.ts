import {
  badgeFor,
  celebratesStreak,
  feltFor,
  formatDuration,
  recordsFromSession,
  statsFor,
  subtitleFor,
  summariseSession,
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
});

describe('building the summary from a finished session', () => {
  const session = {
    name: 'Push Day A',
    sport: 'strength',
    started_at: '2026-08-07T10:00:00Z',
    ended_at: '2026-08-07T11:04:00Z',
    sets: [
      { exercise_id: 'bench', completed: true, reps: 8 },
      { exercise_id: 'bench', completed: true, reps: 8 },
      { exercise_id: 'row', completed: true, reps: 10 },
      { exercise_id: 'row', completed: false, reps: null },
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
