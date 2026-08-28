import {
  addDays,
  backdatedTimestamp,
  dayOffsetFor,
  dayString,
  finishTimestampFor,
  monthGrid,
  refreshedAnchor,
  startOfWeek,
  weekDays,
} from '../calendar';

/**
 * Calendar geometry.
 *
 * Pure functions, so this is the one suite in here that needs no fixture — and
 * it is worth having precisely because three screens now share these. A change
 * to the Monday rule used to break one calendar at a time and get noticed on a
 * Simulator; now it breaks all three at once and gets noticed here.
 */

describe('dayString', () => {
  test('is the LOCAL calendar day, not the UTC one', () => {
    // 22:30 local on the 4th. `toISOString()` would roll this to the 5th for
    // anyone east of UTC and keep the 4th west of it — so an evening session
    // would land on the wrong day depending on where the athlete lives. The
    // local getters cannot do that.
    const evening = new Date(2026, 7, 4, 22, 30, 0);
    expect(dayString(evening)).toBe('2026-08-04');

    const earlyMorning = new Date(2026, 7, 4, 0, 15, 0);
    expect(dayString(earlyMorning)).toBe('2026-08-04');
  });

  test('zero-pads, so keys sort lexicographically', () => {
    expect(dayString(new Date(2026, 0, 9))).toBe('2026-01-09');
    // The whole reason the range query can use >= and <= on strings.
    expect('2026-01-09' < '2026-01-10').toBe(true);
  });
});

describe('startOfWeek', () => {
  test('anchors to Monday, including when today IS Sunday', () => {
    // Sunday 9 August 2026. The naive `getDay() - 1` gives -1 here and lands
    // on the *next* Monday, which reports next week's training as this week's.
    const sunday = new Date(2026, 7, 9, 12, 0, 0);
    expect(dayString(startOfWeek(sunday))).toBe('2026-08-03');
  });

  test('a Monday is its own week start', () => {
    const monday = new Date(2026, 7, 3, 12, 0, 0);
    expect(dayString(startOfWeek(monday))).toBe('2026-08-03');
  });

  test('weekDays spans Monday to Sunday inclusive', () => {
    const days = weekDays(new Date(2026, 7, 5, 9, 0, 0)).map(dayString);
    expect(days).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });
});

describe('dayOffsetFor', () => {
  // N430/#692: `app/(tabs)/food.tsx`'s `?date=` deep link decodes into this
  // offset. Wrong here means "See logged food" from a browsed yesterday opens
  // Food on the wrong day — silently, exactly the bug this ticket is about.
  const noon = (y: number, m: number, d: number) => new Date(y, m, d, 12, 0, 0);

  test('today is 0', () => {
    expect(dayOffsetFor('2026-08-26', noon(2026, 7, 26))).toBe(0);
  });

  test('yesterday is -1, regardless of the time of day `now` carries', () => {
    // Past midnight, still "now" is the 27th — this is the exact shape of the
    // bug report: browsing back one day from just after midnight.
    const justAfterMidnight = new Date(2026, 7, 27, 0, 5, 0);
    expect(dayOffsetFor('2026-08-26', justAfterMidnight)).toBe(-1);
  });

  test('a future day is positive', () => {
    expect(dayOffsetFor('2026-08-29', noon(2026, 7, 26))).toBe(3);
  });

  test('round-trips with addDays + dayString for an arbitrary span', () => {
    const now = noon(2026, 7, 26);
    for (const on of ['2026-08-01', '2026-07-15', '2026-09-03', '2026-08-26']) {
      const offset = dayOffsetFor(on, now);
      expect(dayString(addDays(now, offset))).toBe(on);
    }
  });

  test('crosses a month boundary correctly', () => {
    expect(dayOffsetFor('2026-09-02', noon(2026, 7, 31))).toBe(2);
  });

  // frontend-reviewer, N430/#692: `on` comes from a `?date=` URL param, not
  // an internally-constructed `dayString` — a malformed value must not ride
  // silently into `Invalid Date`/`NaN` and land the day-stepper nowhere.
  test('a malformed date falls back to 0 rather than NaN', () => {
    expect(dayOffsetFor('not-a-date', noon(2026, 7, 26))).toBe(0);
    expect(dayOffsetFor('', noon(2026, 7, 26))).toBe(0);
  });
});

