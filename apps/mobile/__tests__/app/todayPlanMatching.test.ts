import { owedOn } from '@/lib/adherence';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';

/**
 * Plan matching on Today — that a plan is met by ITS OWN day's session.
 *
 * ## What this file was, and what N179 took out of it
 *
 * It was `todayDaySwitcher.test.tsx`, covering the two bugs Today's day stepper
 * introduced. The stepper is gone — Plan owns day browsing, and Today answers
 * *now* and *next* — so its second half went with it. That half is worth one
 * line of epitaph, because it is the shape this repo keeps re-finding: its last
 * assertion was `expect(offset === 0).toBe(today)` over a table where `today`
 * was defined as `offset === 0`. **True by construction, green forever, and it
 * could not have failed for any change to any file.** Deleting it removes
 * nothing.
 *
 * What survives is the half that still guards live behaviour. `owedOn` is what
 * decides whether Today leads with "Start" or with "that is everything
 * planned", reached now through `buildTrainBoard` — so the arithmetic below is
 * one call away from the screen, and the screen has no copy of it.
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
