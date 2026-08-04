import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

/**
 * Training history, phone-sized.
 *
 * The web app owns the analytical surface — filtering, a year of calendar,
 * per-session drill-down. This is deliberately not that. A phone answers one
 * question well, and it's the one the desk can't answer while you're standing
 * in a gym: **am I actually showing up.** Everything here serves that and
 * stops.
 *
 * As on web, no figure is computed here. The API rolls days up server-side so
 * the working-set rule lives in exactly one place; this file buckets what it
 * already summed and works out a streak from the dates.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type HistoryTotals = {
  sessions: number;
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  duration_seconds: number;
  exercises: number;
  active_days: number;
};

export type HistoryDay = {
  date: string; // YYYY-MM-DD in the requested timezone
  sessions: number;
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  duration_seconds: number;
  sports: string[];
};

export type History = {
  from: string;
  to: string;
  totals: HistoryTotals;
  previous: HistoryTotals;
  days: HistoryDay[];
  sports: { sport: string; sessions: number }[];
};

export async function fetchHistory(
  getToken: TokenGetter,
  opts: { from: string; to: string; tz: string },
  signal?: AbortSignal,
): Promise<History> {
  const token = await getToken();
  const q = new URLSearchParams({ from: opts.from, to: opts.to, tz: opts.tz });
  const res = await netFetch(`${API_BASE}/sessions/history?${q}`, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as History;
}

/* -------------------------------------------------------------------------
 * Calendar maths.
 *
 * All of it in UTC on YYYY-MM-DD strings. That looks wrong for a view about
 * *local* days and is what makes it right: the API already resolved each
 * session into a calendar day in the caller's zone, so these are plain dates
 * with no instant attached. Re-applying a zone would make the day after a DST
 * change 23 or 25 hours long, and `addDays(d, 1)` could repeat or skip a day.
 * ---------------------------------------------------------------------- */

