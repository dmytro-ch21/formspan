import { addDays, dayString, startOfWeek } from './calendar';
import { matchPlans } from './adherence';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';
import { totalWeightKg, contributesVolume } from './sessions';

/**
 * The week, summed up — what actually happened, against what was meant to.
 *
 * Today used to count this week's sessions, volume and time inline, for the
 * stat row at the top of the screen. This replaces that (`summariseWeek` is
 * gone — two implementations of "this week's tonnage" are one edit away from
 * disagreeing on screen) and answers the next question, which is a different
 * one: **was that a good week?** That needs a comparison and a split, because
 * "14,200 kg" says nothing on its own and "3 sessions" hides whether they
 * were three lifts or three classes.
 *
 * Computed from the local store rather than fetched, for the reasons Today's
 * own summary records: this has to answer on a gym floor with no signal, and a
 * separately-fetched rollup would eventually disagree with the calendar
 * directly beneath it. The consequence is the window guard below — the local
 * list is bounded by count, not by date, which is the one thing that makes a
 * local rollup able to lie.
 */

/** Working, non-warm-up sets — the rule every volume count in this app shares. */
export type SportTotals = {
  sport: string;
  sessions: number;
  /** Finished sessions only — see {@link accumulate}. */
  seconds: number;
  volumeKg: number;
  days: number;
};

export type WeekTotals = {
  sessions: number;
  days: number;
  seconds: number;
  volumeKg: number;
};

export type WeekReview = {
  /** Monday of the reviewed week, and the Sunday that closes it. */
  from: string;
  to: string;
  totals: WeekTotals;
  /** Most evidence first. Empty when nothing was logged. */
  bySport: SportTotals[];
  /** Plans falling in this week, and how many a session met. */
  planned: number;
  met: number;
  /**
   * The week before, for the deltas.
   *
   * **`null` when the local window cannot prove it**, which is not the same as
   * a quiet zero — see {@link reviewWeek}. Every consumer has to handle it;
   * that is the point of the type.
   */
  previous: WeekTotals | null;
};

/**
 * Fold a set of sessions into one week's totals, plus the per-sport split.
 *
 * Duration counts **finished sessions only**. An open one has no duration yet,
 * and now-minus-start would make the week's total climb while the phone sits in
 * a locker — the same rule, and the same reason, as Today's summary.
 */
function accumulate(sessions: Session[]): { totals: WeekTotals; bySport: SportTotals[] } {
  const days = new Set<string>();
  const perSport = new Map<string, SportTotals & { dayKeys: Set<string> }>();
  let seconds = 0;
  let volumeKg = 0;

  for (const s of sessions) {
    const started = new Date(s.started_at);
    const day = dayString(started);
    days.add(day);

    let sessionSeconds = 0;
    if (s.ended_at) {
      sessionSeconds = (new Date(s.ended_at).getTime() - started.getTime()) / 1000;
    }
    let sessionVolume = 0;
    for (const set of s.sets) {
      if (contributesVolume(set) && set.weight_kg != null && set.reps != null) {
        sessionVolume += totalWeightKg(set) * set.reps;
      }
    }
    seconds += sessionSeconds;
    volumeKg += sessionVolume;

    let bucket = perSport.get(s.sport);
    if (!bucket) {
      bucket = { sport: s.sport, sessions: 0, seconds: 0, volumeKg: 0, days: 0, dayKeys: new Set() };
      perSport.set(s.sport, bucket);
    }
    bucket.sessions++;
    bucket.seconds += sessionSeconds;
    bucket.volumeKg += sessionVolume;
    bucket.dayKeys.add(day);
  }

  const bySport = [...perSport.values()]
    .map(({ dayKeys, ...rest }) => ({ ...rest, days: dayKeys.size }))
    // Sessions first, then the sport name. Total on purpose: two sports on the
    // same count would otherwise order by whichever the athlete happened to log
    // first, so the card would reshuffle itself between two renders of an
    // unchanged week.
    .sort((a, b) => b.sessions - a.sessions || a.sport.localeCompare(b.sport));

  return {
    totals: { sessions: sessions.length, days: days.size, seconds, volumeKg },
    bySport,
  };
}

