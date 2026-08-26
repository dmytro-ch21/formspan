import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { dayString } from './calendar';
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
 *
 * ## Why there is no sequence guard, and the assumption that buys
 *
 * The focus read and the sync-completion read can overlap, and neither carries
 * a sequence number. That is safe **because `expo-sqlite` runs a connection's
 * async statements on a serial queue** — a query issued later cannot resolve
 * before one issued earlier, so "an older answer overwrites a newer one" is not
 * reachable. The per-effect `live` flag handles the other half: a read that
 * lands after blur or unmount is dropped, and a re-focus re-reads.
 *
 * **If the database layer ever stops serialising** — a second connection, a
 * pool — this is the first place last-write-wins breaks, and it will break
 * silently. Add the sequence guard then; `app/(tabs)/index.tsx`'s `planSeq` is
 * the shape to copy.
 */
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
): TrainBoard {
  const [sessions, sessionsReady, sessionsFailed] = useSource<Session[]>();
  const [plans, plansReady, plansFailed] = useSource<PlannedSession[]>();
  const [workouts, workoutsReady, workoutsFailed] = useSource<Workout[]>();

  const { lastSyncAt } = useSyncState();

  // Keyed on the DAY STRING, not on `now`.
  //
  // The screen mints a fresh `Date` on every focus, so a memo keyed on the
  // object gets a new identity each time even when the window is unchanged —
  // which changes `read`'s identity, which re-fires the sync effect below, so
  // every focus after the first completed sync ran the three reads **twice**.
  // Same data both times, so nothing rendered wrongly; it was duplicate I/O
  // behind a comment that described the fix rather than the code. Found in
  // review.
  // **Noon**, not midnight, when the day is rebuilt into a `Date` for
  // `planWindow`. Midnight local does not exist on a spring-forward date in
  // some zones, and a `Date` built from one lands on the previous day; noon has
  // twelve hours of slack either side of every DST shift there has ever been.
  const today = dayString(now);
  const { from, to } = useMemo(() => planWindow(new Date(`${today}T12:00:00`)), [today]);

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
  useFocusEffect(
    useCallback(() => {
      let live = true;
      read(() => live);
      return () => {
        live = false;
      };
    }, [read]),
  );

  // Again whenever a sync run finishes, which is the second half of the same
  // story: a plan made on the web arrives through the plan pull, and without
  // this the screen is only ever as fresh as the last focus. Today re-reads
  // this exact table on this exact trigger.
  //
  // A separate effect rather than `lastSyncAt` in the focus deps, and the guard
  // below is why: an effect that only *lists* a value it never reads is one
  // `exhaustive-deps` correctly objects to. `null` means no run has completed
  // yet, so there is nothing new to have arrived — the read on focus above has
  // already covered the first paint.
  useEffect(() => {
    if (lastSyncAt === null) return;
    let live = true;
    read(() => live);
    return () => {
      live = false;
    };
  }, [read, lastSyncAt]);

  return useMemo(
    () => buildTrainBoard({ sessions, plans, workouts, modules, now }),
    [sessions, plans, workouts, modules, now],
  );
}