describe('backdatedTimestamp', () => {
  // N434/#721: a backfilled BJJ/strength session's `started_at` — the
  // browsed day, with the time-of-day the athlete is actually filling the
  // form in right now.
  test('moves the calendar day, keeps the time of day', () => {
    const base = new Date(2026, 7, 28, 19, 45, 12, 250);
    const result = backdatedTimestamp('2026-08-25', base);
    expect(dayString(result)).toBe('2026-08-25');
    expect(result.getHours()).toBe(19);
    expect(result.getMinutes()).toBe(45);
    expect(result.getSeconds()).toBe(12);
    expect(result.getMilliseconds()).toBe(250);
  });

  test('today round-trips to the same moment', () => {
    const base = new Date(2026, 7, 28, 9, 0, 0);
    expect(backdatedTimestamp('2026-08-28', base).getTime()).toBe(base.getTime());
  });

  test('crosses a month boundary correctly', () => {
    const base = new Date(2026, 7, 28, 6, 30, 0);
    expect(dayString(backdatedTimestamp('2026-07-31', base))).toBe('2026-07-31');
  });

  // The vector this test exists to catch: a malformed `on` must not ride a
  // `NaN` field into `started_at` and mint a session with an unreachable
  // date. Mutating the guard away (e.g. dropping the `Number.isNaN` check,
  // or returning `target` instead of `base`) turns this into
  // `expect(Invalid Date's time).toBe(base's time)`, which fails.
  test('a malformed date falls back to base, not Invalid Date', () => {
    const base = new Date(2026, 7, 28, 9, 0, 0);
    expect(backdatedTimestamp('not-a-date', base).getTime()).toBe(base.getTime());
    expect(backdatedTimestamp('', base).getTime()).toBe(base.getTime());
  });
});

describe('finishTimestampFor', () => {
  // N434 follow-up: a backfilled strength session finishes on a real day
  // that isn't the day it's dated to. Without this, `ended_at` would be
  // stamped with the real "now" — days after a backdated `started_at` —
  // corrupting the elapsed Stat, week totals, the finish celebration card
  // and history rows with a multi-day "duration".
  test('is undefined for an ordinary same-day finish — caller stamps real now', () => {
    const startedAt = new Date(2026, 7, 28, 9, 0, 0);
    const now = new Date(2026, 7, 28, 9, 45, 0);
    expect(finishTimestampFor(startedAt, now)).toBeUndefined();
  });

  test('preserves the REAL elapsed duration for a backdated session', () => {
    // Backfilled Monday at 19:45, actually logged (and finished) at 20:03
    // real time on Thursday — 18 minutes of real logging. The session must
    // read as an 18-minute Monday session, not a multi-day one.
    const startedAt = new Date(2026, 7, 24, 19, 45, 0); // Monday 19:45
    const finishedNow = new Date(2026, 7, 27, 20, 3, 0); // Thursday 20:03 real
    const endedAt = finishTimestampFor(startedAt, finishedNow);
    expect(endedAt).toBeDefined();
    const ended = new Date(endedAt!);
    expect(dayString(ended)).toBe('2026-08-24'); // lands on the SESSION's day
    expect((ended.getTime() - startedAt.getTime()) / 60_000).toBeCloseTo(18, 5); // 18 real minutes
  });

  // The vector this test exists to catch: a naive `backdatedTimestamp` call
  // with no clamp can map to a time BEFORE `started_at` if the real
  // wall-clock crosses local midnight between start and finish (e.g. start
  // backfilling at 23:50, finish logging at 00:10 the next real day).
  test('clamps to at least a minute after started_at, never before it', () => {
    const startedAt = new Date(2026, 7, 24, 23, 50, 0);
    // Finished for real at 00:10 — mapped onto the 24th that is 00:10, which
    // is BEFORE 23:50 the same day.
    const finishedNow = new Date(2026, 7, 25, 0, 10, 0);
    const endedAt = finishTimestampFor(startedAt, finishedNow);
    const ended = new Date(endedAt!);
    expect(ended.getTime()).toBeGreaterThan(startedAt.getTime());
    expect((ended.getTime() - startedAt.getTime()) / 60_000).toBe(1); // the invented minute
  });

  test('a resumed session finished the same day it started is a no-op, even hours later', () => {
    const startedAt = new Date(2026, 7, 28, 6, 0, 0);
    const now = new Date(2026, 7, 28, 22, 0, 0);
    expect(finishTimestampFor(startedAt, now)).toBeUndefined();
  });
});