/**
 * Review the week containing `now`.
 *
 * `sessions` is the local list — bounded by COUNT, not by date, which is the
 * whole reason `previous` can come back null. `listLocalSessions(userId, 30)`
 * returns the thirty most recent sessions; for an athlete training twice a day
 * that is nine days, so last week is *partially* present and summing it would
 * produce a confident number that is simply too small. Every delta drawn from
 * it would then read as a decline the athlete did not have.
 *
 * So the previous week is only reported when the list demonstrably reaches back
 * past its start — i.e. the oldest session on hand predates the previous
 * Monday. That is a conservative test: an athlete who genuinely did not train
 * before last Monday also gets `null`, and "no comparison" is the honest answer
 * for them too, because one week of history cannot say whether this week was
 * better.
 */
export function reviewWeek(
  sessions: Session[],
  planned: PlannedSession[],
  now: Date,
): WeekReview {
  const weekStart = startOfWeek(now);
  const from = dayString(weekStart);
  const to = dayString(addDays(weekStart, 6));
  const prevStart = addDays(weekStart, -7);
  const prevFrom = dayString(prevStart);

  const thisWeek: Session[] = [];
  const lastWeek: Session[] = [];
  let oldest: string | null = null;

  for (const s of sessions) {
    const day = dayString(new Date(s.started_at));
    if (oldest === null || day < oldest) oldest = day;
    if (day >= from && day <= to) thisWeek.push(s);
    else if (day >= prevFrom && day < from) lastWeek.push(s);
  }

  const { totals, bySport } = accumulate(thisWeek);

  // Strictly before: a list whose oldest session is exactly the previous Monday
  // proves nothing about the days before it, and cannot rule out having been
  // truncated at that boundary.
  const reachesBack = oldest !== null && oldest < prevFrom;
  const previous = reachesBack ? accumulate(lastWeek).totals : null;

  const inWeek = planned.filter((p) => p.day >= from && p.day <= to);
  // This week's sessions only — for cost, NOT for correctness, and the
  // distinction is worth stating because the comment here first claimed the
  // opposite. `matchPlans` keys on `day + sport`, and an out-of-week session
  // can never share a day with an in-week plan, so passing the whole list
  // returns the same answer. Mutation testing is what established that: the
  // mutant survived, and the honest response was to fix the claim rather than
  // write a test that could not fail.
  const match = matchPlans(thisWeek, inWeek);

  return { from, to, totals, bySport, planned: inWeek.length, met: match.met.size, previous };
}

/**
 * Relative change, or null when there is nothing to compare against.
 *
 * **Null rather than 0 when `previous` is 0**, and this is the guard worth
 * keeping: going from no training to three sessions is not a 0% change and is
 * not an infinite one either — it is a week that has no percentage. The tile
 * then shows its figure with no arrow, which is the honest rendering; the
 * alternative is `Infinity` reaching a formatter and printing the literal
 * string "Infinity%" next to somebody's first week back.
 */
export function deltaPct(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Which measure a sport's line should lead with.
 *
 * BJJ cannot legally hold a set — no BJJ exercises exist in the catalog — so
 * its volume is structurally zero, and printing "0 kg" next to three hard
 * classes is the fabricated-zero trap `describeSession` documents. Time is the
 * measure that sport actually produces.
 *
 * Decided from the DATA rather than a sport allowlist: a session with working
 * sets has a tonnage worth reading whatever it is filed under, and a sport
 * added later gets sensible behaviour without touching this.
 */
export function leadMeasure(t: SportTotals): 'volume' | 'time' {
  return t.volumeKg > 0 ? 'volume' : 'time';
}

/**
 * A plain-language verdict on the week.
 *
 * Deliberately not a score, a grade or a streak. The design principle the
 * project records is no shame-based messaging, and a number attached to a week
 * invites exactly that — so this names what happened and stops. The one
 * judgement it makes is about *adherence*, because the athlete set that target
 * themselves and comparing against it is not the app's opinion.
 */
export function weekVerdict(r: WeekReview): string {
  if (r.totals.sessions === 0) {
    return r.planned > 0 ? 'Nothing logged against this week’s plan yet.' : 'Nothing logged yet.';
  }
  const unit = r.totals.sessions === 1 ? 'session' : 'sessions';
  const base = `${r.totals.sessions} ${unit} across ${r.totals.days} ${
    r.totals.days === 1 ? 'day' : 'days'
  }`;
  if (r.planned === 0) return `${base}.`;
  if (r.met >= r.planned) return `${base} — the whole plan, done.`;
  return `${base} — ${r.met} of ${r.planned} planned.`;
}
