/**
 * Calendar geometry — the week and month shapes both calendars are built on.
 *
 * **Pure date arithmetic, deliberately holding no data.** It is imported by
 * `lib/plan.ts`, which is a SQLite repository; the dependency runs that way and
 * never back, so a test for a grid shape does not need a database open.
 *
 * It exists because there were four `startOfWeek`s. `lib/plan.ts`,
 * `components/TrainingCalendar.tsx` and `app/(tabs)/index.tsx` each had their
 * own copy of the same eight lines, and the Plan screen needed `monthGrid` —
 * which would have made a fifth. Three of those copies were identical, which is
 * the problem rather than the reassurance: the Monday-first rule is a decision
 * about what a week *is* in this product, and four places to change it means
 * three places to forget.
 *
 * `lib/history.ts` keeps its own `startOfWeek` and is not a fifth copy: it takes
 * and returns a `YYYY-MM-DD` string, never a `Date`, because it works over rows
 * already keyed by day. Same rule, different type — merging them would mean one
 * function that parses and re-formats on every call for no caller's benefit.
 */

/** A cell of a month grid: the day, its key, and whether it belongs to the anchored month. */
export type DayCell = { date: Date; key: string; inMonth: boolean };

/**
 * A `Date` as the local calendar day it falls on.
 *
 * Built from the local getters rather than `toISOString()`, which converts to
 * UTC first — so for anyone west of Greenwich an evening session lands on
 * tomorrow's date, and the plan they made for Tuesday shows up on Monday.
 */
export function dayString(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * `2026-08-19` → `19 Aug`, for an axis tick.
 *
 * Parsed as UTC and formatted as UTC, matching how a `YYYY-MM-DD` is STORED —
 * the mirror of {@link dayString}'s rule rather than a contradiction of it.
 * `new Date('2026-08-19')` is midnight UTC, so reading it back with the local
 * getters renames it to the 18th for everybody west of Greenwich. That is the
 * off-by-one-day bug the suite runs under `TZ=America/Los_Angeles` to catch.
 */
export function shortDate(on: string): string {
  const d = new Date(`${on}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * Monday 00:00 in the device's own timezone — the week boundary the whole app uses.
 *
 * Monday because a training week is a training block and every programme anyone
 * writes starts one on a Monday. Local rather than UTC for the same reason the
 * history endpoint takes a `tz`: "this week" is a claim about the athlete's
 * calendar, not the server's.
 */
export function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay() is 0 on Sunday, which is six days into the week, not minus one.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * `d` shifted by `n` days, preserving its time of day.
 *
 * `setDate` past the end of a month rolls into the next one, which is the
 * behaviour wanted here — and it is why the arithmetic is not `+ n * 86400000`.
 * A day is not 24 hours on the two DST boundaries a year, so millisecond
 * addition lands an hour off and `startOfWeek` then reads the wrong day.
 */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** The seven `Date`s of the week containing `now`, Monday first. */
export function weekDays(now: Date): Date[] {
  const monday = startOfWeek(now);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * The week anchor to show once the clock has moved on — `now` if `anchor` has
 * fallen into a past week, otherwise `anchor` untouched.
 *
 * The Plan screen calls this when it regains focus. The asymmetry is the whole
 * point: a *past* anchor can only be the result of time passing, so correcting
 * it is what stops a tab left open overnight from planning into last week. A
 * *future* anchor was navigated to deliberately, and snapping that one back
 * would make planning two weeks out impossible — you would lose the week every
 * time you left the tab to look something up.
 */
export function refreshedAnchor(anchor: Date, now: Date): Date {
  return startOfWeek(anchor) < startOfWeek(now) ? now : anchor;
}

/** The first of the month `d` falls in, at 00:00 local. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** `d`'s month shifted by `n`, as the first of that month. */
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * Whole weeks covering a month — Monday-first, with the neighbouring days that
 * complete the first and last rows.
 *
 * The spill days are returned with `inMonth: false` rather than omitted, and
 * both calendars render them dimmed rather than blank: a grid with holes in its
 * corners reads as a rendering fault, and the last days of the previous month
 * are genuinely part of the week you are looking at.
 */
export function monthGrid(anchor: Date): DayCell[][] {
  const first = startOfMonth(anchor);
  const weeks: DayCell[][] = [];
  let cursor = startOfWeek(first);
  // Six rows is the maximum a month can span (31 days starting on a Sunday);
  // the loop stops early when a full row has already passed the month's end.
  for (let w = 0; w < 6; w++) {
    const row = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(cursor, i);
      return { date, key: dayString(date), inMonth: date.getMonth() === anchor.getMonth() };
    });
    weeks.push(row);
    cursor = addDays(cursor, 7);
    if (cursor.getMonth() !== anchor.getMonth() && cursor > first) break;
  }
  return weeks;
}
