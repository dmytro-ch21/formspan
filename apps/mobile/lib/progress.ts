import type { LoggedDaysView } from './nutrition';
import type { ExerciseRecords } from './records';
import type { WeekReview } from './weekReview';

/**
 * What the Progress tab is allowed to claim, and when.
 *
 * ## Why a five-kind union and not a nullable value
 *
 * Every screen on this tab is a READ OF HISTORY, and the failure this app has
 * shipped three times is always the same one: a value that is absent for four
 * different reasons rendered as the single most discouraging of them.
 *
 *  - a trend card told an athlete with two years of weigh-ins to start logging,
 *    on every cold open, because the fetch had not answered yet;
 *  - a tracker screen told somebody with a month of history that they track
 *    nothing;
 *  - a card drew its empty state during a request in flight.
 *
 * Each was a union with four kinds where reality has five, and **"not answered
 * yet" was never one of them.** `lib/nutrition.ts` arrived at the same shape
 * from the same direction — see `TargetView`, `EatenView` and `LoggedDaysView`,
 * whose notes are worth reading before changing anything here — and this is
 * that idiom generalised for a tab that is nothing BUT reads.
 *
 * The five, and the sentence each is allowed to put on screen:
 *
 *  - **`checking`** — nothing has answered. Say so, or say nothing. Never a
 *    zero, never an invitation to start logging.
 *  - **`unavailable`** — something asked and could not be told. "Couldn't load
 *    this just now", never "you have none".
 *  - **`off`** — the module that would answer is turned off. A deployment fact,
 *    not a failure and not an absence of training; N61 is the bill for treating
 *    it as silence.
 *  - **`empty`** — an answer arrived and it says nothing is there. This is the
 *    ONLY state that may invite the athlete to start.
 *  - **`ready`** — an answer arrived with something in it.
 *
 * `stale` rides on the two answered kinds because "these are last week's
 * figures and we could not refresh" is a real and common state on a phone, and
 * it is emphatically not `unavailable`: there IS an answer on screen, it is
 * simply not fresh. `TrainingSummary` has drawn this distinction by hand since
 * it shipped; here it is part of the type.
 */
export type Reading<T> =
  | { state: 'checking' }
  | { state: 'unavailable' }
  | { state: 'off' }
  | { state: 'empty'; stale: boolean }
  | { state: 'ready'; value: T; stale: boolean };

/**
 * Classify one read.
 *
 * **The order of the branches IS the guard.** `off` first, because a module
 * that is turned off must not render figures cached from before it was — that
 * is a claim about a discipline the athlete has said they do not do. Then a
 * value if one exists, because an answer in hand beats the reason a later
 * refresh failed. Only then `failed`, and `checking` last as the default —
 * which is the branch every one of the three shipped bugs above was missing.
 *
 * `value` is checked with `!= null` rather than for truthiness: `0`, `''` and
 * an empty array are all legitimate answers, and it is `isEmpty` that decides
 * whether an answer is an empty one.
 */
export function reading<T>(input: {
  /**
   * False when the module behind this read is turned off. Defaults to true —
   * most reads are not module-gated, and a caller that has no gate should not
   * have to say so.
   */
  enabled?: boolean;
  /** The answer, or null/undefined when none has arrived yet. */
  value: T | null | undefined;
  /** Whether the most recent attempt failed. */
  failed?: boolean;
  /** Does an answer that DID arrive say "nothing here"? */
  isEmpty?: (v: T) => boolean;
}): Reading<T> {
  const { enabled = true, value, failed = false, isEmpty } = input;
  if (!enabled) return { state: 'off' };
  if (value != null) {
    return isEmpty?.(value)
      ? { state: 'empty', stale: failed }
      : { state: 'ready', value, stale: failed };
  }
  if (failed) return { state: 'unavailable' };
  return { state: 'checking' };
}

/** The value in a reading, or null in every state that has none. */
export function readingValue<T>(r: Reading<T>): T | null {
  return r.state === 'ready' ? r.value : null;
}

/**
 * Is this read still outstanding?
 *
 * A predicate rather than `r.state === 'checking'` at each call site, because
 * "may I say nothing changed?" is asked of several readings at once and the
 * answer has to be no while any of them is unanswered — see {@link whatChanged}.
 */
export function isChecking(r: Reading<unknown>): boolean {
  return r.state === 'checking';
}

