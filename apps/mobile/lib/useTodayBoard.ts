import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { dayString } from './calendar';
import type { Module } from './modules';
import { listPlannedBetween, type PlannedSession } from './plan';
import type { Session } from './sessions';
import { cachedWorkouts, listLocalSessions } from './sessionStore';
import { request as requestSync, useSyncState } from './sync';
import { buildTodayBoard, todayPlanWindow, type TodayBoard } from './todayBoard';
import type { Source } from './trainBoard';
import { useSource } from './useTrainBoard';
import type { Workout } from './workouts';

/**
 * Today's three local reads, with the loading discipline attached.
 *
 * ## What this replaced, and why it is a hook
 *
 * Today held `sessions: Session[]`, `weekPlan: PlannedSession[]` and
 * `viewPlans: […][]` as plain arrays initialised to `[]`, refreshed by two
 * `useCallback`s inside a 2,100-line screen, with `refreshPlan` swallowing its
 * own errors. Three consequences, all of them live before this:
 *
 *  1. **"Nothing planned" on the first frame of every cold open.** `[]` is what
 *     the state holds before the query returns, and the render read it as an
 *     answer. Same sentence after a failed read.
 *  2. **Two plan queries per refresh** — a week window and a single day —
 *     which is two answers to *is Thursday planned* on one screen.
 *  3. **A sequence guard** (`planSeq`) to stop the two racing each other, which
 *     only existed because the day stepper could fire them faster than they
 *     resolved.
 *
 * One read, one state machine, and the three states kept apart on the way in.
 * {@link buildTodayBoard} keeps them apart on the way out.
 *
 * ## It shares `useSource` with Train rather than copying it
 *
 * The rule that matters is inside it: **a refresh that fails must not retract
 * an answer already on screen.** An athlete looking at their real plan who
 * walks into a gym dead-spot keeps it; only a FIRST read that fails says so.
 * Two copies of that is how one screen gets it and the other does not — which
 * is the divergence this epic exists to remove, and the reason the staleness
 * constant and the start-route branch are shared too.
 *
 * ## Everything is local, and `requestSync` is still fired here
 *
 * All three reads are SQLite, so Today renders in a basement. Unlike
 * `useTrainBoard`, this one asks the orchestrator for a run on focus:
 * Today has been the app's sync trigger since before Train existed, and moving
 * that would be a change to sync behaviour rather than to this screen.
 */
export function useTodayBoard(
  userId: string | null,
  modules: Module[],
  /** The screen's clock, refreshed on focus and on foreground. */
  now: Date,
): {
  board: TodayBoard;
  /** The raw reads, for the blocks that need the rows rather than the board. */
  sessions: Source<Session[]>;
  plans: Source<PlannedSession[]>;
  /** Re-read everything now — the sync Retry button's follow-up. */
  refresh: () => void;
} {
  const [sessions, sessionsReady, sessionsFailed] = useSource<Session[]>();
  const [plans, plansReady, plansFailed] = useSource<PlannedSession[]>();
  const [workouts, workoutsReady, workoutsFailed] = useSource<Workout[]>();

  const { lastSyncAt } = useSyncState();

  // Keyed on the DAY STRING rather than on `now`: the screen mints a fresh
  // `Date` on every focus, so a memo keyed on the object changes identity each
  // time and re-fires every effect below — duplicate I/O for identical data.
  // Same reasoning, and the same noon rebuild, as `useTrainBoard`: midnight
  // local does not exist on a spring-forward date in some zones and a `Date`
  // built from one lands on the previous day.
  const today = dayString(now);
  const { from, to } = useMemo(() => todayPlanWindow(new Date(`${today}T12:00:00`)), [today]);

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

  // No sequence guard, and this is the one thing that got SIMPLER rather than
  // safer-by-addition. `expo-sqlite` runs a connection's async statements on a
  // serial queue, so an older answer cannot resolve after a newer one; the
  // `planSeq` ref this replaced existed because the day stepper could fire
  // three reads per tap, and the stepper is gone. If the database layer ever
  // stops serialising — a second connection, a pool — this is the first place
  // last-write-wins breaks, and it will break silently.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      read(() => live);
      // Ask the orchestrator; it decides whether now is a moment worth a run.
      // Fire-and-forget — nothing below waits on the network.
      requestSync('today-focus');
      return () => {
        live = false;
      };
    }, [read]),
  );

  // A completed sync is the second way rows arrive: a session or a plan made on
  // the web lands through the pull, and without this the screen is only ever as
  // fresh as the last focus — so the sync Today itself triggered never showed
  // its own results.
  useEffect(() => {
    if (lastSyncAt === null) return;
    let live = true;
    read(() => live);
    return () => {
      live = false;
    };
  }, [read, lastSyncAt]);

  // Foregrounding onto the tab the app was left on is not a focus change, and
  // it is the common case for an app opened to check what you did yesterday.
  useEffect(() => {
    let live = true;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') read(() => live);
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [read]);

  /*
   * The Retry button's re-read, and the one read path that had no liveness
   * guard — it passed `() => true`, so a slow retry resolving after the screen
   * blurred still wrote state.
   *
   * Practically unreachable (the button only exists while this screen is
   * mounted and focused) and fixed anyway, because "the one exception" is how a
   * discipline stops being one. Raised in review.
   *
   * Set in the effect body as well as cleared in the cleanup: under StrictMode
   * the mount effect is invoked twice, so a cleanup-only version would leave
   * the ref false for the whole second life of the component.
   */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(() => read(() => live.current), [read]);

  const board = useMemo(
    () => buildTodayBoard({ sessions, plans, workouts, modules, now }),
    [sessions, plans, workouts, modules, now],
  );

  return { board, sessions, plans, refresh };
}
