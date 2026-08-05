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
] as never;

const NOW = new Date('2026-08-05T12:00:00');

function session(day: string, sport: string, name: string): Session {
  return {
    id: `s-${day}-${sport}`,
    user_id: 'u1',
    workout_id: null,
    sport,
    name,
    started_at: new Date(`${day}T18:00:00`).toISOString(),
    ended_at: new Date(`${day}T19:00:00`).toISOString(),
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
  };
}

const plan = (day: string, sport: string): PlannedSession => ({
  id: `p-${day}-${sport}`,
  day,
  sport,
  workoutId: null,
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
