import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';

import { localCheckinView, localPhaseView, type CheckinCacheView, type PhaseCacheView } from './bodyCache';
import { dayString } from './calendar';
import { assembleDay, type DayPanel, type Dated } from './dayPanel';
import { localEntries as localFoodEntries, localTargetView } from './foodLog';
import type { Module } from './modules';
import type { Entry, TargetView } from './nutrition';
import { localStepsView, onStepsChanged, requestStepsRefresh, type StepsView } from './steps';
import { useSyncState } from './sync';
import type { TrackerEntry } from './trackerModel';
import { localEntries as localTrackerEntries, localTrackers, type TrackerView } from './trackers';
import { useTodayBoard } from './useTodayBoard';
import { useSource } from './useTrainBoard';

/**
 * The day panel's reads, all of them SQLite — N541 tranche 1 (#972).
 *
 * ## Plan and sessions come from `useTodayBoard`, not from a copy of it
 *
 * Today's hook already owns the session, plan and workout-cache reads, their
 * three-state loading discipline, the re-read when a sync completes and the
 * re-read on foreground. Calling it here is what guarantees the panel and Today
 * cannot disagree about whether a plan is owed: they are the same board, built
 * by the same function from the same query window.
 *
 * One consequence worth knowing: `useTodayBoard` asks the sync orchestrator for
 * a run on focus (`request('today-focus')`). The panel inherits that. It is a
 * request, not a sync — the orchestrator decides, and nothing on this screen
 * waits on it.
 *
 * ## Trackers and food are read here, through the existing read functions
 *
 * Neither has a hook that returns a `Source`. `useTrackerDay` is the tracker
 * CARD's loader — cache, then a network fetch, then a re-read — and its
 * `entriesFor` returns `[]` while loading, which a card can live with and a
 * panel stating *"0 of 8"* cannot. Today's food read lives inline in a
 * 2,200-line screen. So this calls the same SQLite functions they call
 * (`localTrackers`, `localEntries` ×2, `localTargetView`) and nothing else. No
 * network, which is the offline criterion as a property of which functions run.
 *
 * ## The check-in and phase goal are read from the body cache (N568)
 *
 * `localCheckinView` and `localPhaseView` read `lib/bodyCache.ts`, which Today's
 * check-in refresh fills whenever it fetches successfully. The panel still never
 * fetches: it is opened from Today, so with signal the cache is seconds old, and
 * without signal it is the last answer, labelled with when that was.
 *
 * ## Steps are read from the local store too (N569)
 *
 * `localStepsView` reads `daily_steps`, which the Health read passes fill on
 * sign-in and every foreground return — not Today, so a VOLA opened directly
 * gets the same count. On focus the panel also ASKS for a fresh read
 * (`requestStepsRefresh`, at most once a minute, fire-and-forget, a no-op when no
 * orchestrator owns steps), and re-reads the store when a read lands
 * (`onStepsChanged`). It still renders only what SQLite says.
 *
 * Each read is its own promise, for `useTrainBoard`'s reason: `Promise.all`
 * would let an unreadable tracker table erase a perfectly good food total.
 *
 * ## Dated reads
 *
 * The day-scoped reads are stored with the day they were made for, and
 * `assembleDay` refuses one that answers for a different day (`current`). A
 * panel left open across midnight otherwise shows last night's entries under
 * today's date until the re-read lands.
 */
