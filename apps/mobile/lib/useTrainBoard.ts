import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import type { Module } from './modules';
import { listPlannedBetween, type PlannedSession } from './plan';
import type { Session } from './sessions';
import { cachedWorkouts, listLocalSessions } from './sessionStore';
import { useSyncState } from './sync';
import { buildTrainBoard, planWindow, type Source, type TrainBoard } from './trainBoard';
import type { Workout } from './workouts';

/**
 * Train's three local reads, with the loading discipline attached.
 *
 * ## Why a hook and not a copy of Today's effects
 *
 * `lib/useWeightTrend.ts` exists because a card and a page had their own copies
 * of one fetch and only one of them grew a loading gate — so the card asserted
 * *"Record your weight and the trend appears here"* to an athlete with two
 * years of readings, on every cold open. The fix was one hook owning the fetch,
 * the null/`[]`/failed discipline and an explicit unread state. This is that
 * shape, for Train.
 *
 * It reads through the SAME functions Today does — `listLocalSessions`,
 * `listPlannedBetween`, `cachedWorkouts` — and adds nothing to any of them.
 * There is no second session engine here: nothing in this file writes a
 * session, a set, or a plan.
 *
 * ## Why the reads are separate promises and not one `Promise.all`
 *
 * `Promise.all` rejects on the first failure, which would make an unreadable
 * workout cache erase a perfectly good plan. The three land independently and
 * each carries its own state, so a failure is scoped to the thing that failed
 * — and `buildTrainBoard` is what decides which combinations are still
 * answerable. See its docstring for why the workout cache in particular is
 * never fatal.
 *
 * ## Everything is local
 *
 * All three are SQLite reads. Train therefore renders with no network, which is
 * the ticket's offline requirement — and it is a property of *which functions
 * are called*, not of a cache added here. `requestSync` is deliberately NOT
 * fired from this hook: Today already asks the orchestrator on its own focus,
 * and a second screen requesting a run on every focus is a change to sync
 * behaviour that this ticket has no business making.
 */
export type TrainBoardView = TrainBoard & {
  /** Re-read now. Handed to the screen's pull-to-refresh and nothing else. */
  reload: () => void;
};

/** `unread` until a read settles; the reads never reset it back. */
function useSource<T>(): [Source<T>, (v: T) => void, () => void] {
  const [source, setSource] = useState<Source<T>>({ state: 'unread' });
  const ready = useCallback((value: T) => setSource({ state: 'ready', value }), []);
  const failed = useCallback(() => {
    // Only from `unread`, and this is the reason the setter takes a callback.
    //
    // A refresh that fails must not retract an answer already on screen: the
    // athlete is looking at their real plan, the app goes into a gym dead-spot,
    // and blanking it to "we could not look" is a worse lie than the slightly
    // stale truth. A first read that fails has nothing to keep, so it says so.
    setSource((prev) => (prev.state === 'ready' ? prev : { state: 'unavailable' }));
  }, []);
  return [source, ready, failed];
}

export function useTrainBoard(
  userId: string | null,
  modules: Module[],
  /**
   * Injected rather than read from a clock inside, so the staleness boundary is
   * testable without faking timers. The screen passes a `Date` it refreshes on
   * focus.
   */
  now: Date,
): TrainBoardView {
  const [sessions, sessionsReady, sessionsFailed] = useSource<Session[]>();
  const [plans, plansReady, plansFailed] = useSource<PlannedSession[]>();
  const [workouts, workoutsReady, workoutsFailed] = useSource<Workout[]>();

  const { lastSyncAt } = useSyncState();

  // Keyed on the DAY rather than on `now`. The window only moves when the
  // calendar date does, and keying on the instant would re-read on every tick
  // of the clock the screen keeps for staleness.
  const { from, to } = useMemo(() => planWindow(now), [now]);

  const read = useCallback(
    (alive: () => boolean) => {
      if (!userId) return;
      listLocalSessions(userId, 30).then(
        (rows) => alive() && sessionsReady(rows),
        () => alive() && sessionsFailed(),
      );
      listPlannedBetween(userId, from, to).then(
        (rows) => alive() && plansReady(rows),
        () => alive() && plansFailed(),
      );
      cachedWorkouts(userId).then(
        (rows) => alive() && workoutsReady(rows),
        () => alive() && workoutsFailed(),
      );
    },
    [
      userId,
      from,
      to,
      sessionsReady,
      sessionsFailed,
      plansReady,
      plansFailed,
      workoutsReady,
      workoutsFailed,
    ],
  );

  // On focus, not on mount: a tab screen stays mounted for the life of the
  // process, so coming back from a session it started must show that the
  // session now exists — otherwise Train would still be offering to start what
  // the athlete has just finished.
  //
  // `lastSyncAt` is in the deps for the second half of the same story: a plan
  // made on the web arrives through the plan pull, and without this the screen
  // is only ever as fresh as the last focus.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      read(() => live);
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `lastSyncAt` is
      // not read in the body; it is here to re-run the read when a sync run
      // completes, which is the same trigger Today uses for this exact table.
    }, [read, lastSyncAt]),
  );

  const reload = useCallback(() => read(() => true), [read]);

  const board = useMemo(
    () => buildTrainBoard({ sessions, plans, workouts, modules, now }),
    [sessions, plans, workouts, modules, now],
  );

  return { ...board, reload };
}
