import type { HistoryDay, Sport } from "./api";

/**
 * Calendar arithmetic for the history page.
 *
 * Every function here works on `YYYY-MM-DD` strings and does its arithmetic
 * in UTC. That looks wrong for a page about *local* days and is precisely
 * what makes it correct: the API has already resolved each session into a
 * calendar day in the caller's timezone, so these strings are plain dates
 * with no instant attached. Re-introducing a zone here would mean the day
 * after a DST change is 23 or 25 hours long and `addDays(d, 1)` could return
 * the same day twice or skip one. UTC days are always 24 hours.
 */

/** Today as YYYY-MM-DD in the browser's own timezone. */
export function today(): string {
  const now = new Date();
  return toKey(
    new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
  );
}

/** The browser's IANA zone, or UTC where it can't be resolved. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function parse(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(key: string, n: number): string {
  const d = parse(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}

export function addMonths(key: string, n: number): string {
  const d = parse(key);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp rather than roll over: three months before 31 May is 28 February,
  // not 3 March. Rolling over would quietly widen the range.
  const lastOfMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return toKey(d);
}

/** Monday-based weekday index, 0 = Monday. */
function weekday(key: string): number {
  return (parse(key).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `key`. */
export function startOfWeek(key: string): string {
  return addDays(key, -weekday(key));
}

export const PERIODS = [
  { key: "4w", label: "4 weeks" },
  { key: "3m", label: "3 months" },
  { key: "1y", label: "Year" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

/** The inclusive [from, to] a period covers, ending today. */
export function periodRange(period: PeriodKey, to = today()): { from: string; to: string } {
  switch (period) {
    case "4w":
      return { from: addDays(to, -27), to };
    case "3m":
      return { from: addDays(addMonths(to, -3), 1), to };
    case "1y":
      return { from: addDays(addMonths(to, -12), 1), to };
  }
}

export type CalendarCell = {
  date: string;
  /** Null for the padding that squares the grid off to whole weeks. */
  day: HistoryDay | null;
  inRange: boolean;
};

/**
 * The full day grid the heatmap draws, as columns of seven starting Monday.
 *
 * The API returns only days that had training — deliberately, so a year isn't
 * 365 mostly-empty objects — so the gaps are reconstructed here. Padding out
 * to whole weeks keeps every column the same height; those cells render as
 * blanks rather than rest days, which is why `inRange` is separate from
 * "has no training".
 */
export function buildCalendar(
  from: string,
  to: string,
  days: HistoryDay[],
): CalendarCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = startOfWeek(from);
  const last = addDays(startOfWeek(to), 6);

  const weeks: CalendarCell[][] = [];
  let cursor = first;
  while (cursor <= last) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        date: cursor,
        day: byDate.get(cursor) ?? null,
        inRange: cursor >= from && cursor <= to,
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export type WeekBucket = {
  /** Monday of the week, YYYY-MM-DD. */
  start: string;
  tonnageKg: number;
  minutes: number;
  sessions: number;
};

/**
 * Weekly rollup for the trend bars.
 *
 * Summing per-day figures the server already computed — no volume rule is
 * re-implemented here, which is the whole reason the API returns days rather
 * than raw sets.
 */
export function byWeek(from: string, to: string, days: HistoryDay[]): WeekBucket[] {
  const buckets = new Map<string, WeekBucket>();
  for (let w = startOfWeek(from); w <= to; w = addDays(w, 7)) {
    buckets.set(w, { start: w, tonnageKg: 0, minutes: 0, sessions: 0 });
  }
  for (const d of days) {
    const b = buckets.get(startOfWeek(d.date));
    if (!b) continue; // a day outside the asked-for range can't own a bar
    b.tonnageKg += d.tonnage_kg;
    b.minutes += d.duration_seconds / 60;
    b.sessions += d.sessions;
  }
  return [...buckets.values()];
}

/**
 * Which measure this period is best described by.
 *
 * Tonnage is a strength idea. A month of BJJ has none, and a chart insisting
 * on it would draw a flat zero line and call it training. Time is the one
 * measure every discipline shares, so it's the fallback rather than a
 * special case per sport.
 */
export function loadMetric(days: HistoryDay[]): "volume" | "time" {
  return days.some((d) => d.tonnage_kg > 0) ? "volume" : "time";
}

/** h:mm-ish, matching what the phone shows. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Percentage change, or null when there's nothing to compare against.
 *
 * Null rather than 0 or Infinity on a zero baseline: the first month of
 * training is not "+∞%", it's a month with no previous month, and saying so
 * is more honest than printing a number.
 */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function sportLabel(s: Sport): string {
  return s === "bjj" ? "BJJ" : s[0].toUpperCase() + s.slice(1);
}

/** "Mar", for the month strip above the calendar. */
export function monthShort(key: string): string {
  return parse(key).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
}

export function formatDayLong(key: string): string {
  return parse(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