describe('addDays', () => {
  test('rolls over a month end', () => {
    expect(dayString(addDays(new Date(2026, 7, 31), 1))).toBe('2026-09-01');
  });

  test('goes backwards over a year end', () => {
    expect(dayString(addDays(new Date(2026, 0, 1), -1))).toBe('2025-12-31');
  });

  test('crosses a DST boundary without losing a day', () => {
    // The suite is pinned to America/Los_Angeles, so these are the US dates —
    // an earlier draft used Europe's 25 October and the assertion held under
    // the broken implementation, proving nothing.
    //
    // 1 November 2026 is 25 hours long. Adding 86400000ms to 00:30 that day
    // lands at 23:30 on the SAME day, which `dayString` reads as 1 November —
    // a plan made just after midnight silently lands on the wrong date. Only
    // `setDate` is immune, which is why it is written that way.
    expect(dayString(addDays(new Date(2026, 10, 1, 0, 30), 1))).toBe('2026-11-02');
    // 8 March 2026 is 23 hours long, and the same error runs backwards.
    expect(dayString(addDays(new Date(2026, 2, 9, 0, 30), -1))).toBe('2026-03-08');
  });
});

describe('monthGrid', () => {
  test('every row is a Monday-to-Sunday week', () => {
    for (const row of monthGrid(new Date(2026, 7, 1))) {
      expect(row).toHaveLength(7);
      expect(row[0].date.getDay()).toBe(1);
      expect(row[6].date.getDay()).toBe(0);
      // Contiguous: no gap or repeat between adjacent cells.
      row.forEach((cell, i) => {
        if (i > 0) expect(cell.key).toBe(dayString(addDays(row[i - 1].date, 1)));
      });
    }
  });

  test('covers the whole month, and marks the spill days', () => {
    const cells = monthGrid(new Date(2026, 7, 15)).flat();
    const inMonth = cells.filter((c) => c.inMonth).map((c) => c.key);
    expect(inMonth[0]).toBe('2026-08-01');
    expect(inMonth[inMonth.length - 1]).toBe('2026-08-31');
    expect(inMonth).toHaveLength(31);
    // August 2026 starts on a Saturday, so the first row spills five days back
    // into July. Those are returned, not omitted — a hole reads as a bug.
    expect(cells[0].key).toBe('2026-07-27');
    expect(cells[0].inMonth).toBe(false);
  });

  test('a February that is exactly four weeks still returns four rows', () => {
    // February 2027 is 28 days starting on a Monday — the one shape where a
    // naive "always six rows" pads two entirely foreign weeks onto the grid.
    const grid = monthGrid(new Date(2027, 1, 1));
    expect(grid).toHaveLength(4);
    expect(grid.flat().every((c) => c.inMonth)).toBe(true);
  });

  test('never exceeds six rows, for a 31-day month starting on a Sunday', () => {
    // August 2027: 31 days, starts Sunday — the worst case, six rows.
    expect(monthGrid(new Date(2027, 7, 1))).toHaveLength(6);
  });

  test('the anchor day within the month does not change the grid', () => {
    const first = monthGrid(new Date(2026, 7, 1)).flat().map((c) => c.key);
    const last = monthGrid(new Date(2026, 7, 31)).flat().map((c) => c.key);
    expect(first).toEqual(last);
  });
});

describe('refreshedAnchor', () => {
  const now = new Date(2026, 7, 5, 9, 0, 0); // Wednesday 5 August 2026

  test('leaves the current week alone', () => {
    const monday = new Date(2026, 7, 3);
    expect(refreshedAnchor(monday, now)).toBe(monday);
  });

  test('leaves a future week alone — it was navigated to deliberately', () => {
    // The regression this guards: snapping here means you cannot plan ahead,
    // because every glance at another tab loses the week you were filling in.
    const nextWeek = new Date(2026, 7, 12);
    expect(refreshedAnchor(nextWeek, now)).toBe(nextWeek);
  });

  test('snaps a past week forward — that can only be the clock moving', () => {
    expect(dayString(refreshedAnchor(new Date(2026, 6, 29), now))).toBe(dayString(now));
  });

  test('yesterday snaps when it fell in the previous week, not merely because it is past', () => {
    // Monday 3 August is in `now`'s own week and must survive; Sunday 2 August
    // is one day earlier and must not. A `<` on the dates rather than on their
    // week starts gets this exactly backwards.
    const mondayThisWeek = new Date(2026, 7, 3);
    expect(refreshedAnchor(mondayThisWeek, now)).toBe(mondayThisWeek);
    expect(dayString(refreshedAnchor(new Date(2026, 7, 2), now))).toBe(dayString(now));
  });
});