export function useDayPanel(userId: string | null, modules: Module[], now: Date): DayPanel {
  const { board, plans } = useTodayBoard(userId, modules, now);

  const [trackers, trackersReady, trackersFailed] = useSource<TrackerView>();
  const [trackerEntries, trackerEntriesReady, trackerEntriesFailed] =
    useSource<Dated<TrackerEntry[]>>();
  const [foodEntries, foodEntriesReady, foodEntriesFailed] = useSource<Dated<Entry[]>>();
  const [target, targetReady, targetFailed] = useSource<Dated<TargetView>>();
  const [checkins, checkinsReady, checkinsFailed] = useSource<Dated<CheckinCacheView>>();
  const [phases, phasesReady, phasesFailed] = useSource<PhaseCacheView>();
  const [steps, stepsReady, stepsFailed] = useSource<Dated<StepsView>>();

  const { lastSyncAt } = useSyncState();

  // Keyed on the day STRING, for the reason `useTodayBoard` gives: the screen
  // mints a fresh `Date` on focus, and an object key would re-read every time.
  const day = dayString(now);

  const readSteps = useCallback(
    (alive: () => boolean) => {
      if (!userId) return;
      localStepsView(userId, day).then(
        (view) => alive() && stepsReady({ on: day, value: view }),
        () => alive() && stepsFailed(),
      );
    },
    [userId, day, stepsReady, stepsFailed],
  );

  const read = useCallback(
    (alive: () => boolean) => {
      if (!userId) return;
      readSteps(alive);
      localTrackers(userId).then(
        (view) => alive() && trackersReady(view),
        () => alive() && trackersFailed(),
      );
      localTrackerEntries(userId, day).then(
        (rows) => alive() && trackerEntriesReady({ on: day, value: rows }),
        () => alive() && trackerEntriesFailed(),
      );
      localFoodEntries(userId, day).then(
        (rows) => alive() && foodEntriesReady({ on: day, value: rows }),
        () => alive() && foodEntriesFailed(),
      );
      localTargetView(userId, day).then(
        (view) => alive() && targetReady({ on: day, value: view }),
        () => alive() && targetFailed(),
      );
      localCheckinView(userId, day).then(
        (view) => alive() && checkinsReady({ on: day, value: view }),
        () => alive() && checkinsFailed(),
      );
      localPhaseView(userId).then(
        (view) => alive() && phasesReady(view),
        () => alive() && phasesFailed(),
      );
    },
    [
      userId,
      day,
      trackersReady,
      trackersFailed,
      trackerEntriesReady,
      trackerEntriesFailed,
      foodEntriesReady,
      foodEntriesFailed,
      targetReady,
      targetFailed,
      checkinsReady,
      checkinsFailed,
      phasesReady,
      phasesFailed,
      readSteps,
    ],
  );

  // On focus: the panel is pushed over the tabs, and coming back to it after
  // logging a glass or a meal elsewhere must show that it happened.
  //
  // **It also carries the midnight re-read, and that is a reliance worth
  // stating.** `read`'s identity changes when `day` does (the screen moves
  // `now` on focus and on foreground), and `useFocusEffect` re-runs its effect
  // when the callback's identity changes while the screen stays focused —
  // expo-router's vendored hook keys its effect on the callback. `useTodayBoard`
  // adds a separate window-change effect instead; this does not, because that
  // would read twice on every day change here. If `useFocusEffect` ever stops
  // re-running on identity, the day-scoped reads would hold yesterday's rows —
  // and `current()` in `lib/dayPanel.ts` would render them as unread rather
  // than as today's, so the failure is a blank section, never a false fact.
  // Raised in review.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      read(() => live);
      requestStepsRefresh();
      return () => {
        live = false;
      };
    }, [read]),
  );

  // N569: a steps read landed (a foreground pass, or the refresh asked for above).
  useEffect(() => {
    let live = true;
    const off = onStepsChanged(() => readSteps(() => live));
    return () => {
      live = false;
      off();
    };
  }, [readSteps]);

  // And after a sync completes — a target set on the web, or a meal logged on
  // another device, arrives through the pull. `null` is "no run yet", which the
  // focus read above has already covered.
  useEffect(() => {
    if (lastSyncAt === null) return;
    let live = true;
    read(() => live);
    return () => {
      live = false;
    };
  }, [read, lastSyncAt]);

  return useMemo(
    () =>
      assembleDay({
        day,
        board,
        plans,
        trackers,
        trackerEntries,
        foodEntries,
        target,
        checkins,
        phases,
        steps,
        modules,
      }),
    [day, board, plans, trackers, trackerEntries, foodEntries, target, checkins, phases, steps, modules],
  );
}
