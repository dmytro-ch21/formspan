import { addDays, dayString, startOfWeek } from './calendar';
import { owedOn } from './adherence';
import type { Module } from './modules';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';
import {
  both,
  buildTrainBoard,
  PLAN_WINDOW_DAYS,
  toPlannedOffer,
  type PlannedOffer,
  type ResumeOffer,
  type Source,
} from './trainBoard';
import type { Workout } from './workouts';

/**
 * What Today leads with, derived from the same reads Train uses.
 *
 * ## Why this is built ON `lib/trainBoard.ts` rather than beside it
 *
 * Today and Train ask overlapping questions of the same three local tables —
 * *is a session open?*, *what is owed?*, *what is next?* — and the answer has
 * to be the same on both. It already diverged once in the small: the 24-hour
 * staleness boundary was a constant in each file until review noticed that one
 * edit would leave the two screens disagreeing about the word "unfinished"
 * with each looking correct on its own.
 *
 * So the ordering and the `owedOn` subtraction are not re-derived here.
 * {@link buildTodayBoard} calls {@link buildTrainBoard} for `resume` and
 * `later`, and adds the TWO things Train does not need — see `viewDay` and
 * `done` below.
 *
 * ## `viewDay`: the day being browsed, separate from `now`
 *
 * Today has a day switcher again — removed by this ticket's first pass, then
 * restored on direct user instruction after review, because "we can go to
 * before dates or future ones" is a continuous-navigation request a jump to
 * another tab does not satisfy. `now` stays the real clock — it is what
 * resume's staleness and `later`'s "after today" are measured against, and it
 * must never move when the athlete steps the switcher. `viewDay` is the day
 * the OWED/DONE/REST section describes, and it defaults to `now` when nobody
 * has stepped away from today.
 *
 * The two are independent by construction: `resume` and `later` come from
 * `buildTrainBoard`, which only ever sees `now`. Only the plan-and-session
 * counts below read `viewDay`. That is what keeps browsing to last Tuesday from
 * quietly changing what "stale" or "later" mean — the exact bug a `viewDay` fed
 * into `buildTrainBoard` in place of `now` would reintroduce.
 *
 * ## The distinction Today adds beyond `viewDay`
 *
 * Train offers what you can still do; a plan that has been met is simply not
 * offered. Today also has to say *how the day went*, and **"you planned two
 * sessions and did both" is not the same day as "you planned nothing"** — the
 * second sentence, shown at the moment an athlete finishes their last session,
 * is the one flatly untrue thing this screen used to say. That is `done` vs
 * `rest`, and it needs the unfiltered count of the day's plans, which
 * `buildTrainBoard` deliberately does not return.
 *
 * ## Loading is a kind, not an absence
 *
 * Everything here is a {@link Source} — `unread`, `unavailable`, `ready` — the
 * union N177 introduced and N178 arrived at independently. **This module exists
 * because Today did not have it.** `viewPlans` and `weekPlan` were plain arrays
 * initialised to `[]`, and `refreshPlan` swallowed its own errors, so
 * *"we have not looked yet"*, *"the read failed"* and *"there is nothing
 * planned"* were one value — and Today asserted **"Nothing planned"** on the
 * first frame of every cold open, and kept asserting it when the read failed.
 *
 * That is the fourth instance of one defect class on this codebase (a trend
 * card telling an athlete with two years of weigh-ins to start logging; a
 * tracker screen telling somebody with a month of history that they track
 * nothing; a records card drawing its empty state mid-fetch), and it is the
 * reason this ticket's acceptance criterion — *a rest day renders a real state,
 * not an empty screen or a discouraging one* — could not be met before it was
 * fixed. A genuine rest day and a failed read produced the identical screen.
 *
 * `rest` is reachable **only** from two answered reads. There is no path from
 * an unread or failed plan to a rest day.
 */
