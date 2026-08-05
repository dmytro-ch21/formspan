import { matchPlans, pendingPlans } from '../adherence';
import type { PlannedSession } from '../plan';
import type { Session } from '../sessions';

/**
 * The matching rule, and specifically the cases `000033_create_plans.up.sql`
 * named as the reason not to reconcile at all. Each of those is a test here —
 * if this file cannot keep them true, the migration was right and the query
 * should not exist.
 *
 * The suite runs under `TZ=America/Los_Angeles`, which matters: a session's day
 * is derived from `started_at` in local time, and matching on the UTC date
 * would credit a Tuesday evening class to Wednesday for anyone west of
 * Greenwich. A UTC-only suite passes against exactly that bug.
 */

let seq = 0;
function session(day: string, sport: string, hour = 18): Session {
  seq += 1;
  return {
    id: `s${seq}`,
    user_id: 'u1',
    workout_id: null,
    sport,
    name: '',
    // Local wall-clock, so `dayString` puts it on `day` under the suite's TZ.
    started_at: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString(),
    ended_at: null,
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
  };
}

function plan(day: string, sport: string, workoutId: string | null = null): PlannedSession {
  seq += 1;
  return { id: `p${seq}`, day, sport, workoutId, notes: '' };
}

beforeEach(() => {
  seq = 0;
});

describe('matchPlans', () => {
  it('meets a plan with a session of the same sport that day', () => {
    const p = plan('2026-08-04', 'bjj');
    const s = session('2026-08-04', 'bjj');
    const m = matchPlans([s], [p]);
    expect(m.met.has(p.id)).toBe(true);
    expect(m.metBy.get(s.id)).toBe(p.id);
    expect(pendingPlans([p], m)).toEqual([]);
  });

  it('leaves a plan pending when the day was not trained', () => {
    const p = plan('2026-08-04', 'bjj');
    const m = matchPlans([], [p]);
    expect(m.met.size).toBe(0);
    expect(pendingPlans([p], m)).toEqual([p]);
  });

  it('does not let a session meet a plan on another day', () => {
    // The bug this guards is off-by-one, not absence: a Monday class must not
    // quietly satisfy Tuesday's plan.
    const p = plan('2026-08-04', 'bjj');
    const m = matchPlans([session('2026-08-03', 'bjj'), session('2026-08-05', 'bjj')], [p]);
    expect(m.met.size).toBe(0);
  });

  it('does not let one sport meet another plan’s sport', () => {
    const p = plan('2026-08-04', 'bjj');
    const m = matchPlans([session('2026-08-04', 'strength')], [p]);
    expect(m.met.size).toBe(0);
  });

  it('meets a plan named for a template with a different one', () => {
    // You planned Workout 1 and did Workout 2. You did your strength session;
    // leaving "Workout 1 · Planned" beside it is the duplication being fixed.
    const p = plan('2026-08-06', 'strength', 'workout-1');
    const s: Session = { ...session('2026-08-06', 'strength'), workout_id: 'workout-2' };
    expect(matchPlans([s], [p]).met.has(p.id)).toBe(true);
  });

  describe('the cases the migration said made this impossible', () => {
    it('a day trained twice meets one plan and shows both sessions', () => {
      const p = plan('2026-08-04', 'bjj');
      const [a, b] = [session('2026-08-04', 'bjj', 7), session('2026-08-04', 'bjj', 19)];
      const m = matchPlans([a, b], [p]);
      expect(m.met.size).toBe(1);
      // Exactly one session is credited; the other is an extra, not a duplicate.
      expect(m.metBy.size).toBe(1);
      expect([a.id, b.id]).toContain([...m.metBy.keys()][0]);
    });

    it('two plans for one day need two sessions', () => {
      // A two-a-day is why `(user_id, day)` is deliberately not unique.
      const [p1, p2] = [plan('2026-08-04', 'bjj'), plan('2026-08-04', 'bjj')];
      const one = matchPlans([session('2026-08-04', 'bjj')], [p1, p2]);
      expect(one.met.size).toBe(1);
      expect(pendingPlans([p1, p2], one)).toHaveLength(1);

      const two = matchPlans(
        [session('2026-08-04', 'bjj', 7), session('2026-08-04', 'bjj', 19)],
        [p1, p2],
      );
      expect(two.met.size).toBe(2);
      expect(pendingPlans([p1, p2], two)).toEqual([]);
    });

    it('a plan trained with something else stays pending, and the session shows', () => {
      const p = plan('2026-08-04', 'bjj');
      const s = session('2026-08-04', 'strength');
      const m = matchPlans([s], [p]);
      expect(pendingPlans([p], m)).toEqual([p]);
      // Nothing marks the strength session as meeting anything.
      expect(m.metBy.size).toBe(0);
    });

    it('deleting the session makes its plan pending again', () => {
      // The whole argument for computing rather than storing. A `completed`
      // column would survive the delete and keep claiming the day was trained.
      const p = plan('2026-08-04', 'bjj');
      const s = session('2026-08-04', 'bjj');
      expect(matchPlans([s], [p]).met.has(p.id)).toBe(true);
      expect(matchPlans([], [p]).met.has(p.id)).toBe(false);
    });
  });

  it('places a late session on its local day, not its UTC one', () => {
    // 21:00 in Los Angeles is already tomorrow in UTC. Matching on the raw
    // timestamp credits this class to the wrong day, and a UTC test suite
    // cannot see the difference.
    const p = plan('2026-08-04', 'bjj');
    const late = session('2026-08-04', 'bjj', 21);
    expect(new Date(late.started_at).toISOString().slice(0, 10)).toBe('2026-08-05');
    expect(matchPlans([late], [p]).met.has(p.id)).toBe(true);
  });

  it('matches across a whole week in one pass', () => {
    const plans = [
      plan('2026-08-04', 'bjj'),
      plan('2026-08-05', 'bjj'),
      plan('2026-08-06', 'strength'),
    ];
    const m = matchPlans([session('2026-08-04', 'bjj'), session('2026-08-06', 'strength')], plans);
    expect(pendingPlans(plans, m).map((p) => p.day)).toEqual(['2026-08-05']);
  });

  it('is empty when either side is', () => {
    expect(matchPlans([], []).met.size).toBe(0);
    expect(matchPlans([session('2026-08-04', 'bjj')], []).met.size).toBe(0);
    expect(matchPlans([], [plan('2026-08-04', 'bjj')]).met.size).toBe(0);
  });
});
