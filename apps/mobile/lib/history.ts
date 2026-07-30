import { newTraceId, traceparent } from './trace';

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
  getToken: () => Promise<string | null>,
  opts: { from: string; to: string; tz: string },
  signal?: AbortSignal,
): Promise<History> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');
  const q = new URLSearchParams({ from: opts.from, to: opts.to, tz: opts.tz });
  const res = await fetch(`${API_BASE}/sessions/history?${q}`, {
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
 * Two spans, not five.
 *
 * Web offers 4 weeks / 3 months / a year because a desk is where you compare
 * blocks. On a phone the useful horizons are "this block" and "the last few
 * months"; a year of squares at this width is a texture, not information.
 */
export const SPANS = [
  { key: '4w', label: '4 weeks', weeks: 4 },
  { key: '12w', label: '12 weeks', weeks: 12 },
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

export type WeekBucket = { start: string; tonnageKg: number; minutes: number; sessions: number };

/** Weekly rollup of days the server already summed. No volume rule here. */
export function byWeek(from: string, to: string, days: HistoryDay[]): WeekBucket[] {
  const buckets = new Map<string, WeekBucket>();
  for (let w = startOfWeek(from); w <= to; w = addDays(w, 7)) {
    buckets.set(w, { start: w, tonnageKg: 0, minutes: 0, sessions: 0 });
  }
  for (const d of days) {
    const b = buckets.get(startOfWeek(d.date));
    if (!b) continue;
    b.tonnageKg += d.tonnage_kg;
    b.minutes += d.duration_seconds / 60;
    b.sessions += d.sessions;
  }
  return [...buckets.values()];
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

/** Whether this period is better described by load or by time on the mat. */
export function loadMetric(days: HistoryDay[]): 'volume' | 'time' {
  return days.some((d) => d.tonnage_kg > 0) ? 'volume' : 'time';
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
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

