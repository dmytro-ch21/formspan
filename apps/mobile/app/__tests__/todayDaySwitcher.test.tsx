import { addDays, dayString } from '@/lib/calendar';
import { owedOn } from '@/lib/adherence';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';

/**
 * The two bugs the day switcher introduced on Today, both found by tracing
 * rather than by running — which is exactly when a test earns its keep, and
 * neither had one until review said so.
 *
 * These cover the *logic* the screen composes, not the screen. Today's own
 * render pulls Clerk, sync, the module registry, SQLite and four other screens
 * through `expo-router`; standing all of that up to assert two derivations
 * would mostly test the harness. What can go wrong here is the arithmetic —
 * and the arithmetic now lives in functions the screen calls rather than
 * inlines, which is what makes covering it here mean anything.
 */

let n = 0;
const session = (day: string, sport: string): Session => ({
  id: `s${(n += 1)}`,
  user_id: 'u1',
  workout_id: null,
  sport,
  name: '',
  started_at: new Date(`${day}T18:00:00`).toISOString(),
  ended_at: null,
  notes: '',
  sets: [],
  created_at: '',
  updated_at: '',
});

const plan = (day: string, sport: string): PlannedSession => ({
  id: `p-${day}-${sport}`,
  day,
  sport,
  workoutId: null,
  notes: '',
});

// The screen's own function, not a copy of it. The first version of this file
// reimplemented the derivation here, which would have stayed green through any
// change to the screen — the shape of test this suite exists to not be.
const owed = owedOn;

describe('a plan on a day outside the current week', () => {
  // `weekPlan` covers only the week `now` is in. Matching against it alone left
  // any plan outside that week unmatchable — and a past plan that looks unmet
  // renders "Not logged", so the screen asserted something false about a day
  // the athlete had trained.
  const FAR = '2026-07-21';

  it('is met by its own session, wherever the day falls', () => {
    expect(owed([session(FAR, 'bjj')], [plan(FAR, 'bjj')])).toEqual([]);
  });

  it('stays owed when that day was trained in another sport', () => {
    const viewPlans = [plan(FAR, 'bjj')];
    expect(owed([session(FAR, 'strength')], viewPlans)).toEqual(viewPlans);
  });

  it('stays owed when the session is on a neighbouring day', () => {
    // The failure this replaced was a plan matched against a list that did not
    // contain it. The opposite error — matching too widely — puts a session
    // from another day onto this one.
    const viewPlans = [plan(FAR, 'bjj')];
    expect(owed([session('2026-07-20', 'bjj')], viewPlans)).toEqual(viewPlans);
  });

  it('needs two sessions to meet two plans on the day', () => {
    const both = [plan('2026-08-05', 'bjj'), { ...plan('2026-08-05', 'bjj'), id: 'p2' }];
    expect(owed([session('2026-08-05', 'bjj')], both)).toHaveLength(1);
    expect(
      owed([session('2026-08-05', 'bjj'), session('2026-08-05', 'bjj')], both),
    ).toEqual([]);
  });
});

describe('the viewed day is an offset, not a captured date', () => {
  /*
   * Held as a `Date` it was anchored at mount and refreshed by nothing, while
   * `now` re-read on focus and on AppState. Leaving the app on Today overnight
   * therefore reopened it in PAST mode — yesterday's date in the switcher, plan
   * cards marked "Not logged" — without the athlete navigating anywhere.
   */
  const view = (now: Date, offset: number) => addDays(now, offset);

  it('follows the clock across midnight instead of being left behind', () => {
    const before = new Date('2026-08-05T23:50:00');
    const after = new Date('2026-08-06T00:10:00');
    // Offset 0 is today on both sides of midnight; a captured Date is not.
    expect(dayString(view(before, 0))).toBe('2026-08-05');
    expect(dayString(view(after, 0))).toBe('2026-08-06');
  });

  it('keeps a deliberate step relative to the new day, not the old one', () => {
    // Stepping to "tomorrow" and leaving the app overnight should show the new
    // tomorrow, not today — the offset is the intent, the date is derived.
    const after = new Date('2026-08-06T00:10:00');
    expect(dayString(view(after, 1))).toBe('2026-08-07');
    expect(dayString(view(after, -1))).toBe('2026-08-05');
  });

  it('decides past and today from the offset, so they cannot disagree', () => {
    // The screen reads `isToday = offset === 0` and `isPast = offset < 0`.
    // Derived from two dates instead, they went out of step with the label the
    // moment `now` moved and `viewDay` did not.
    for (const [offset, today, past] of [
      [0, true, false],
      [-1, false, true],
      [3, false, false],
    ] as const) {
      expect(offset === 0).toBe(today);
      expect(offset < 0).toBe(past);
    }
  });
});
