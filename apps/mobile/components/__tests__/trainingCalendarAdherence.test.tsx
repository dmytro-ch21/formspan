import { fireEvent, render, screen } from '@testing-library/react-native';

import { TrainingCalendar } from '../TrainingCalendar';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';

jest.mock('@/lib/sessionStore', () => ({ listLocalSessions: jest.fn(async () => []) }));

/**
 * The wiring, which the library tests structurally cannot reach.
 *
 * `lib/__tests__/adherence.test.ts` proves the rule. It proves it about a pure
 * function, so **reverting the fix leaves it entirely green**: put `planned`
 * back where `pendingPlans(planned, adherence)` now is, and the duplicate row
 * from the bug report returns with 438 tests still passing. Review caught that
 * the fix itself had no coverage, and it was right — this file is the guard.
 */

const MODULES = [
  { id: 'strength', label: 'Strength', enabled: true },
  { id: 'bjj', label: 'BJJ', enabled: true },
  { id: 'running', label: 'Running', enabled: true },
] as never;

const NOW = new Date('2026-08-05T12:00:00');

function session(day: string, sport: string, name: string): Session {
  return {
    id: `s-${day}-${sport}`,
    user_id: 'u1',
    workout_id: null,
    sport,
    name,
    intent: 'normal',
    started_at: new Date(`${day}T18:00:00`).toISOString(),
    ended_at: new Date(`${day}T19:00:00`).toISOString(),
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
  };
}

/**
 * A finished run, shaped exactly like `app/running/[id].tsx`'s `finish()`
 * writes it: one `session_sets` row against the `run` exercise, distance and
 * duration set, no weight or reps — the only place a running session's
 * distance lives on the local list this component reads.
 *
 * `activeSeconds` is what the set's own `seconds` field carries (paused time
 * excluded — `elapsedMsRef` in `app/running/[id].tsx`). `wallClockSeconds`
 * defaults to the same value, matching every existing caller; pass a LARGER
 * one to build a paused-run fixture, where the session's `ended_at` span is
 * longer than the time the athlete was actually moving.
 */
function runSession(
  day: string,
  name: string,
  distanceM: number,
  activeSeconds: number,
  wallClockSeconds: number = activeSeconds,
): Session {
  const started = new Date(`${day}T07:00:00`);
  return {
    id: `s-${day}-running`,
    user_id: 'u1',
    workout_id: null,
    sport: 'running',
    name,
    intent: 'normal',
    started_at: started.toISOString(),
    ended_at: new Date(started.getTime() + wallClockSeconds * 1000).toISOString(),
    notes: '',
    sets: [
      {
        exercise_id: 'run',
        position: 0,
        set_type: 'working',
        reps: null,
        weight_kg: null,
        seconds: activeSeconds,
        distance_m: distanceM,
        rir: null,
        rpe: null,
        notes: '',
        completed: true,
      },
    ],
    created_at: '',
    updated_at: '',
  };
}

const plan = (day: string, sport: string): PlannedSession => ({
  id: `p-${day}-${sport}`,
  day,
  sport,
  workoutId: null,
  classPlanId: null,
  timeOfDayMinutes: null,
  notes: '',
});

/** Renders and opens the week — the day rows are behind the collapse. */
function show(sessions: Session[], planned: PlannedSession[]) {
  render(
    <TrainingCalendar
      now={NOW}
      userId="u1"
      sessions={sessions}
      planned={planned}
      modules={MODULES}
      units="metric"
      onOpenSession={() => {}}
    />,
  );
  fireEvent.press(screen.getByLabelText('Show the week'));
}

describe('the week list', () => {
  it('drops a plan that its own day already met', () => {
    show([session('2026-08-05', 'strength', 'Maestro Push Day')], [plan('2026-08-05', 'strength')]);
    expect(screen.getByText('Maestro Push Day')).toBeTruthy();
    // The reported bug: this row sat beside the session as a second entry.
    expect(screen.queryByText('Planned')).toBeNull();
  });

  it('keeps a plan the day did not meet', () => {
    show([session('2026-08-05', 'strength', 'Maestro Push Day')], [plan('2026-08-06', 'strength')]);
    expect(screen.getByText('Planned')).toBeTruthy();
  });

  it('keeps a plan met by nothing but a different sport', () => {
    show([session('2026-08-05', 'strength', 'Maestro Push Day')], [plan('2026-08-05', 'bjj')]);
    expect(screen.getByText('Planned')).toBeTruthy();
  });

  it('marks the session that met a plan, so the intention is not simply lost', () => {
    show([session('2026-08-05', 'strength', 'Maestro Push Day')], [plan('2026-08-05', 'strength')]);
    expect(screen.getByLabelText(/Maestro Push Day.*planned/)).toBeTruthy();
  });

  it('still tells a screen reader the day was planned, even once it is met', () => {
    // The dot collapses to "trained" because done outranks planned, and the
    // pending row is gone — so the spoken label is the ONLY place left saying
    // this day was intended. Two comments in the component require it.
    show([session('2026-08-05', 'strength', 'Maestro Push Day')], [plan('2026-08-05', 'strength')]);
    expect(screen.getByLabelText(/Wednesday.*trained.*planned/)).toBeTruthy();
  });
});

/**
 * N462 — the wiring `lib/__tests__/sessions.test.ts`'s pure
 * `sessionDistanceMeters` tests structurally cannot reach: that a running
 * entry's ROW actually reads distance + pace off it, rather than the
 * sets/tonnage line every other sport gets. Same shape as the file header's
 * own example — the pure rule can be entirely correct while nothing wires it
 * to the screen.
 */
describe('a running entry', () => {
  it('shows distance and pace, not a sets/tonnage line', () => {
    // 5km in 1800s (30 minutes) is a 6:00/km pace.
    show([runSession('2026-08-05', 'Morning Run', 5000, 1800)], []);
    expect(screen.getByText('Morning Run')).toBeTruthy();
    expect(screen.getByText('30m · 5 km · 6:00/km')).toBeTruthy();
    expect(screen.queryByText(/set/)).toBeNull();
    expect(screen.queryByText(/kg/)).toBeNull();
  });

  it('omits distance and pace for a manual run with no recorded distance', () => {
    // No GPS distance is not a confident "0m" — the meta line falls back to
    // duration alone, same fabricated-zero rule every other guard here follows.
    show([runSession('2026-08-05', 'Treadmill', 0, 1800)], []);
    expect(screen.getByText('30m')).toBeTruthy();
  });

  it('paces off ACTIVE time, not the wall-clock span a pause stretches', () => {
    // 5km in 1500s (25 minutes) of active time is a 5:00/km pace. The
    // session's wall-clock span is 1800s (30 minutes) — five minutes longer,
    // because the run was paused — and the duration chip correctly still
    // reads the full 30m. Before this fix, pace was computed off THAT
    // wall-clock span too, so this identical session would have read
    // 6:00/km here while the live tracking screen (which uses active time
    // throughout) showed 5:00/km for the same run.
    show([runSession('2026-08-05', 'Paused Run', 5000, 1500, 1800)], []);
    expect(screen.getByText('30m · 5 km · 5:00/km')).toBeTruthy();
    expect(screen.queryByText(/6:00\/km/)).toBeNull();
  });
});