export type TodayLead =
  /**
   * A session is open. **Outranks everything else unconditionally** — see
   * {@link buildTodayBoard} for why that word is load-bearing, and note it is
   * unconditional with respect to `viewDay` too: a resume is never displaced by
   * browsing to another day.
   */
  | { kind: 'resume'; offer: ResumeOffer }
  /** Planned for `viewDay`, and nothing has met it yet. */
  | { kind: 'owed'; plans: PlannedOffer[] }
  /** Planned for `viewDay`, and all of it is logged. `planned` is how many. */
  | { kind: 'done'; planned: number }
  /**
   * Nothing was planned for `viewDay`, and every read that says so has
   * answered.
   *
   * `loggedToday` is how many sessions were logged on `viewDay` anyway — an
   * unplanned lift or a class that was not on the calendar. It is the
   * difference between *"nothing scheduled"* and *"nothing scheduled and you
   * did nothing"*, and the screen must not say the second when the first is
   * true: an athlete who trained off-plan reading "Nothing on the plan" and
   * nothing else has been told their session did not count.
   */
  | { kind: 'rest'; loggedToday: number };

export type TodayBoard = {
  /** Block 1 — NOW / NEXT. The screen's single primary. */
  lead: Source<TodayLead>;
  /** Block 2 — LATER. The soonest planned day strictly after real `now`. */
  later: Source<PlannedOffer | null>;
};

export function buildTodayBoard(input: {
  sessions: Source<Session[]>;
  /**
   * Plans over a window that may start before today and must always cover
   * `viewDay` — see {@link todayPlanWindow}, which is what widens the query to
   * guarantee that.
   */
  plans: Source<PlannedSession[]>;
  /** Names only. A failure degrades a label, never a plan's existence. */
  workouts: Source<Workout[]>;
  modules: Module[];
  /** The real clock. Resume's staleness and `later` are measured against this. */
  now: Date;
  /**
   * The day OWED/DONE/REST describes. Defaults to `now` — most opens never
   * touch the switcher, and the common case should not have to pass this.
   */
  viewDay?: Date;
}): TodayBoard {
  const board = buildTrainBoard(input);

  /*
   * Resume wins BEFORE the plan reads are consulted, and the early return is
   * the mechanism rather than a comment about intent.
   *
   * The acceptance criterion is "unconditionally", and the conditions it has to
   * survive are the other reads' states AND `viewDay`: an open session must
   * lead the screen even while the plan is still loading, even when the plan
   * read has failed outright, and even while the athlete is looking at a
   * different day entirely. Fold this into the `both` below and a failed plan
   * read — or a browsed day — turns a live session into "we could not look" or
   * hides it, either of which loses a running clock in a gym.
   */
  if (board.resume.state === 'ready' && board.resume.value !== null) {
    return {
      lead: { state: 'ready', value: { kind: 'resume', offer: board.resume.value } },
      later: board.later,
    };
  }

  const { workouts, modules } = input;
  const viewDayKey = dayString(input.viewDay ?? input.now);

  /*
   * How many plans `viewDay` carries at all, met or not.
   *
   * Carries its source's state rather than defaulting to 0, which is the whole
   * point: a zero from an unread query is exactly the "Nothing planned" lie
   * this module was written to remove.
   */
  const planned: Source<number> =
    input.plans.state === 'ready'
      ? { state: 'ready', value: input.plans.value.filter((p) => p.day === viewDayKey).length }
      : input.plans;

  /*
   * Sessions logged on `viewDay`, planned or not.
   *
   * Its own `Source` rather than read out of the closure below, so every kind
   * of {@link TodayLead} has a vector that can construct it. An unreachable
   * fallback branch is how #583 shipped an `empty` state no test could ever
   * build and a green assertion about copy that could never appear.
   */
  const loggedToday: Source<number> =
    input.sessions.state === 'ready'
      ? {
          state: 'ready',
          value: input.sessions.value.filter(
            (s) => dayString(new Date(s.started_at)) === viewDayKey,
          ).length,
        }
      : input.sessions;

  /*
   * `viewDay`'s owed plans, computed directly rather than through
   * `board.today` — which `buildTrainBoard` fixes to `dayString(now)` and can
   * therefore never answer for a browsed day. `owedOn` and {@link
   * toPlannedOffer} are the same two functions Train's own `today` block uses,
   * so a change to what "owed" means still lands on both screens from one
   * place; only the DAY they are asked about differs here.
   */
  const owed: Source<PlannedOffer[]> = both(input.sessions, input.plans, (logged, allPlans) =>
    owedOn(
      logged,
      allPlans.filter((p) => p.day === viewDayKey),
    ).map((p) => toPlannedOffer(p, workouts, modules)),
  );

  const counts = both(owed, planned, (owedPlans, count) => ({ owedPlans, count }));

  const lead = both(counts, loggedToday, ({ owedPlans, count }, logged): TodayLead => {
    if (owedPlans.length > 0) return { kind: 'owed', plans: owedPlans };
    if (count > 0) return { kind: 'done', planned: count };
    return { kind: 'rest', loggedToday: logged };
  });

  return { lead, later: board.later };
}

