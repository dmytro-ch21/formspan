import { deltaPct, leadMeasure, reviewWeek, weekVerdict } from '../weekReview';
import type { PlannedSession } from '../plan';
import type { LoggedSet, Session } from '../sessions';

/**
 * The weekly sum-up.
 *
 * The load-bearing property here is the **window guard**: the local session
 * list is bounded by count, not by date, so last week can be partially present.
 * Summing it anyway produces a confident number that is too small, and every
 * delta drawn from it reads as a decline the athlete did not have. Most of this
 * file exists for that one case.
 *
 * The suite runs under `TZ=America/Los_Angeles`. That matters the same way it
 * does for `adherence.test.ts`: a session's week comes from its LOCAL day, and
 * bucketing on the UTC date moves a Sunday-evening session into the next week
 * for anyone west of Greenwich — which is a whole week's totals landing in the
 * wrong column, in exactly the zone this app is developed in.
 *
 * Dates below: 2026-08-03 and 2026-08-10 are Mondays.
 */

let seq = 0;

function set(weightKg: number | null, reps: number | null): LoggedSet {
  return {
    exercise_id: 'e1',
    position: 1,
    set_type: 'working',
    reps,
    weight_kg: weightKg,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    notes: '',
    completed: true,
  };
}

function session(
  day: string,
  sport: string,
  opts: { minutes?: number | null; sets?: LoggedSet[]; hour?: number } = {},
): Session {
  seq += 1;
  const hour = opts.hour ?? 18;
  // Local wall-clock, so `dayString` puts it on `day` under the suite's TZ.
  const started = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`);
  const minutes = opts.minutes === undefined ? 60 : opts.minutes;
  return {
    id: `s${seq}`,
    user_id: 'u1',
    workout_id: null,
    sport,
    name: '',
    started_at: started.toISOString(),
    ended_at:
      minutes === null ? null : new Date(started.getTime() + minutes * 60_000).toISOString(),
    notes: '',
    sets: opts.sets ?? [],
    created_at: '',
    updated_at: '',
  };
}

function plan(day: string, sport: string): PlannedSession {
  seq += 1;
  return { id: `p${seq}`, day, sport, workoutId: null, notes: '' };
}

/** Mid-week, so nothing here depends on "now" being a boundary. */
const NOW = new Date('2026-08-12T12:00:00');

beforeEach(() => {
  seq = 0;
});

describe('reviewWeek — the window guard', () => {
  it('reports no previous week when the local list does not reach past it', () => {
    // Everything on hand is from this week. Last week is not "zero training",
    // it is unknown — and the difference is the whole point.
    const sessions = [session('2026-08-10', 'bjj'), session('2026-08-11', 'strength')];
    expect(reviewWeek(sessions, [], NOW).previous).toBeNull();
  });

  it('still reports no previous week when the oldest session IS the previous Monday', () => {
    // The boundary case, and the reason the test is `<` and not `<=`: a list
    // whose oldest row sits exactly on the previous Monday cannot rule out
    // having been truncated there, so it proves nothing about that week.
    const sessions = [session('2026-08-10', 'bjj'), session('2026-08-03', 'bjj')];
    expect(reviewWeek(sessions, [], NOW).previous).toBeNull();
  });

  it('reports the previous week once the list demonstrably reaches back past it', () => {
    const sessions = [
      session('2026-08-10', 'bjj'),
      session('2026-08-05', 'bjj'), // last week
      session('2026-08-07', 'bjj'), // last week
      session('2026-08-02', 'bjj'), // the Sunday BEFORE last week — the proof
    ];
    const r = reviewWeek(sessions, [], NOW);
    expect(r.previous).not.toBeNull();
    expect(r.previous?.sessions).toBe(2);
    expect(r.previous?.days).toBe(2);
  });

  it('does not let sessions older than last week leak into the previous total', () => {
    const sessions = [
      session('2026-08-10', 'bjj'),
      session('2026-08-05', 'bjj'), // last week
      session('2026-07-20', 'bjj'), // three weeks ago — proof, but not a total
    ];
    expect(reviewWeek(sessions, [], NOW).previous?.sessions).toBe(1);
  });
});

describe('reviewWeek — bucketing', () => {
  it('buckets by local day, not by UTC date', () => {
    /*
      A Sunday 9pm session in Los Angeles is Monday in UTC. Bucketing on the
      raw timestamp moves it into the NEXT week — so this week gains a session
      it did not have and last week loses one. The single most consequential
      off-by-one available here, and invisible to a UTC-only suite.
    */
    const sunday9pm = session('2026-08-09', 'bjj', { hour: 21 });
    const proof = session('2026-08-01', 'bjj');
    const r = reviewWeek([sunday9pm, proof], [], NOW);
    expect(r.totals.sessions).toBe(0);
    expect(r.previous?.sessions).toBe(1);
  });

  it('counts an unfinished session but gives it no duration', () => {
    // Now-minus-start would make the week's total climb while the phone sits
    // in a locker.
    const r = reviewWeek([session('2026-08-10', 'bjj', { minutes: null })], [], NOW);
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.seconds).toBe(0);
  });

  it('counts two sessions on one day as one trained day', () => {
    const r = reviewWeek(
      [session('2026-08-10', 'bjj', { hour: 7 }), session('2026-08-10', 'strength', { hour: 18 })],
      [],
      NOW,
    );
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.days).toBe(1);
  });

  it('ignores warm-up and uncompleted sets in the tonnage', () => {
    const warm = { ...set(60, 10), set_type: 'warmup' as const };
    const skipped = { ...set(100, 5), completed: false };
    const r = reviewWeek(
      [session('2026-08-10', 'strength', { sets: [warm, skipped, set(100, 5)] })],
      [],
      NOW,
    );
    expect(r.totals.volumeKg).toBe(500);
  });
});

describe('reviewWeek — the per-sport split', () => {
  it('splits sessions, time and tonnage by sport', () => {
    const r = reviewWeek(
      [
        session('2026-08-10', 'bjj', { minutes: 90 }),
        session('2026-08-11', 'bjj', { minutes: 60 }),
        session('2026-08-12', 'strength', { minutes: 45, sets: [set(100, 5)] }),
      ],
      [],
      NOW,
    );
    expect(r.bySport.map((s) => s.sport)).toEqual(['bjj', 'strength']);
    expect(r.bySport[0].sessions).toBe(2);
    expect(r.bySport[0].seconds).toBe(150 * 60);
    expect(r.bySport[0].volumeKg).toBe(0);
    expect(r.bySport[1].volumeKg).toBe(500);
  });

  it('breaks a tie on sport name so the card cannot reshuffle itself', () => {
    // Logged strength-first; must still come back alphabetically, or two
    // renders of an unchanged week disagree about the order.
    const r = reviewWeek(
      [session('2026-08-10', 'strength'), session('2026-08-11', 'bjj')],
      [],
      NOW,
    );
    expect(r.bySport.map((s) => s.sport)).toEqual(['bjj', 'strength']);
  });
});

describe('reviewWeek — adherence', () => {
  it('counts only plans falling inside the reviewed week', () => {
    const r = reviewWeek(
      [session('2026-08-10', 'bjj')],
      [plan('2026-08-10', 'bjj'), plan('2026-08-05', 'bjj'), plan('2026-08-20', 'bjj')],
      NOW,
    );
    expect(r.planned).toBe(1);
    expect(r.met).toBe(1);
  });

  it('does not let last week’s session meet this week’s plan', () => {
    // The reason `matchPlans` is handed `thisWeek` and not the whole list.
    // Passing everything makes an untrained week read as fully adhered.
    const r = reviewWeek([session('2026-08-05', 'bjj')], [plan('2026-08-10', 'bjj')], NOW);
    expect(r.planned).toBe(1);
    expect(r.met).toBe(0);
  });
});

describe('deltaPct', () => {
  it('is null when there is nothing to compare against', () => {
    // Not 0, and not Infinity — which renders as the literal "Infinity%".
    expect(deltaPct(3, 0)).toBeNull();
    expect(deltaPct(3, null)).toBeNull();
  });

  it('measures the change against the previous value', () => {
    expect(deltaPct(3, 2)).toBeCloseTo(50);
    expect(deltaPct(1, 2)).toBeCloseTo(-50);
  });
});

describe('leadMeasure', () => {
  it('leads with time when the sport produced no tonnage', () => {
    // BJJ cannot hold a set, so "0 kg" beside three hard classes is a
    // fabricated zero.
    expect(leadMeasure({ sport: 'bjj', sessions: 3, seconds: 5400, volumeKg: 0, days: 3 })).toBe(
      'time',
    );
  });

  it('leads with volume as soon as there is any', () => {
    expect(
      leadMeasure({ sport: 'strength', sessions: 1, seconds: 3600, volumeKg: 500, days: 1 }),
    ).toBe('volume');
  });
});

describe('weekVerdict', () => {
  it('does not claim a plan that was never made', () => {
    const r = reviewWeek([session('2026-08-10', 'bjj')], [], NOW);
    expect(weekVerdict(r)).toBe('1 session across 1 day.');
  });

  it('names the shortfall against a plan without scolding', () => {
    const r = reviewWeek(
      [session('2026-08-10', 'bjj')],
      [plan('2026-08-10', 'bjj'), plan('2026-08-12', 'bjj')],
      NOW,
    );
    expect(weekVerdict(r)).toBe('1 session across 1 day — 1 of 2 planned.');
  });

  it('says so when the whole plan is done', () => {
    const r = reviewWeek([session('2026-08-10', 'bjj')], [plan('2026-08-10', 'bjj')], NOW);
    expect(weekVerdict(r)).toBe('1 session across 1 day — the whole plan, done.');
  });

  it('distinguishes an empty week from an empty week with a plan', () => {
    expect(weekVerdict(reviewWeek([], [], NOW))).toBe('Nothing logged yet.');
    expect(weekVerdict(reviewWeek([], [plan('2026-08-10', 'bjj')], NOW))).toBe(
      'Nothing logged against this week’s plan yet.',
    );
  });
});
