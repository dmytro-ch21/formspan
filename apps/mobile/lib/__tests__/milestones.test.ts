import type { HistoryDay } from '../history';
import {
  MILESTONES,
  celebratesMilestone,
  isCurrentWeek,
  metThePlan,
  milestoneForSession,
  milestoneReached,
} from '../milestones';
import { celebratesStreak } from '../celebration';

/**
 * The rung logic, and the two properties that keep this from becoming a
 * counter.
 *
 * The load-bearing assertions here are the NEGATIVE ones — that week 27 says
 * nothing, that a session which did not carry the streak says nothing, that an
 * unplanned week is not a met plan. A milestone feature is easy to write so
 * that it fires constantly, and a congratulation that fires constantly is the
 * running number the design note rules out, wearing different clothes.
 */

/** Monday of the week containing `date`, as `startOfWeek` computes it. */
const day = (date: string, sessions = 1): HistoryDay => ({
  date,
  sessions,
  // Everything below is real on the wire and irrelevant here — only `date` and
  // `sessions` decide a streak. Set explicitly rather than cast, so a future
  // field added to `HistoryDay` fails this file instead of arriving as
  // `undefined` inside whatever starts reading it.
  working_sets: 0,
  total_reps: 0,
  tonnage_kg: 0,
  duration_seconds: 0,
  sports: [],
});

/**
 * `n` consecutive training weeks ending in the week of `end`.
 *
 * Built backwards from a Monday so the fixture cannot accidentally straddle a
 * week boundary the way a forward count from an arbitrary date can.
 */
function weeks(n: number, endMonday = '2026-08-17'): HistoryDay[] {
  const out: HistoryDay[] = [];
  const base = new Date(`${endMonday}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(day(d.toISOString().slice(0, 10)));
  }
  return out;
}

// A Tuesday inside the week that `weeks()` ends in.
const TODAY = '2026-08-18';

describe('milestoneReached', () => {
  it('marks the week a rung is reached', () => {
    for (const m of MILESTONES) {
      expect(milestoneReached(weeks(m.weeks), TODAY)?.key).toBe(m.key);
    }
  });

  it('says nothing the week AFTER a rung — the whole point', () => {
    // 27 weeks is a longer streak than 26 and deserves no second
    // congratulation. A `>=` test would fire here, and every week after it,
    // forever — which is a counter, not an achievement.
    expect(milestoneReached(weeks(27), TODAY)).toBeNull();
    expect(milestoneReached(weeks(5), TODAY)).toBeNull();
    expect(milestoneReached(weeks(53), TODAY)).toBeNull();
  });

  it('says nothing below the first rung', () => {
    expect(milestoneReached(weeks(1), TODAY)).toBeNull();
    expect(milestoneReached(weeks(3), TODAY)).toBeNull();
    expect(milestoneReached([], TODAY)).toBeNull();
  });

  it('says nothing when a week was missed, however long the run before it', () => {
    // Four weeks of training with the third week absent: the streak restarts,
    // so no rung is reached. The feature must never reward a total.
    const broken = [...weeks(2), ...weeks(2, '2026-07-20')];
    expect(milestoneReached(broken, TODAY)).toBeNull();
  });
});

describe('milestoneForSession', () => {
  it('fires for the session that carried the streak into the rung', () => {
    expect(milestoneForSession(weeks(4), true, TODAY)?.key).toBe('month');
  });

  it('stays silent for the week’s later sessions', () => {
    // Train four times in the week you hit a month and the card must open
    // once, not four times. `carried` is false for the other three.
    expect(milestoneForSession(weeks(4), false, TODAY)).toBeNull();
  });
});

describe('the chime ladder', () => {
  it('lets a milestone outrank a personal record', () => {
    // The inversion of the record-beats-streak rule, and the reason is
    // frequency: the top rung happens at most once a year.
    expect(celebratesMilestone({ milestone: MILESTONES[3] })).toBe(true);
    expect(
      celebratesStreak({
        recordsSettled: true,
        hasRecords: false,
        carried: true,
        milestone: true,
      }),
    ).toBe(false);
  });

  it('leaves the ordinary streak chime alone when there is no milestone', () => {
    // The pre-existing rule must survive unchanged for every ordinary session,
    // which is nearly all of them.
    expect(celebratesMilestone({ milestone: null })).toBe(false);
    expect(
      celebratesStreak({ recordsSettled: true, hasRecords: false, carried: true }),
    ).toBe(true);
    expect(
      celebratesStreak({
        recordsSettled: true,
        hasRecords: false,
        carried: true,
        milestone: false,
      }),
    ).toBe(true);
  });

  it('still lets a record outrank an ordinary streak', () => {
    expect(
      celebratesStreak({
        recordsSettled: true,
        hasRecords: true,
        carried: true,
        milestone: false,
      }),
    ).toBe(false);
  });
});

describe('metThePlan', () => {
  it('is true only when the week had a plan and met it', () => {
    expect(metThePlan({ planned: 3, met: 3 })).toBe(true);
    // More than planned still counts — the plan was met, and telling someone
    // off for an extra session is the framing this project rules out.
    expect(metThePlan({ planned: 3, met: 4 })).toBe(true);
    expect(metThePlan({ planned: 3, met: 2 })).toBe(false);
  });

  it('refuses a week nobody planned', () => {
    // The hollow-praise case, and the one that would fire for every athlete
    // who does not use the planner: 0 of 0 is not an achievement.
    expect(metThePlan({ planned: 0, met: 0 })).toBe(false);
  });
});

describe('isCurrentWeek', () => {
  it('accepts the week Today is rendering and rejects a closed one', () => {
    expect(isCurrentWeek({ from: '2026-08-17' }, TODAY)).toBe(true);
    expect(isCurrentWeek({ from: '2026-08-10' }, TODAY)).toBe(false);
  });
});