/** Did this read fail outright, with nothing to fall back on? */
export function isUnavailable(r: Reading<unknown>): boolean {
  return r.state === 'unavailable';
}

/**
 * One thing worth telling the athlete about, in the order it is worth telling.
 *
 * `headline` is the INTERPRETATION — what changed, in words — and `detail` is
 * the evidence under it. That split is the tab's whole hierarchy in one type:
 * the ticket asks for meaning before raw data, and a headline that reads
 * "3 sessions" has put the data first.
 */
export type Insight = {
  /** Stable, so a list of these can be keyed and asserted. */
  id: 'records' | 'consistency' | 'body';
  headline: string;
  detail: string;
};

/**
 * What the "What changed" block is allowed to render.
 *
 * The same five kinds as {@link Reading}, minus `off` — this block is never
 * module-gated, because it draws on training, records and body weight together
 * and a multi-sport athlete with one discipline off still has the other two.
 *
 * `quiet` is the honest "nothing stands out", and it is the state most easily
 * got wrong: it may only be reached once **every** source has answered.
 */
export type ChangeView =
  | { state: 'checking' }
  | { state: 'unavailable' }
  | { state: 'quiet' }
  | { state: 'ready'; insights: Insight[] };

/** How many insights the overview shows. The ticket asks for one or two. */
export const MAX_INSIGHTS = 2;

/**
 * The smallest weight movement worth calling a change, in kilograms.
 *
 * Below this it is scale noise dressed as news. `trendWeight` already smooths
 * over a week of readings, so anything that survives to here is a real trend —
 * but a 30 g trend is still not a sentence anybody needs.
 */
export const BODY_NOISE_KG = 0.1;

/**
 * Everything "What changed" reasons over, each as its own reading.
 *
 * Deliberately pre-derived primitives rather than the raw fetch results: this
 * function has to be exercisable without a network, a database or a clock, and
 * the derivations that feed it ({@link freshRecords}) are separately testable
 * for the same reason.
 */
export type ChangeFacts = {
  /** This week against last, from the local session store. */
  week: Reading<WeekReview>;
  /** Personal bests set recently — see {@link freshRecords}. */
  records: Reading<FreshRecords>;
  /** The smoothed weight trend, now against a week ago. */
  body: Reading<BodyChange>;
};

export type FreshRecords = {
  count: number;
  /** The lift the first fresh record belongs to, already named for a human. */
  firstName: string;
};

export type BodyChange = {
  /** Signed: negative is a loss. Kilograms, always — the caller formats. */
  deltaKg: number;
  /** How many days the comparison spans, so the sentence can say. */
  days: number;
};

/**
 * The one or two things that actually changed.
 *
 * ## The guard this function exists for
 *
 * `quiet` — "nothing stands out this week" — is a claim about the athlete's
 * training, and it is only true once every source has been heard from. The
 * branch order below is therefore load-bearing:
 *
 * 1. anything to say → say it, even if another source is still loading;
 * 2. **any source still `checking` → `checking`**, never `quiet`;
 * 3. any source `unavailable` → `unavailable`, so an offline athlete is told
 *    the app could not look rather than that nothing happened;
 * 4. only then `quiet`.
 *
 * Step 2 is the one the three shipped bugs were missing. Step 3 matters nearly
 * as much and is easier to lose: without it, a gym dead-spot renders a
 * confident "nothing stands out" over a week that may have been an athlete's
 * best.
 *
 * ## Why a percentage never appears here
 *
 * `lib/weekReview.ts` has a perfectly good `deltaPct` and this deliberately
 * does not use it: "up 200%" from one session to three is technically true and
 * useless, and it is the tiles above that are the place for a percentage. The
 * comparison is only drawn at all when `previous` is non-null — the local
 * session list is bounded by count, so `reviewWeek` refuses to guess at a week
 * it cannot see all of.
 */