/**
 * The `[from, to]` Today's single plan read covers.
 *
 * **One read, not two — widened rather than duplicated to also cover
 * `viewDay`.** The screen used to issue a week query for the calendar and a
 * second one for the switcher's day, which is two answers to "is Thursday
 * planned" a few hundred points apart — the W2/W4 shape this repo has shipped
 * twice. This still starts at the current week's Monday (so THIS WEEK and this
 * read share rows) and still reaches Train's own horizon ({@link
 * PLAN_WINDOW_DAYS}, so LATER means the same thing on both screens) — and now
 * ALSO widens either end to include `viewDay`, so stepping the switcher three
 * weeks back does not silently ask a question the query cannot answer. One
 * bigger query, never a second one.
 *
 * `addDays`, never `+ n * 86_400_000`: the millisecond form crosses a DST
 * boundary an hour short and lands on the previous calendar day, which shortens
 * the window by a day twice a year in every zone that shifts. **Only visible
 * within an hour of midnight**, and `useTodayBoard` normalises both dates to
 * noon before calling this — so today the guard is protecting a future caller
 * rather than fixing a live bug, and its test says so.
 */
export function todayPlanWindow(now: Date, viewDay: Date = now): { from: string; to: string } {
  const weekStart = startOfWeek(now);
  const horizon = addDays(now, PLAN_WINDOW_DAYS);
  const from = viewDay.getTime() < weekStart.getTime() ? viewDay : weekStart;
  const to = viewDay.getTime() > horizon.getTime() ? viewDay : horizon;
  return { from: dayString(from), to: dayString(to) };
}

/**
 * The day key a browsed-day-following read should use — Momentum's own
 * (N179/#584 follow-up), and any future one built the same way.
 *
 * **Real today whenever a session is resuming, regardless of `viewDay`.** The
 * day switcher is hidden during a resume (see the render in
 * `app/(tabs)/index.tsx`), so there is no way for the athlete to see or
 * correct a `dayOffset` left over from browsing before the session started —
 * and this screen stays mounted for the process's life, so that leftover can
 * genuinely still be sitting there. "The resume card leads, full stop" means
 * nothing else on the screen describes a browsed day while a session is
 * running; this is what makes that true for a day-following read too, rather
 * than silently keying it off whatever day the switcher was last left on.
 *
 * Pulled out on its own — this one-line branch shipped with no test able to
 * catch its deletion, because reproducing "browsed away, THEN a session
 * starts" through the full screen needs the plan window to widen before the
 * resume state changes, which is an awkward sequence to orchestrate and an
 * easy one to get subtly wrong. As a pure function it needs neither.
 */
export function momentumDayKey(resume: boolean, viewDay: Date, todayKey: string): string {
  return resume ? todayKey : dayString(viewDay);
}
