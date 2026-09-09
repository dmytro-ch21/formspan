import type { LoggedSet, Session } from '../sessions';
import {
  sessionDurationSeconds,
  sessionMeta,
  sessionVolumeKg,
  workingSetCount,
} from '../sessionSummary';

/**
 * The one-line summary under a session's name, extracted from three copies
 * (N548) — `app/session/history.tsx`'s row, `components/TrainingCalendar.tsx`'s
 * day detail, and now Today's LOGGED rows.
 *
 * **The property worth testing is that nothing is fabricated as a zero.** The
 * copies this replaces each carried that rule as a comment and one of them —
 * history's — still gets it wrong for running, showing a strength-shaped line
 * for a run because it never grew N462's branch. That is what a shared
 * function is for, and it is what the running cases below pin.
 */

function set(over: Partial<LoggedSet> = {}): LoggedSet {
  return {
    exercise_id: 'ex1',
    position: 0,
    set_type: 'working',
    completed: true,
    reps: 5,
    weight_kg: 100,
    rir: null,
    rpe: null,
    seconds: null,
    distance_m: null,
    notes: '',
    ...(over as object),
  } as LoggedSet;
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    intent: 'normal',
    started_at: '2026-08-26T09:00:00.000Z',
    ended_at: '2026-08-26T10:00:00.000Z',
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
    ...over,
  };
}

describe('the pieces', () => {
  test('a drop is part of the set above it and adds no set', () => {
    expect(
      workingSetCount([
        set(),
        set({ set_type: 'drop' }),
        set({ set_type: 'warmup' }),
        set({ completed: false }),
      ]),
    ).toBe(1);
  });

  test('a drop still adds its work to the tonnage', () => {
    expect(sessionVolumeKg([set({ reps: 5, weight_kg: 100 })])).toBe(500);
    expect(
      sessionVolumeKg([set({ reps: 5, weight_kg: 100 }), set({ set_type: 'drop', reps: 5, weight_kg: 60 })]),
    ).toBe(800);
  });

  test('a running session has no duration until it ends', () => {
    expect(sessionDurationSeconds(session({ ended_at: null }))).toBeNull();
    expect(sessionDurationSeconds(session())).toBe(3600);
  });
});

describe('sessionMeta says only what it has', () => {
  test('a lift reads duration, sets and tonnage', () => {
    expect(sessionMeta(session({ sets: [set(), set()] }), 'metric')).toEqual([
      '1h',
      '2 sets',
      '1.0t',
    ]);
  });

  test('a mat session with no sets says how long it was and nothing else', () => {
    // The fabricated-zero case: "0 sets · 0kg" on a BJJ class reads as
    // abandoned rather than as a class.
    expect(sessionMeta(session({ sport: 'bjj', sets: [] }), 'metric')).toEqual(['1h']);
  });

  test('a session still running has no line at all rather than a zero duration', () => {
    expect(sessionMeta(session({ sport: 'bjj', sets: [], ended_at: null }), 'metric')).toEqual([]);
  });

  test('a run reads distance and pace, never sets or tonnage', () => {
    const run = session({
      sport: 'running',
      // 5km in 25 active minutes — 5:00/km.
      sets: [set({ reps: null, weight_kg: null, distance_m: 5000, seconds: 1500 })],
    });
    expect(sessionMeta(run, 'metric')).toEqual(['1h', '5 km', '5:00/km']);
  });

  test("a run's pace comes from its ACTIVE seconds, not from the wall clock", () => {
    // Started 09:00, finished 10:00 — but only 25 minutes of it was moving.
    // Pacing over the hour would read 12:00/km and disagree with the number
    // the athlete watched on the tracking screen.
    const run = session({
      sport: 'running',
      sets: [set({ reps: null, weight_kg: null, distance_m: 5000, seconds: 1500 })],
    });
    expect(sessionMeta(run, 'metric')[2]).toBe('5:00/km');
  });

  test('a run with a distance but no recorded seconds states the distance and no pace', () => {
    const run = session({
      sport: 'running',
      sets: [set({ reps: null, weight_kg: null, distance_m: 5000, seconds: null })],
    });
    expect(sessionMeta(run, 'metric')).toEqual(['1h', '5 km']);
  });

  test('units reach every measure', () => {
    const run = session({
      sport: 'running',
      sets: [set({ reps: null, weight_kg: null, distance_m: 5000, seconds: 1500 })],
    });
    expect(sessionMeta(run, 'imperial')).toEqual(['1h', '3.11 mi', '8:03/mi']);
    expect(sessionMeta(session({ sets: [set()] }), 'imperial')[2]).toBe('1,102lb');
  });
});
