import { addDays, dayString, startOfWeek } from './calendar';
import type { Module } from './modules';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';
import {
  both,
  buildTrainBoard,
  PLAN_WINDOW_DAYS,
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
 * *is a session open?*, *what is owed today?*, *what is next?* — and the answer
 * has to be the same on both. It already diverged once in the small: the
 * 24-hour staleness boundary was a constant in each file until review noticed
 * that one edit would leave the two screens disagreeing about the word
 * "unfinished" with each looking correct on its own.
 *
 * So the ordering, the `owedOn` subtraction and the `later` pick are not
 * re-derived here. {@link buildTodayBoard} calls {@link buildTrainBoard} and
 * adds the ONE distinction Today needs and Train does not — see `done` below.
 * A change to what "owed today" means lands on both screens, or on neither.
 *
 * ## The distinction Today adds
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
   * {@link buildTodayBoard} for why that word is load-bearing.
   */
  | { kind: 'resume'; offer: ResumeOffer }
  /** Planned for today, and nothing has met it yet. */
  | { kind: 'owed'; plans: PlannedOffer[] }
  /** Planned for today, and all of it is logged. `planned` is how many. */
  | { kind: 'done'; planned: number }
  /**
   * Nothing was planned for today, and every read that says so has answered.
   *
   * `loggedToday` is how many sessions were logged anyway — an unplanned lift
   * or a class that was not on the calendar. It is the difference between
   * *"nothing scheduled"* and *"nothing scheduled and you did nothing"*, and
   * the screen must not say the second when the first is true: an athlete who
   * trained off-plan reading "Nothing on the plan" and nothing else has been
   * told their session did not count.
   */
  | { kind: 'rest'; loggedToday: number };

export type TodayBoard = {
  /** Block 1 — NOW / NEXT. The screen's single primary. */
  lead: Source<TodayLead>;
  /** Block 2 — LATER. The soonest planned day strictly after today. */
  later: Source<PlannedOffer | null>;
};

export function buildTodayBoard(input: {
  sessions: Source<Session[]>;
  /**
   * Plans over a window that may START BEFORE today — Today reads from the
   * start of the current week so the THIS WEEK block and this one come from a
   * single query and cannot disagree. Days before today are ignored here, as
   * `buildTrainBoard` already documents.
   */
  plans: Source<PlannedSession[]>;
  /** Names only. A failure degrades a label, never a plan's existence. */
  workouts: Source<Workout[]>;
  modules: Module[];
  now: Date;
}): TodayBoard {
  const board = buildTrainBoard(input);

  /*
   * Resume wins BEFORE the plan reads are consulted, and the early return is
   * the mechanism rather than a comment about intent.
   *
   * The acceptance criterion is "unconditionally", and the conditions it has to
   * survive are the other reads' states: an open session must lead the screen
   * even while the plan is still loading, and even when the plan read has
   * failed outright. Fold this into the `both` below and a failed plan read
   * turns a live session into "we could not look" — the athlete is standing in
   * a gym with a running clock and the screen has lost it.
   */
  if (board.resume.state === 'ready' && board.resume.value !== null) {
    return {
      lead: { state: 'ready', value: { kind: 'resume', offer: board.resume.value } },
      later: board.later,
    };
  }

  const today = dayString(input.now);

  /*
   * How many plans today carries at all, met or not.
   *
   * Carries its source's state rather than defaulting to 0, which is the whole
   * point: a zero from an unread query is exactly the "Nothing planned" lie
   * this module was written to remove.
   */
  const planned: Source<number> =
    input.plans.state === 'ready'
      ? { state: 'ready', value: input.plans.value.filter((p) => p.day === today).length }
      : input.plans;

  /*
   * `board.today` already folds in the session list — `owedOn` subtracts the
   * plans a session has met — so an unknown session list makes this unread,
   * which is also what stops `rest` being claimed while we cannot yet tell
   * whether a session is open. `both` ranks unavailable over unread for the
   * reason recorded on it: a permanent failure must not sit forever behind a
   * spinner.
   */
  /*
   * Sessions logged today, planned or not.
   *
   * Its own `Source` rather than read out of the closure below, so every kind
   * of {@link TodayLead} has a vector that can construct it. Taking it from
   * `input.sessions` inside the callback would work — `board.today` being ready
   * implies the session read answered — but it would need a fallback branch
   * that nothing can reach, and an unreachable branch is how #583 shipped an
   * `empty` state no test could ever build and a green assertion about copy
   * that could never appear.
   */
  const loggedToday: Source<number> =
    input.sessions.state === 'ready'
      ? {
          state: 'ready',
          value: input.sessions.value.filter((s) => dayString(new Date(s.started_at)) === today)
            .length,
        }
      : input.sessions;

  const counts = both(board.today, planned, (owed, count) => ({ owed, count }));

  const lead = both(counts, loggedToday, ({ owed, count }, logged): TodayLead => {
    if (owed.length > 0) return { kind: 'owed', plans: owed };
    if (count > 0) return { kind: 'done', planned: count };
    return { kind: 'rest', loggedToday: logged };
  });

  return { lead, later: board.later };
}

/**
 * The `[from, to]` Today's single plan read covers.
 *
 * **One read, not two.** The screen used to issue a week query for the calendar
 * and a second one for the viewed day, which is two answers to "is Thursday
 * planned" a few hundred points apart — the W2/W4 shape this repo has shipped
 * twice. It starts at the given week start so the THIS WEEK block is served by
 * the same rows, and runs to the same horizon Train uses ({@link
 * PLAN_WINDOW_DAYS}) so LATER means the same thing on both screens.
 *
 * `addDays`, never `+ n * 86_400_000`: the millisecond form crosses a DST
 * boundary an hour short and lands on the previous calendar day, which shortens
 * the window by a day twice a year in every zone that shifts. **Only visible
 * within an hour of midnight**, and `useTodayBoard` normalises `now` to noon
 * before calling this — so today the guard is protecting a future caller rather
 * than fixing a live bug, and its test says so.
 */
export function todayPlanWindow(now: Date): { from: string; to: string } {
  return {
    from: dayString(startOfWeek(now)),
    to: dayString(addDays(now, PLAN_WINDOW_DAYS)),
  };
}