export function whatChanged(facts: ChangeFacts, formatKg: (kg: number) => string): ChangeView {
  const insights: Insight[] = [];

  const records = readingValue(facts.records);
  if (records && records.count > 0) {
    insights.push({
      id: 'records',
      headline:
        records.count === 1
          ? `New personal best: ${records.firstName}`
          : `${records.count} new personal bests`,
      detail:
        records.count === 1
          ? 'Set in the last 30 days.'
          : `Including ${records.firstName}, in the last 30 days.`,
    });
  }

  const week = readingValue(facts.week);
  if (week && week.previous !== null) {
    const now = week.totals.sessions;
    const before = week.previous.sessions;
    if (now !== before) {
      const more = now > before;
      const gap = Math.abs(now - before);
      insights.push({
        id: 'consistency',
        headline: more ? 'You are training more than last week' : 'You are training less than last week',
        // `before` is a MIRRORED, PARTIAL count — `reviewWeek` (N179/#584
        // follow-up) bounds it to the same elapsed range as `now`, not the
        // full previous week. "than last week's ${before}" used to present
        // that partial figure as if it were the week's whole total, so an
        // athlete who trained 6 times last week but only 2 by the equivalent
        // Wednesday would read "2 more than last week's 2" — true of the
        // comparison, misleading about what `before` actually counts.
        // "by this point last week" states what the number IS.
        detail: `${now} ${now === 1 ? 'session' : 'sessions'} so far, ${gap} ${
          more ? 'more' : 'fewer'
        } than the ${before} you had by this point last week.`,
      });
    }
  }

  const body = readingValue(facts.body);
  if (body && Math.abs(body.deltaKg) >= BODY_NOISE_KG) {
    const down = body.deltaKg < 0;
    insights.push({
      id: 'body',
      headline: down ? 'Your weight trend is falling' : 'Your weight trend is rising',
      // No verdict on the direction. Which way an athlete wants it depends on
      // the phase they are in, which this block does not read — the same
      // reasoning `ProgressCard` records for leaving its arrow uncoloured.
      detail: `${formatKg(Math.abs(body.deltaKg))} over ${body.days} days, smoothed.`,
    });
  }

  if (insights.length > 0) return { state: 'ready', insights: insights.slice(0, MAX_INSIGHTS) };

  const all: Reading<unknown>[] = [facts.week, facts.records, facts.body];
  if (all.some(isChecking)) return { state: 'checking' };
  if (all.some(isUnavailable)) return { state: 'unavailable' };
  return { state: 'quiet' };
}

/**
 * How many of these records were set recently, and whose the first one is.
 *
 * `is_recent` is the SERVER's judgement — `lib/records.ts` records why the
 * phone never re-derives "is this a first?", and the same argument applies to
 * "is this new": two opinions that can disagree about whether somebody has just
 * PR'd is worse than one that is occasionally quiet.
 *
 * Counted per EXERCISE rather than per record. A lift that set both a heaviest
 * weight and an estimated 1RM in the same session is one piece of news, and
 * counting the rows would report it as two.
 */
export function freshRecords(
  list: ExerciseRecords[],
  nameOf: (exerciseID: string) => string,
): FreshRecords {
  const fresh = list.filter((er) => er.records.some((r) => r.is_recent));
  return {
    count: fresh.length,
    firstName: fresh.length > 0 ? nameOf(fresh[0].exercise_id) : '',
  };
}

/** Days of the current week that carry a food entry, against days elapsed. */
export type NutritionWeek = { logged: number; elapsed: number };

/**
 * Nutrition consistency for the week, as a reading.
 *
 * A **translation** between two unions rather than a second implementation of
 * either: `LoggedDaysView` already separates the four states this app cares
 * about, and its own note explains why `off` is not `unavailable`. All this
 * adds is the fifth — a week that answered with nothing in it, which is the one
 * state that may say "nothing logged yet".
 *
 * **Denominated in days ELAPSED, not seven.** "0 of 7" on a Monday morning is
 * the same fabricated denominator the training grid documents: it counts days
 * that have not happened as days the athlete failed to log. `weekKeys` is the
 * Monday–Sunday span; anything after `todayKey` is not yet a day anyone could
 * have logged.
 *
 * Days logged are counted from the SAME span, so a stray entry filed under next
 * Saturday cannot push the numerator past the denominator.
 */
export function nutritionWeek(
  view: LoggedDaysView,
  weekKeys: readonly string[],
  todayKey: string,
): Reading<NutritionWeek> {
  if (view.state === 'off') return { state: 'off' };
  if (view.state === 'unavailable') return { state: 'unavailable' };
  if (view.state === 'checking') return { state: 'checking' };

  const elapsed = weekKeys.filter((k) => k <= todayKey);
  const logged = elapsed.filter((k) => view.days.has(k)).length;
  return logged === 0
    ? { state: 'empty', stale: false }
    : { state: 'ready', value: { logged, elapsed: elapsed.length }, stale: false };
}
