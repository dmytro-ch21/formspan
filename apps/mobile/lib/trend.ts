import { dayString, startOfWeek } from './calendar';
import type { Session } from './sessions';

/**
 * Weeks of training, counted — the strip that sits under Recent.
 *
 * Deliberately **counts of days trained, not volume.** A bar chart of tonnage
 * is a chart a BJJ athlete cannot appear in: mat time produces no kilograms, so
 * a mixed week would render as a strength-only week and a pure BJJ month as an
 * empty chart. This app has already had that bug in the week summary, where a
 * BJJ-only athlete read "0kg volume". Days trained is the one measure every
 * discipline produces.
 *
 * Days, not sessions: two-a-days are normal here, and counting sessions makes a
 * heavy Tuesday look like a heavy week.
 */
export type TrendWeek = {
  /** Monday of the week, as `YYYY-MM-DD`. */
  start: string;
  /** Distinct days with at least one session. 0–7. */
  days: number;
  /** The week `now` falls in — drawn differently, because it is not over. */
  current: boolean;
};

/**
 * The last `weeks` weeks, oldest first, including empty ones.
 *
 * Empty weeks are the point. Dropping them would close the gaps and draw a
 * continuous history over a month somebody missed, which is the flattering lie
 * this codebase refuses everywhere else — a chart that cannot show a lay-off
 * cannot show a comeback either.
 */
export function weeklyDays(sessions: Session[], now: Date, weeks: number): TrendWeek[] {
  const thisWeek = startOfWeek(now);

  // Bucket keys first, so a session is placed by the same local-date rule the
  // calendar uses. Placing by the raw timestamp puts a 9pm Sunday session into
  // the next week for anyone east of Greenwich.
  const daysByWeek = new Map<string, Set<string>>();
  for (const s of sessions) {
    const when = new Date(s.started_at);
    const key = dayString(startOfWeek(when));
    const set = daysByWeek.get(key);
    if (set) set.add(dayString(when));
    else daysByWeek.set(key, new Set([dayString(when)]));
  }

  const out: TrendWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(thisWeek);
    start.setDate(start.getDate() - i * 7);
    const key = dayString(start);
    out.push({ start: key, days: daysByWeek.get(key)?.size ?? 0, current: i === 0 });
  }
  return out;
}

/**
 * Rest-day lines, circulated by date.
 *
 * Keyed on the day rather than picked at random: a line that changes on every
 * render is a screen that flickers, and one that changes on every visit is a
 * screen you cannot quote back to yourself. The same day always says the same
 * thing, and tomorrow says something else.
 *
 * None of them congratulate or scold. The recorded UX direction is explicit
 * that this app does not use shame, and "you haven't trained today!" is the
 * shape that rule exists to prevent — but so is a cheerful "enjoy your rest
 * day!" at someone who is injured. These state the fact and stop.
 *
 * **And none of them name the day.** Today's switcher can be showing any date,
 * so "Today looks like a rest day" went on screen under a heading reading
 * THU, AUG 6 — the line contradicting the date directly above it. Which day
 * this is has already been said twice by the time anyone reads this; the line
 * only has to say what is on it.
 */
const REST_LINES = [
  'Nothing scheduled.',
  'Looks like a rest day.',
  'No session on the plan.',
  'Rest day, going by the plan.',
  'Nothing on the plan for this one.',
];

export function restLine(day: Date): string {
  // Day-of-epoch, so the sequence advances by one each day rather than jumping
  // about, and so it does not reset at a month or year boundary.
  const index = Math.floor(
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 86_400_000,
  );
  return REST_LINES[((index % REST_LINES.length) + REST_LINES.length) % REST_LINES.length];
}
