import {
  carriedTheStreak,
  formatDuration,
  spanRange,
  thisWeek,
  SPANS,
  type HistoryDay,
} from '../history';

/**
 * The You screen's calendar maths.
 *
 * All of it is pure and all of it is load-bearing for what the screen claims:
 * `thisWeek` decides which bar is which day, `spanRange` decides what the
 * segmented control actually asks the API for, and `formatDuration` decides
 * whether a year of training fits in a third of the screen or overlaps the
 * stat beside it.
 *
 * Every test here passes an explicit `to`. Anything keyed on the real clock
 * would pass on a Tuesday and fail on a Sunday, which is the worst kind of
 * test in a file entirely about which day it is.
 */

function day(date: string, over: Partial<HistoryDay> = {}): HistoryDay {
  return {
    date,
    sessions: 1,
    working_sets: 10,
    total_reps: 50,
    tonnage_kg: 1000,
    duration_seconds: 3600,
    sports: ['strength'],
    ...over,
  };
}

describe('thisWeek', () => {
  // Wednesday 5 August 2026. Its Monday is the 3rd.
  const WED = '2026-08-05';

  it('is always seven days starting on Monday', () => {
    const week = thisWeek([], WED);
    expect(week).toHaveLength(7);
    expect(week.map((d) => d.date)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('is seven days even when nothing at all was logged', () => {
    // The chart's whole premise: seven columns, whatever happened. A version
    // that mapped over the API's days would render an empty week as no chart.
    expect(thisWeek([], WED).every((d) => d.sessions === 0)).toBe(true);
    expect(thisWeek([], WED)).toHaveLength(7);
  });

  it('marks days after today as not yet elapsed', () => {
    const week = thisWeek([], WED);
    // Mon–Wed have happened; Thu–Sun have not. A future day drawn as a zero
    // bar reads as a session you missed, which is why the flag exists.
    expect(week.map((d) => d.elapsed)).toEqual([true, true, true, false, false, false, false]);
  });

  it('counts today itself as elapsed', () => {
    expect(thisWeek([], WED)[2]).toMatchObject({ date: WED, elapsed: true });
  });

  it('places each logged day on its own column', () => {
    const week = thisWeek(
      [day('2026-08-03', { tonnage_kg: 5000 }), day('2026-08-05', { tonnage_kg: 250 })],
      WED,
    );
    expect(week.map((d) => d.tonnageKg)).toEqual([5000, 0, 250, 0, 0, 0, 0]);
  });

  it('converts seconds to minutes', () => {
    const week = thisWeek([day('2026-08-04', { duration_seconds: 5400 })], WED);
    expect(week[1].minutes).toBe(90);
  });

  it('ignores days outside this week', () => {
    // The span control can be a year, so `history.days` routinely carries
    // hundreds of rows. Summing them all into a seven-day chart would make
    // every bar the height of a quarter.
    const week = thisWeek(
      [day('2026-07-27', { tonnage_kg: 9999 }), day('2026-08-10', { tonnage_kg: 9999 })],
      WED,
    );
    expect(week.every((d) => d.tonnageKg === 0)).toBe(true);
  });

  it('starts on Monday even when today is Sunday', () => {
    // Sunday is `getUTCDay() === 0`, the off-by-one every week calculation
    // gets wrong: a naive version puts Sunday at the start of the coming week.
    const week = thisWeek([], '2026-08-09');
    expect(week[0].date).toBe('2026-08-03');
    expect(week[6].date).toBe('2026-08-09');
    expect(week[6].elapsed).toBe(true);
  });
});

describe('spanRange', () => {
  const WED = '2026-08-05';

  it('ends on the requested day and starts on a Monday', () => {
    for (const s of SPANS) {
      const { from, to } = spanRange(s.key, WED);
      expect(to).toBe(WED);
      // Checked against the calendar, NOT against `startOfWeek` — `from` is
      // built with `startOfWeek`, so comparing the two only asserts
      // idempotence and would pass just as happily if weeks began on Sunday.
      expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it('covers the advertised number of weeks', () => {
    for (const s of SPANS) {
      const { from } = spanRange(s.key, WED);
      const weeks = (Date.parse(`${WED}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 6.048e8;
      // From this Monday back, so the partial current week is the +1.
      expect(Math.floor(weeks) + 1).toBe(s.weeks);
    }
  });

  it('gives one week the current week only', () => {
    expect(spanRange('1w', WED)).toEqual({ from: '2026-08-03', to: WED });
  });

  it('widens with the span, strictly', () => {
    const froms = SPANS.map((s) => spanRange(s.key, WED).from);
    // Strictly, so two spans cannot silently fetch the same range — a sorted
    // comparison tolerates duplicates.
    for (let i = 1; i < froms.length; i++) expect(froms[i] < froms[i - 1]).toBe(true);
  });
});

describe('formatDuration', () => {
  it('shows minutes under an hour', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60)).toBe('45m');
  });

  it('shows hours and minutes in between', () => {
    expect(formatDuration(3600 + 41 * 60)).toBe('1h 41m');
    expect(formatDuration(2 * 3600)).toBe('2h');
  });

  it('keeps minutes right up to 100 hours', () => {
    expect(formatDuration(99 * 3600 + 59 * 60)).toBe('99h 59m');
  });

  it('drops minutes past 100 hours', () => {
    // A year of training is the case this exists for: "312h 45m" is four
    // characters longer than the stat tile is wide, and at that scale the
    // minutes are noise. The threshold is where hours reach three digits, so
    // the rendered width stops growing.
    expect(formatDuration(100 * 3600 + 59 * 60)).toBe('100h');
    expect(formatDuration(312 * 3600 + 45 * 60)).toBe('312h');
  });
});

describe('carriedTheStreak', () => {
  // A Wednesday. startOfWeek is Monday, so this week is 2026-08-03..09.
  const wed = '2026-08-05';

  it('is true for the only session of the week', () => {
    expect(carriedTheStreak([day('2026-08-05', { sessions: 1 })], wed)).toBe(true);
  });

  it('is false for the second session of the same week', () => {
    // Train four times a week and only the first carries anything. If this
    // ever goes true, the chime fires on every session and means nothing by
    // Thursday.
    expect(
      carriedTheStreak([day('2026-08-03', { sessions: 1 }), day('2026-08-05', { sessions: 1 })], wed),
    ).toBe(false);
  });

  it('is false for two sessions logged on the SAME day', () => {
    // Counts sessions, not days with sessions — a double day is still not a
    // streak being carried twice.
    expect(carriedTheStreak([day('2026-08-05', { sessions: 2 })], wed)).toBe(false);
  });

  it('is false when the week is empty, which is what "not synced yet" looks like', () => {
    // The finish has not reached the server, so history cannot see it. Silence
    // is the honest answer; a chime here would be a guess.
    expect(carriedTheStreak([day('2026-07-29', { sessions: 1 })], wed)).toBe(false);
  });

  it('ignores previous weeks entirely, however long the run', () => {
    // The streak's LENGTH is not what this decides — only whether this week
    // has just been opened.
    const days = [
      day('2026-07-20', { sessions: 3 }),
      day('2026-07-27', { sessions: 2 }),
      day('2026-08-05', { sessions: 1 }),
    ];
    expect(carriedTheStreak(days, wed)).toBe(true);
  });

  it('is false on an empty history', () => {
    expect(carriedTheStreak([], wed)).toBe(false);
  });

  it('counts days with zero sessions as absent, not as the one', () => {
    expect(
      carriedTheStreak([day('2026-08-04', { sessions: 0 }), day('2026-08-05', { sessions: 1 })], wed),
    ).toBe(true);
  });
});