function parse(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  const now = new Date();
  return toKey(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function addDays(key: string, n: number): string {
  const d = parse(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}

/** Monday of the week containing `key`. */
export function startOfWeek(key: string): string {
  const dow = (parse(key).getUTCDay() + 6) % 7;
  return addDays(key, -dow);
}

/**
 * The periods the consistency grid offers.
 *
 * `label` is for the segmented control, where four options share one row —
 * "6 months" does not fit and "6M" does. `blurb` and `pick` are for prose,
 * where an abbreviation reads like a stock ticker.
 *
 * They are two fields rather than one because `spanRange` snaps to week
 * boundaries, and **the shortest span is the one the snap is visible in**: on a
 * Monday, `1w` covers a single day. "Nothing logged in the last week" would
 * then be a claim about seven days made from one, so the shortest span says
 * "this week" — which is exactly what it means — while the others keep the
 * rolling phrasing that matches what they actually fetch.
 *
 * Counted in whole weeks because of that same snap: the grid is columns of
 * seven, so a period ending mid-week renders a stub column and every span reads
 * as ramp-up-then-collapse whatever actually happened. 4 / 26 / 52 are the
 * nearest whole weeks to a month, six months and a year — deliberately
 * approximate, and the labels say the round number an athlete thinks in.
 */
export const SPANS = [
  { key: '1w', label: '1W', blurb: 'this week', pick: 'this week', weeks: 1 },
  { key: '1m', label: '1M', blurb: 'in the last month', pick: 'the last month', weeks: 4 },
  { key: '6m', label: '6M', blurb: 'in the last 6 months', pick: 'the last 6 months', weeks: 26 },
  { key: '1y', label: '1Y', blurb: 'in the last year', pick: 'the last year', weeks: 52 },
] as const;

export type SpanKey = (typeof SPANS)[number]['key'];

/** The inclusive range a span covers, ending today and starting on a Monday. */
export function spanRange(span: SpanKey, to = today()): { from: string; to: string } {
  const weeks = SPANS.find((s) => s.key === span)!.weeks;
  // Snapped to week boundaries so the first and last columns are whole weeks.
  // Otherwise both ends are partial and every period reads as ramp-up then
  // collapse, whatever actually happened.
  return { from: addDays(startOfWeek(to), -(weeks - 1) * 7), to };
}

/**
 * How far back the streak looks — deliberately not the selected span.
 *
 * A streak computed from the span's own days is a function of the segmented
 * control rather than of the training: someone training every week reads
 * "4 weeks in a row" on the 4-week view and "12" on the 12-week one, when the
 * truth might be 40. A year is long enough that the cap is nearly never the
 * binding constraint, and it's one extra request of dates.
 */
export function streakRange(to = today()): { from: string; to: string } {
  return { from: addDays(startOfWeek(to), -51 * 7), to };
}

export type DayBucket = {
  /** YYYY-MM-DD. */
  date: string;
  tonnageKg: number;
  minutes: number;
  sessions: number;
  /** False for days later in the week than today — not yet trained OR rested. */
  elapsed: boolean;
};

/**
 * The current week as seven days, Monday first — always seven, never fewer.
 *
 * The volume chart used to draw one bar per week across the whole span, which
 * stopped working the moment the span could be a year: 52 bars in ~340pt is
 * two pixels each, and the chart became a texture. Seven fixed columns say
 * something a 52-bar smear cannot — *which days* of this week you trained, and
 * how much is left of it.
 *
 * Days that have not happened yet are marked `elapsed: false` rather than
 * omitted or zeroed. A Thursday rendered as a zero bar on Tuesday reads as a
 * missed session; the chart draws no bar at all for those days, so absence
 * means "not yet" and any mark means a day that was measured.
 */
export function thisWeek(days: HistoryDay[], to = today()): DayBucket[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const monday = startOfWeek(to);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    const d = byDate.get(date);
    return {
      date,
      tonnageKg: d?.tonnage_kg ?? 0,
      minutes: (d?.duration_seconds ?? 0) / 60,
      sessions: d?.sessions ?? 0,
      elapsed: date <= to,
    };
  });
}

/** Columns of seven, Monday first, covering whole weeks across [from, to]. */
export function buildGrid(
  from: string,
  to: string,
  days: HistoryDay[],
): { date: string; day: HistoryDay | null; inRange: boolean }[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weeks: { date: string; day: HistoryDay | null; inRange: boolean }[][] = [];
  let cursor = startOfWeek(from);
  const last = addDays(startOfWeek(to), 6);
  while (cursor <= last) {
    const week = [];
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

/**
 * Consecutive weeks with at least one session, counting back from this week.
 *
 * Weeks, not days, and that's the whole point. A daily streak in a training
 * app punishes rest days — which are training, not a lapse — so it pushes
 * people toward the one behaviour the app should never encourage. A weekly
 * streak rewards showing up regularly and is silent about which days.
 *
 * The current week counts only once it has a session, so an unbroken run
 * doesn't appear to reset every Monday morning.
 */
export function weekStreak(days: HistoryDay[], from = today()): number {
  const trained = new Set(days.filter((d) => d.sessions > 0).map((d) => startOfWeek(d.date)));
  let week = startOfWeek(from);
  let n = 0;
  if (!trained.has(week)) week = addDays(week, -7); // this week is still open
  while (trained.has(week)) {
    n++;
    week = addDays(week, -7);
  }
  return n;
}

/**
 * Whether these days are better described by load or by time on the mat.
 *
 * Deliberately takes the days it will describe, not the whole fetched period.
 * Handed a year, it answers for the year — so a week of pure BJJ inside a year
 * that contains lifting gets a volume axis, every bar goes to zero, and the
 * chart's meaning changes because of a control three cards above it.
 */
export function loadMetric(days: { tonnage_kg: number }[]): 'volume' | 'time' {
  return days.some((d) => d.tonnage_kg > 0) ? 'volume' : 'time';
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  // Past 100 hours the minutes are noise AND the longest part of the string.
  // A year of training reads "312h", not "312h 45m" — nobody states a year at
  // minute precision, and the four extra characters are what pushed the figure
  // out of a third-width tile. The threshold is where the hours reach three
  // digits, so the rendered width stops growing rather than growing forever.
  if (h >= 100) return `${h}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Percentage change, or null when there's no baseline to compare against. */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatDayLong(key: string): string {
  return parse(key).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

