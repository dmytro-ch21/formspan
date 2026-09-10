/**
 * The day's food.
 *
 * Reads SQLite first and the network second, so the screen is complete with no
 * signal — which is the whole reason `foodLog.ts` is an outbox rather than a
 * thin client.
 *
 * ## The order, and why
 *
 * One remaining block, then a `MealCard` per slot.
 *
 * **This used to say, right here: "There is NO per-meal calorie allocation:
 * '536 calories now available for breakfast' requires knowing a day the app
 * cannot see, it is wrong the moment you eat a big lunch, and it manufactures
 * four budgets to fail against instead of one honest total."** That was true
 * of the version of this screen that shipped it — a single day-remaining line
 * (`mealBudgetLine`) repeated under every section header, chosen specifically
 * as a counter-proposal to true per-meal budgets after `nutrition-design.md`
 * §5 rejected them by that same argument.
 *
 * **REVERSED 2026-08-31 (N124/N113).** The user saw a reference design built
 * on true per-meal budgets and confirmed — twice, after being told this is
 * the identical tension the counter-proposal above already answered once —
 * that this app should build them, matching the reference. Each `MealCard`
 * now states what that slot itself cost (populated) or what is still
 * available for it (empty), via `mealAvailableForDay`/`bySlot` in
 * `lib/nutrition.ts` — see that file's own reversal note for the allocation
 * algorithm and why it was chosen (N468/#792 reworked the algorithm itself —
 * weighted, pooled-remainder redistribution rather than an even split — but
 * did not reopen this per-meal-budgets-exist decision). This is not a call
 * this file gets to re-litigate a third time.
 *
 * ## Training is stated, not spent
 *
 * The training row is NOT BUILT YET — this note is about the rule it must obey
 * when it is, and it is here rather than in a task because the tempting version
 * is the wrong one. It reports what a session cost and changes nothing above
 * it. Adding it back to the target double-counts (the target already includes a
 * 28-day training average) and makes the observed weekly rate unreadable — you
 * could no longer tell a bad week of eating from a moved goalpost.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { ModuleOffNotice } from '@/components/ModuleOffNotice';
import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { ShareSheet } from '@/components/ShareToFriend';
import { EntryMenuSheet } from '@/components/food/EntryMenuSheet';
import type { EntryDragHandlers } from '@/components/food/EntryRow';
import { MealCard } from '@/components/food/MealCard';
import { RemainingBlock } from '@/components/food/RemainingBlock';
import { TargetRow } from '@/components/food/TargetRow';
import { TrackerList } from '@/components/TrackerList';
import { PeriodSwitcher } from '@/components/ui/PeriodSwitcher';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  addDays,
  addMonths,
  dayOffsetFor,
  dayPillLabel,
  dayString,
  monthGrid,
  startOfMonth,
  weekDays,
} from '@/lib/calendar';
import {
  cacheTargets,
  duplicateEntry,
  entrySyncState,
  localEntries,
  localLoggedDays,
  localTargetView,
  moveEntry,
  removeEntry,
  reorderEntries,
} from '@/lib/foodLog';
import {
  bySlot,
  eatenFrom,
  mealAvailableForDay,
  MEALS,
  viewTarget,
  type EatenView,
  type Entry,
  type Meal,
  type TargetView,
} from '@/lib/nutrition';
import { shareBlockedReason } from '@/lib/shares';
import { plan, planInto } from '@/lib/entryOrder';
import { useEntryDrag, type Frames, type RowFrame, type SectionFrame } from '@/lib/useEntryDrag';
import { FoodSummaryCard } from '@/components/food/FoodSummaryCard';
import { useModules } from '@/lib/ModulesProvider';
import { foodLogGate } from '@/lib/modules';
import { listTargets, targetOn } from '@/lib/nutritionApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { useTrackerDay } from '@/lib/useTrackerDay';
import { useUnits } from '@/lib/useUnits';
import { request as requestSync, useSyncState } from '@/lib/sync';
import { PressableScale } from '@/components/ui/PressableScale';

const MEAL_LABELS: Record<Meal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

export default function FoodScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { lastSyncAt } = useSyncState();

  /**
   * N430/#692 — the day Today hands off with `?date=` (its "See logged food"
   * link, or the Log food / quick-add day it just wrote to). `undefined` on a
   * plain tab tap, which must NOT reset anything — see `appliedDateParam`
   * below.
   */
  const params = useLocalSearchParams<{ date?: string }>();

  // An OFFSET rather than a Date, so the screen cannot drift out of sync with
  // the wall clock while it sits mounted — the same shape Today uses.
  //
  // Seeded from `?date=` on first mount so the initial paint is already on
  // the right day rather than flashing today first — see the focus effect
  // below for what re-seeds it on a SECOND deep link, which this lazy
  // initializer cannot: this screen is a tab and stays mounted for the life
  // of the process, so it only ever runs once.
  const [dayOffset, setDayOffset] = useState(() =>
    params.date ? dayOffsetFor(params.date, new Date()) : 0,
  );
  /**
   * The last `?date=` this screen has already applied, so a mere refocus —
   * switching tabs away and back with no new navigation — cannot re-seed the
   * day and clobber a manual step the athlete took after arriving. Expo
   * Router keeps handing back the SAME `params.date` on every refocus of an
   * already-mounted tab; only a genuinely NEW value from a fresh
   * `router.push` should move the stepper.
   */
  const appliedDateParam = useRef(params.date);
  // Keyed to the day, like `dated` below and for the same reason: unkeyed, a
  // day step leaves the PREVIOUS day's rows standing under the new date until
  // the read resolves, so the total on screen belongs to a day you are no
  // longer looking at. That is its own way for calories to "not add up".
  const [loaded, setLoaded] = useState<{ on: string; eaten: EatenView }>({
    on: '',
    eaten: { state: 'loading' },
  });
  // Keyed to the DAY it was computed for. Without the key, stepping to another
  // day leaves the previous day's target standing while the new day's entries
  // render against it — a wrong remaining figure, not merely a stale one — and
  // a failed fetch would leave it there indefinitely. Resetting in an effect
  // would be a synchronous setState the ratchet forbids; deriving is free.
  const [dated, setDated] = useState<{ on: string; view: TargetView }>({
    on: '',
    view: { state: 'checking' },
  });
  const { userId } = useAuth();

  /**
   * N531/#962 — drag an entry between meal sections. The cards register
   * themselves in `cardRefs`; `measure` reads their window frames at the
   * moment a drag starts (see `useEntryDrag`'s doc comment for why at start
   * and not via `onLayout`); `onDrop` is a plain `meal` edit through the
   * outbox, like any edit. Inert while combining: a row that is a checkbox
   * is not a row that lifts.
   */
  const cardRefs = useRef<Partial<Record<Meal, RNView | null>>>({});
  // N553 — one entry ROW's view, so a drop can name a slot inside a meal and
  // not merely the meal. Keyed by entry id and by meal, because a row's meal
  // is what `slotFor` filters on and reading it back off the day's state at
  // drop time would race a re-read that has already moved it.
  const rowRefs = useRef<Map<string, { meal: Meal; view: RNView }>>(new Map());
  const registerRow = useCallback((meal: Meal) => (id: string, view: RNView | null) => {
    if (view) rowRefs.current.set(id, { meal, view });
    else rowRefs.current.delete(id);
  }, []);
  const measure = useCallback(
    (): Promise<Frames> =>
      Promise.all([
        Promise.all(
          MEALS.map(
            (meal) =>
              new Promise<SectionFrame | null>((resolve) => {
                const v = cardRefs.current[meal];
                if (!v) return resolve(null);
                v.measureInWindow((_x, y, _w, h) => resolve({ meal, top: y, bottom: y + h }));
              }),
          ),
        ),
        Promise.all(
          [...rowRefs.current.entries()].map(
            ([id, { meal, view }]) =>
              new Promise<RowFrame | null>((resolve) => {
                view.measureInWindow((_x, y, _w, h) =>
                  // A row inside a COLLAPSED card measures zero height at the
                  // card's origin; four of those stacked on one pixel would
                  // hand `slotFor` four midpoints in the same place. Dropped
                  // here rather than guarded downstream, because "it has no
                  // extent" and "it is not on screen" are the same fact.
                  resolve(h > 0 ? { id, meal, top: y, bottom: y + h } : null),
                );
              }),
          ),
        ),
      ]).then(([sections, rows]) => ({
        sections: sections.filter((f): f is SectionFrame => f !== null),
        rows: rows.filter((f): f is RowFrame => f !== null),
      })),
    [],
  );

  // N81/#415 — the month grid the day switcher's label opens, so a day months
  // back is a couple of taps rather than up to ninety on the ±1-day arrows.
  // Same shape as `WeekPlanner`'s `monthOpen` sheet, one grid convention
  // rather than two: `monthOpen` gates whether it's built at all (see the
  // comment on the `Modal` below), `monthAnchor` is the MONTH the sheet is
  // showing — separate from `dayOffset`, because paging the grid to look for
  // a day must not move the screen behind it until a day is actually picked
  // — and `monthDays` is which of that month's days already have an entry, so
  // the grid can mark them the way `WeekPlanner`'s marks a planned day.
  /**
   * N553/#1019 — which meal is in EDIT MODE, or null. At most one, exactly
   * like `combining` one state below, and for the same reason: two cards both
   * offering "Done" is two answers to "what am I in the middle of".
   *
   * Owned here rather than in `MealCard` so that entering it is a consequence
   * of a gesture on a ROW (the long-press, which the row reports upward) and
   * so that starting a combine can end it.
   *
   * KEYED TO THE DAY, the same shape `loaded` and `dated` already use on this
   * screen: stepping to another day must not leave yesterday's card in edit
   * mode, and clearing it in an effect would be the synchronous setState the
   * lint ratchet forbids. Deriving `editingMeal` from it is free.
   */
  const [editState, setEditState] = useState<{ on: string; meal: Meal } | null>(null);
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [monthDays, setMonthDays] = useState<Set<string>>(new Set());

  /**
   * N115 — combine-select mode. At most one `MealCard` is ever mid-selection:
   * `meal` says which, `selected` is the ids chosen in it so far. `null` is
   * "nobody is selecting", the ordinary state on every other screen visit.
   */
  const [combining, setCombining] = useState<{ meal: Meal; selected: Set<string> } | null>(null);

  /**
   * N531/#962 — the 3-dot menu and the share picker it can open.
   *
   * Each keeps its LAST subject after closing (`open: false` rather than
   * `null`), the same reason `library.tsx`'s sheets keep `shownFacet` past
   * `openFacet`: the Modal animates out with its content still drawn, and a
   * sheet whose title blanks the instant Done is tapped reads as a flicker.
   * `share` is additionally the KEY of the `ShareSheet` below, so a picker
   * opened for a different entry is a fresh instance with no "Sent ✓" ledger
   * borrowed from the last one.
   */
  const [menu, setMenu] = useState<{ entry: Entry; open: boolean } | null>(null);
  const [share, setShare] = useState<{ id: string; open: boolean } | null>(null);
  /**
   * Whether the entry under the menu is safe to share — `entrySyncState`,
   * the same two flags the entry screen read for the same button before
   * this ticket moved it. `undefined` is "not read yet" and the sheet treats
   * it as blocked ("Loading…"); `null` is the read that found nothing to
   * refuse. Re-read on `lastSyncAt` because a push finishing in the
   * background is exactly what turns "Not synced yet" into shareable, and
   * nothing about the entry's own fields changes when it does.
   */
  const [menuSync, setMenuSync] = useState<{ id: string; blocked: string | null } | null>(null);
  const menuEntryId = menu?.open ? menu.entry.id : null;
  useEffect(() => {
    if (!userId || !menuEntryId) return;
    let live = true;
    entrySyncState(userId, menuEntryId).then((s) => {
      if (!live) return;
      // No local row at all reads as blocked, not as permitted — there is
      // nothing here to send. Same posture as the entry screen's `null`.
      const blocked = s ? shareBlockedReason({ ...s, unsavedOnScreen: false }) : 'Not on this device.';
      setMenuSync({ id: menuEntryId, blocked });
    });
    return () => {
      live = false;
    };
  }, [userId, menuEntryId, lastSyncAt]);

  // N61: this tab is REACHABLE with nutrition off now — see `(tabs)/_layout.tsx`
  // for why hiding it was the worse failure — so the screen has to say what
  // state it is in, the way `bjj/log` already does for its own discipline.
  //
  // `foodLogGate` rather than the condition spelled out here: Goals asks the
  // identical question, and a two-part condition written twice is how one copy
  // ends up checking only half. Its `ready` half is what stops a cold start
  // asserting "turned off" from a module list nobody has read yet.
  const { modules, ready: modulesReady } = useModules();
  const { disabled: foodDisabled, off: foodOff } = foodLogGate(modules, modulesReady);

  const on = dayString(addDays(new Date(), dayOffset));

  /**
   * A selection is scoped to one day's section — stepping to a different day
   * mid-selection must not carry yesterday's ids into today's combine.
   *
   * Cleared at every place `dayOffset` itself changes, rather than in a
   * `useEffect` keyed on `on`: setting state synchronously inside an effect
   * is the cascading-render pattern this codebase's own lint rule holds a
   * line against (`react-hooks/set-state-in-effect`), and every OTHER
   * per-day reset on this screen is already absent — there is nothing else to
   * clear, since everything below just re-reads off `on` — so an effect here
   * would exist for this one case alone.
   */
  function setDay(next: number) {
    setCombining(null);
    setDayOffset(next);
  }

  /**
   * Re-seeds the stepper on a SECOND `?date=` deep link.
   *
   * The lazy initializer above only ever runs once — this is a tab screen and
   * stays mounted for the life of the process — so browsing to day A on
   * Today, opening Food (correct, seeded on mount), going back to Today,
   * browsing to day B and opening Food again would otherwise still show day
   * A: the exact "browsed day silently shows the wrong day" failure N430/#692
   * is about, just relocated to the second hop instead of fixed.
   *
   * `useFocusEffect`, not `useEffect` — this screen already has a same-shape
   * precedent (`app/goals/history.tsx`'s own day reset on focus) that a plain
   * `useEffect` calling `setState` synchronously does not: `useEffect` runs on
   * every commit regardless of whether anything meaningful changed, which is
   * the cascading-render pattern this codebase's lint ratchet holds a line
   * against, while a focus event is a real, bounded trigger.
   *
   * Guarded on `appliedDateParam` so a bare refocus — switching tabs away and
   * back with no new navigation, where Expo Router keeps handing back the
   * SAME `params.date` — cannot re-seed the day and silently discard a manual
   * step the athlete took after arriving.
   */
  useFocusEffect(
    useCallback(() => {
      if (params.date && params.date !== appliedDateParam.current) {
        appliedDateParam.current = params.date;
        setDay(dayOffsetFor(params.date, new Date()));
      }
    }, [params.date]),
  );

  // The daily trackers, for whatever day is on screen.
  //
  // Food is the surface where the day is the SUBJECT — the stepper is the point
  // of the screen — so unlike Today these cards follow it. Reading back what
  // you drank on Tuesday belongs here; Today pins its row to today, because a
  // tap there logs a cup now.
  const trackerDay = useTrackerDay();
  const { refresh: refreshTrackers } = trackerDay;
  const { units, unitsReady } = useUnits();
  const isToday = dayOffset === 0;

  const refresh = useCallback(() => {
    // Nothing to read for a module that is off, and `listTargets` would be a
    // round trip on every focus of a screen showing an explanation. Same shape
    // as `bjj/positions`, which guards its fetch on the module rather than
    // relying on the early return below to hide the result.
    if (foodDisabled) return;
    let live = true;
    // Local first, and it alone is enough to render the day.
    //
    // The signed-out case resolves an empty list rather than returning early
    // with a `setLoaded(true)`. That early return was a synchronous setState
    // inside an effect, which is a cascading render — and the warning that
    // catches it is one of the 54 this app holds by ratchet, so adding one
    // fails the gate.
    (userId ? localEntries(userId, on) : Promise.resolve<Entry[]>([]))
      .then((rows) => {
        if (live) setLoaded({ on, eaten: eatenFrom(rows) });
      })
      .catch(() => {
        // **Was `.catch(() => {})`.** A failed local read left `entries` at
        // `[]`, which renders as "nothing logged" — a claim that the athlete
        // ate nothing, made from a read that never happened. Swallowing it is
        // right (nothing here may throw at the screen); reporting it as a zero
        // is not.
        if (live) setLoaded({ on, eaten: { state: 'unavailable' } });
      });

    // The target is the one thing this screen cannot compute — it needs
    // training history the phone does not hold. So: the CACHE first, then the
    // server, and a failed fetch simply leaves the cached answer standing. A
    // day with no cache and no successful fetch ever renders as `unknown`,
    // never as "set a target": telling an athlete who set one on web to go and
    // set it again is the app being wrong rather than uninformed.
    // SEQUENCED, not raced. Started in parallel, a slow cache read can resolve
    // after a fast network answer and overwrite it — a target just deleted on
    // web would reappear until the next focus. The cache read is local and
    // quick, so chaining costs nothing and removes the ordering question.
    let answered = false;
    (userId ? localTargetView(userId, on) : Promise.resolve<TargetView>({ state: 'unknown' }))
      .catch((): TargetView => ({ state: 'unknown' }))
      .then((v) => {
        if (live && !answered) setDated({ on, view: v });
        return listTargets(getToken, { from: on, to: on });
      })
      .then(async (ts) => {
        if (userId) await cacheTargets(userId, on, on, ts);
        if (!live) return;
        answered = true;
        const t = targetOn(ts, on);
        setDated({ on, view: t ? { state: 'set', target: t } : { state: 'none' } });
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [foodDisabled, getToken, on, userId]);

  // Refreshed on FOCUS, not mount: this is a tab screen and stays mounted for
  // the life of the process.
  useFocusEffect(
    useCallback(() => {
      const stop = refresh();
      const stopTrackers = refreshTrackers(on);
      return () => {
        stop?.();
        stopTrackers?.();
      };
    }, [refresh, refreshTrackers, on]),
  );

  // And again after a sync lands, so a push that completed in the background is
  // reflected without a manual pull-to-refresh. A separate effect rather than a
  // dependency on the focus callback: `refresh` does not read `lastSyncAt`, so
  // listing it there is a dependency the linter correctly calls unnecessary.
  useEffect(() => {
    if (!lastSyncAt) return;
    const stop = refresh();
    return stop;
  }, [lastSyncAt, refresh]);

  const eaten: EatenView = loaded.on === on ? loaded.eaten : { state: 'loading' };
  const entries = eaten.state === 'ready' ? eaten.rows : [];
  const slots = bySlot(entries);

  const view: TargetView = dated.on === on ? dated.view : { state: 'checking' };
  // The target each `MealCard` divides for its own "available" figure.
  //
  // Only on TODAY — same suppression the day-level `budget` line this
  // replaced used to carry, and for the identical reason: "available" is a
  // forward-looking claim about what can still go in a slot. On a past day
  // there is nothing left to still eat, and on a future day the target has
  // not been lived into yet either — showing it there is a correct number
  // inside a false sentence, on 100% of non-today views. Found in review, of
  // the original the same way.
  const mealTarget = isToday ? viewTarget(view) : null;
  // The whole day's carryover-aware "available" figures, computed ONCE per
  // render rather than per card — N468/#792's `mealAvailableForDay` needs the
  // whole day in order (carryover is sequential), which is exactly what
  // `slots` already is. `null` with no target, matching `mealTarget` above.
  const availableBySlot = useMemo(() => mealAvailableForDay(slots, mealTarget), [slots, mealTarget]);

  const todayKey = dayString(new Date());
  // Weekday abbreviations for the grid's head row, read off any Monday-first
  // week rather than hard-coded — `WeekPlanner` does the same for the same
  // reason: `toLocaleDateString` is what makes "MON…SUN" become the reader's
  // own locale instead of English no matter what device this runs on.
  const monthHeadDays = weekDays(new Date());

  /**
   * Which days of the open month already have an entry — the grid's only
   * per-cell fact beyond the date itself.
   *
   * Local-only and on-demand, matching `WeekPlanner`'s identical read of
   * planned days: a jump target doesn't need to track a live sync, the day
   * behind it already does, and `localLoggedDays` is a SQLite read so this
   * works with no signal, same as the rest of this screen.
   */
  const monthSeq = useRef(0);
  const loadMonth = useCallback(
    async (month: Date) => {
      if (!userId) return;
      monthSeq.current += 1;
      const seq = monthSeq.current;
      const cells = monthGrid(month).flat();
      try {
        const days = await localLoggedDays(userId, cells[0].key, cells[cells.length - 1].key);
        if (seq !== monthSeq.current) return;
        setMonthDays(new Set(days));
      } catch {
        // An unreadable month is a grid of bare dates — the dots are a hint,
        // and the day behind this sheet is the surface that must be right.
        if (seq !== monthSeq.current) return;
        setMonthDays(new Set());
      }
    },
    [userId],
  );

  function openMonth() {
    // The month the day ON SCREEN belongs to, not the calendar's own month —
    // opening from three months out should not need three extra taps to page
    // back to where you already are.
    const anchor = startOfMonth(new Date(`${on}T00:00:00`));
    setMonthAnchor(anchor);
    loadMonth(anchor);
    setMonthOpen(true);
  }

  function stepMonth(n: number) {
    const next = addMonths(monthAnchor, n);
    setMonthAnchor(next);
    loadMonth(next);
  }

  /**
   * Re-read one day after a local write to it.
   *
   * `wroteOn` is the day the write belonged to, captured by the caller
   * BEFORE any await. Without it, writing and then stepping days races: the
   * write's re-read resolves last and writes `loaded` back to the old day,
   * so the new day falls to `loading` until the next focus or sync. It fails
   * honest — never a number from the wrong day — but it strands the screen.
   * Found in review (of `onDelete`, which every other write here now shares).
   */
  const reloadDay = useCallback(
    async (wroteOn: string) => {
      if (!userId) return;
      const rows = await localEntries(userId, wroteOn);
      setLoaded((prev) =>
        prev.on === wroteOn || prev.on === '' ? { on: wroteOn, eaten: eatenFrom(rows) } : prev,
      );
    },
    [userId],
  );

  async function onDelete(id: string) {
    if (!userId) return;
    const deletingOn = on;
    await removeEntry(userId, id);
    // Every other write in this feature asks for a push; without it the
    // tombstone sits until the next foreground or timer tick, and a row deleted
    // on the phone stays on web for minutes.
    requestSync('food deleted');
    await reloadDay(deletingOn);
  }

  // N531 — the menu's Duplicate. A new local row through the outbox; it is
  // on screen the moment the re-read lands, network or not.
  async function onDuplicate(id: string) {
    if (!userId) return;
    const wroteOn = on;
    await duplicateEntry(userId, id);
    requestSync('food duplicated');
    await reloadDay(wroteOn);
  }

  /**
   * The drop half of a drag — N531's cross-meal move and N553's within-meal
   * reorder, as ONE handler, because they are one gesture.
   *
   * `slot` is the index the row should occupy in the destination meal WITHOUT
   * itself, which is what `slotFor` returns and what `plan`/`planInto` take.
   *
   * The arithmetic lives in `entryOrder.ts`, not here: a rule inside a screen
   * is a rule no test can reach, which is the same reasoning `nutrition.ts`
   * states about the macro totals this file used to compute inline.
   *
   * `plan` returns NO writes for a drop that changes nothing, and that guard
   * is load-bearing rather than tidy — a write marks the row dirty, and a
   * dirty row is one `entrySyncState` reports as `owed`, which disables
   * sharing with "Save your changes first".
   */
  const onDropMove = useCallback(
    (id: string, from: Meal, to: Meal, slot: number) => {
      if (!userId) return;
      const wroteOn = on;
      const rowsIn = (meal: Meal) => slots.find((sl) => sl.meal === meal)?.entries ?? [];
      const write =
        from === to
          ? // Same meal: a reorder. One row, unless the gap ran out.
            reorderEntries(userId, plan(rowsIn(to), id, slot).writes)
          : // Another meal: the row changes meal AND takes a position inside
            // it. `planInto` gives the moved row's own number plus, if the
            // destination had no room, that meal's rebalance — applied first,
            // so the number `moveEntry` writes is one that still fits.
            (() => {
              const p = planInto(rowsIn(to), id, slot);
              const mine = p.writes.find((w) => w.id === id);
              const others = p.writes.filter((w) => w.id !== id);
              return reorderEntries(userId, others).then(() =>
                moveEntry(userId, id, to, mine?.position),
              );
            })();
      write
        .then(() => {
          requestSync('food moved');
          return reloadDay(wroteOn);
        })
        .catch(() => {
          // The row is gone from this device (deleted from under the drag).
          // The re-read below shows the day as it is; nothing to say.
          return reloadDay(wroteOn);
        });
    },
    [userId, on, reloadDay, slots],
  );

  /**
   * N553 — move a row one place without a gesture: VoiceOver's answer to a
   * drag, wired to the grip's `accessibilityActions`.
   *
   * Goes through the same `plan` as the drag rather than swapping two
   * positions, so a nudge and a drag cannot disagree about what "one place up"
   * means, and so a nudge into an exhausted gap rebalances exactly as a drop
   * there would.
   */
  const onNudge = useCallback(
    (id: string, meal: Meal, delta: number) => {
      if (!userId) return;
      const wroteOn = on;
      const rows = slots.find((sl) => sl.meal === meal)?.entries ?? [];
      const at = rows.findIndex((e) => e.id === id);
      if (at === -1) return;
      // `plan` indexes into the list WITHOUT this row, so moving DOWN by one
      // is `at + 1` in that list, and moving up is `at - 1`. Clamped by `plan`
      // itself; an out-of-range nudge at either end is a no-op, which is the
      // right answer for "move the first row up".
      reorderEntries(userId, plan(rows, id, at + delta).writes)
        .then(() => {
          requestSync('food reordered');
          return reloadDay(wroteOn);
        })
        .catch(() => reloadDay(wroteOn));
    },
    [userId, on, reloadDay, slots],
  );

  const editingMeal = editState?.on === on ? editState.meal : null;
  const setEditingMeal = useCallback(
    (meal: Meal | null) => setEditState(meal === null ? null : { on, meal }),
    [on],
  );

  const drag = useEntryDrag({
    enabled: !!userId && combining === null,
    measure,
    onDrop: onDropMove,
  });
  // One object, memoised on the coordinator's STABLE callbacks plus the two
  // facts rows read — never rebuilt on every render, because `EntryRow`
  // memoises its `PanResponder` on these and a responder rebuilt mid-drag
  // loses its gesture state. See that file's own comment.
  const dragHandlers = useMemo<EntryDragHandlers>(
    () => ({
      enabled: !!userId && combining === null,
      activeId: drag.active?.id ?? null,
      onEnterEdit: setEditingMeal,
      onNudge,
      onStart: drag.start,
      onMove: drag.move,
      onEnd: drag.end,
      onCancel: drag.cancel,
    }),
    [
      userId,
      combining,
      drag.active?.id,
      drag.start,
      drag.move,
      drag.end,
      drag.cancel,
      onNudge,
      setEditingMeal,
    ],
  );

  // N531 — what the 3-dot menu does. Each closes the sheet first: the
  // action's own re-read is what the athlete should see next, not a sheet
  // still naming a row that has just changed.
  function closeMenu() {
    setMenu((m) => (m ? { ...m, open: false } : m));
  }
  function menuDuplicate() {
    const e = menu?.entry;
    closeMenu();
    if (e) void onDuplicate(e.id);
  }
  function menuRemove() {
    const e = menu?.entry;
    closeMenu();
    if (e) void onDelete(e.id);
  }
  function menuShare() {
    const e = menu?.entry;
    closeMenu();
    if (e) setShare({ id: e.id, open: true });
  }

  // N115 — combine-select. `toggleSelect` is shared across every `MealCard`
  // (only the one currently `combining` ever calls it, since the others do
  // not render selectable rows), so it lives here rather than four times over.
  function toggleSelect(id: string) {
    setCombining((cur) => {
      if (!cur) return cur;
      const next = new Set(cur.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...cur, selected: next };
    });
  }

  function confirmCombine() {
    if (!combining || combining.selected.size < 2) return;
    const { meal, selected } = combining;
    // Cleared BEFORE navigating, not after: `food/combine` pushes on top of
    // this (still-mounted) tab screen, so leaving `combining` set would have
    // the section still rendering checkboxes underneath when the athlete
    // comes back, over rows the combine screen may just have deleted.
    setCombining(null);
    router.push(`/food/combine?date=${on}&meal=${meal}&ids=${[...selected].join(',')}`);
  }

  // BELOW every hook in this component, and that placement is the rule rather
  // than a preference: an early return above one changes hook ORDER between
  // renders, which the typechecker cannot see and which shipped a black screen
  // on every BJJ session opened from Today. `react-hooks/rules-of-hooks` is an
  // error in this app for exactly that.
  //
  // `foodDisabled` carries the `modulesReady` half, so the first frames after a
  // cold start do not assert "turned off" from a module list that has not been
  // read yet — the same reason the tab bar holds a frame, and the same shape
  // `bjj/index` uses.
  if (foodDisabled) {
    return <ModuleOffNotice module={foodOff} action="log food" testID="food-disabled" />;
  }

  return (
    <RNView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: TAB_BAR_CLEARANCE + 40 }]}
        contentInsetAdjustmentBehavior="automatic"
        // N531 — locked for the length of a drag. On iOS a JS responder
        // cannot refuse the native scroll view (`SwipeToDelete`'s doc comment
        // measures this), so a lifted row dragged upward would scroll the
        // page under itself; disabling the scroll while a row is lifted is
        // the only thing that actually stops that. The long-press that lifts
        // it happens with the finger still, before any scroll has begun.
        scrollEnabled={drag.active === null}
      >
        {/* Inside the ScrollView, so it scrolls away with the content and
            nothing passes under it — no bottom rule. See `ScreenHeader`. */}
        {/* No header action any more. It used to hold a "Target" / "Set target"
            word linking to the same place `TargetRow` now links to — one entry
            point, not two, and the row states the NUMBER, which the word never
            did. N180's whole complaint was that the target was reachable and
            not readable. */}
        <ScreenHeader title="Food" contentScrollsUnder={false} />

        <RNView style={styles.body}>
          <PeriodSwitcher
            label={dayPillLabel(new Date(`${on}T12:00:00`), isToday)}
            onPrev={() => setDay(dayOffset - 1)}
            onNext={() => setDay(dayOffset + 1)}
            // N81/#415: this used to jump straight back to today and only when
            // NOT on today — the pill's only job was "undo my navigation".
            // That left the calendar icon promising something it didn't do
            // (`PeriodSwitcher`'s own doc comment: "the label, when it is
            // pressable, opens the calendar that jumps somewhere distant") and
            // left correcting a day three months back at up to ninety taps on
            // the arrows, which is the whole ticket. Always opens the month
            // grid now, matching `WeekPlanner`'s identical control — "back to
            // today" moved to that sheet's own Today button, one tap in.
            onPress={openMonth}
            icon="calendar"
            prevLabel="Previous day"
            nextLabel="Next day"
            pressLabel="Open the calendar to jump to another day."
            testID="food-day"
          />

          {/* **The target, at the head of the day.** N180: two taps from
              anywhere — Food tab, then this row — and the number is legible
              without the second one.

              BELOW the day stepper rather than above it, and that is deliberate
              rather than cosmetic. `view` is keyed to the day on screen, so on
              yesterday this row shows YESTERDAY'S target; sitting above the
              control that chose the day, it would read as "the" target and
              quietly be a different number from the one the athlete means. It
              is the same failure `budget` guards against a few lines down by
              suppressing itself on any day but today. Under the stepper, the
              row is unambiguously about the day named directly above it. */}
          <TargetRow
            view={view}
            onPress={() => router.push('/goals')}
            testID="food-target"
          />

          <RNView style={styles.summary}>
            {/* `showTarget={false}`: the row above has just said it, in bigger
                type and with somewhere to go. Two statements of one number
                within a thumb's width read as a bug in the number. */}
            <RemainingBlock
              eaten={eaten}
              view={view}
              showTarget={false}
              testID="food-remaining"
            />
          </RNView>

          {/* Water and anything else being tracked, for the day on screen.
              Above the meals because a tap is one gesture and a meal is a flow
              — and in both places because the ticket says both, so an athlete
              who lives in Food never has to go to Today for it. */}
          <TrackerList
            day={trackerDay}
            // The day these cards are showing — matches what `refreshTrackers(on)`
            // above was asked to load. See `TrackerList`'s own `on` doc comment
            // (W16/#704) for why this is a separate prop from `dayAtTap`.
            on={on}
            // The day being LOOKED AT, unlike Today's clock read: the stepper is
            // the point of this screen, so a tap while reading Tuesday belongs
            // to Tuesday.
            dayAtTap={() => on}
            units={units}
            unitsReady={unitsReady}
            // Same reasoning as Today's own `now` prop (N431): the cutoff
            // line is a claim about the current moment, so it only applies
            // while the day on screen is real today.
            now={isToday ? new Date() : null}
            // No `collapseAfter`. Today hides all but three because it is a
            // decision surface with a session, a readiness reading and a week on
            // it; Food is where trackers LIVE, and somebody who came here came
            // to look at them.
            testID="food-trackers"
          />

          {/* The way in to authoring — creating, editing, reordering, stopping.
              N78 puts it in FOOD because that is where the ticket puts it ("In
              Food, an athlete creates a tracker by naming...") and because it is
              the screen an athlete is on when they think "I should be tracking
              this too". Today deliberately gets no such control: it is a
              decision surface, not a settings screen. */}
          <PressableScale
            onPress={() => router.push('/trackers')}
            style={styles.manageTrackers}
            accessibilityRole="button"
            accessibilityLabel="Manage your trackers — add, reorder or stop one"
            testID="food-manage-trackers"
          >
            <Text style={styles.manageTrackersText}>Manage trackers</Text>
          </PressableScale>

          {/* The meal sections render ONLY on a real answer.
              Rendered while loading, or after a failed read, they are four
              headers with no rows and an Add button each — visually
              indistinguishable from a genuinely empty day, sitting under a
              banner saying the read failed. No number lies (subtotals are
              suppressed at 0, the headline is a dash), but the dominant surface
              of the screen still asserts "your meals are empty" from a read
              that never happened. That is the N28 failure in miniature and the
              same one this task exists to fix. Found in review. */}
          {eaten.state !== 'ready' ? (
            <Text style={styles.slotsAbsent} testID="food-slots-absent">
              {eaten.state === 'loading'
                ? 'Loading your meals…'
                : 'Your meals could not be read from this device.'}
            </Text>
          ) : (
            <RNView style={styles.cards}>
              {/* Above the meal list — the day's item count, total calories
                  and macro totals consumed so far, distinct from the
                  remaining-focused block above (`RemainingBlock` states what
                  is LEFT; this states what has been EATEN, plus how many
                  entries that came from — N28's honesty rule). */}
              <FoodSummaryCard eaten={eaten} testID="food-summary" />
              {slots.map((slot) => (
                <MealCard
                  // Keyed on the day too, not just the slot — same reason
                  // `TrackerList` keys its cards on `${t.id}-${on}`: a day
                  // switch remounts the card, so its own collapse state
                  // resets to that day's default instead of carrying over a
                  // manual toggle made on a different day.
                  key={`${slot.meal}-${on}`}
                  meal={slot.meal}
                  label={MEAL_LABELS[slot.meal]}
                  entries={slot.entries}
                  totals={slot.totals}
                  available={availableBySlot?.get(slot.meal) ?? null}
                  addColor={accent.ink}
                  onAdd={() => router.push(`/food/add?meal=${slot.meal}&date=${on}`)}
                  onEntryPress={(id) => router.push(`/food/entry/${id}`)}
                  onDelete={(id) => void onDelete(id)}
                  selecting={combining?.meal === slot.meal}
                  selectedIds={combining?.meal === slot.meal ? combining.selected : undefined}
                  onToggleSelect={toggleSelect}
                  // N115 review (ac-verifier, criterion 6): combining is
                  // destructive — it deletes the originals — and the combine
                  // screen's own copy promises same-day reversibility. That
                  // promise is only true today, so the affordance itself is
                  // gated the same way `food/entry/[id]`'s Split control
                  // already is, rather than offered on a past day and then
                  // contradicted a screen later.
                  onStartCombine={
                    isToday
                      ? () => {
                          // One mode at a time (N553): a card cannot be both
                          // reordering and selecting, and `MealCard` renders
                          // Done and Combine into the same slot in its header.
                          setEditingMeal(null);
                          setCombining({ meal: slot.meal, selected: new Set() });
                        }
                      : undefined
                  }
                  onCancelCombine={() => setCombining(null)}
                  onConfirmCombine={confirmCombine}
                  // N531 — the row menu and the drag.
                  onEntryMenu={(id) => {
                    const e = slot.entries.find((x) => x.id === id);
                    if (e) setMenu({ entry: e, open: true });
                  }}
                  drag={dragHandlers}
                  containerRef={(v) => {
                    cardRefs.current[slot.meal] = v;
                  }}
                  isDropTarget={drag.active !== null && drag.target === slot.meal}
                  // N553 — edit mode, and where a lifted row would land.
                  editing={editingMeal === slot.meal}
                  onDoneEditing={() => setEditingMeal(null)}
                  dropSlot={drag.target === slot.meal ? drag.slot : null}
                  rowRef={registerRow(slot.meal)}
                  testID={`food-meal-${slot.meal}`}
                />
              ))}
            </RNView>
          )}
        </RNView>
      </ScrollView>

      {/* N531 — the 3-dot menu. One sheet for the whole day, fed the row it
          was opened from; see `EntryMenuSheet` for why it is this shape. */}
      <EntryMenuSheet
        open={menu?.open ?? false}
        entryName={menu?.entry.name ?? ''}
        shareBlocked={menu && menuSync?.id === menu.entry.id ? menuSync.blocked : undefined}
        onDuplicate={menuDuplicate}
        onRemove={menuRemove}
        onShare={menuShare}
        onClose={closeMenu}
        testID="entry-menu"
      />
      {/* Keyed on the entry so each share starts with its own clean "Sent"
          ledger — the key is what makes `share.id` changing a remount rather
          than an edit. Mounted only once something has been shared at all. */}
      {share ? (
        <ShareSheet
          key={share.id}
          resourceType="nutrition_entry"
          resourceId={share.id}
          open={share.open}
          onClose={() => setShare((s) => (s ? { ...s, open: false } : s))}
        />
      ) : null}

      {/*
        The month grid, opened from the day switcher's label — N81/#415. The
        ±1-day arrows are the "check yesterday" gesture and stay exactly as
        they were; this is the other half, for a day the arrows would take
        ninety taps to reach. Same component and the same jump-target shape
        Plan already uses for its week switcher (`WeekPlanner`'s `monthOpen`
        sheet) — one grid convention in the app rather than two, and this
        screen's version differs only in what a tap on a cell means: a DAY,
        not a week.
      */}
      <Modal
        visible={monthOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setMonthOpen(false)}
      >
        {/* Gated on `monthOpen`, matching `WeekPlanner`: children are built by
            the parent before `Modal` ever sees them, so an ungated grid does
            ~42 `toLocaleDateString` calls on every render of a tab the athlete
            keeps open, whether the sheet is showing or not. */}
        {monthOpen && (
          <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
            <RNView style={styles.sheetHead}>
              {/* One tap back to today from wherever the grid has paged to —
                  `openMonth` opens on the day ON SCREEN's month, so from three
                  months out this is the only way back that isn't the sheet's
                  own Close button landing you on a day you didn't mean. */}
              <PressableScale
                onPress={() => {
                  setDay(0);
                  setMonthOpen(false);
                }}
                hitSlop={12}
                style={styles.sheetToday}
                accessibilityRole="button"
                accessibilityLabel="Today, back to this day"
                testID="food-month-today"
              >
                <Text style={styles.close}>Today</Text>
              </PressableScale>

              <RNView style={styles.sheetSwitcher}>
                <PeriodSwitcher
                  label={monthAnchor
                    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                    .toUpperCase()}
                  onPrev={() => stepMonth(-1)}
                  onNext={() => stepMonth(1)}
                  prevLabel="Previous month"
                  nextLabel="Next month"
                  testID="food-month"
                />
              </RNView>
              <PressableScale
                onPress={() => setMonthOpen(false)}
                hitSlop={12}
                style={styles.sheetClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                testID="food-month-close"
              >
                <Text style={styles.close}>Done</Text>
              </PressableScale>
            </RNView>

            <ScrollView contentContainerStyle={styles.sheetBody}>
              <Text style={styles.sheetHint}>Pick a day to correct.</Text>

              <RNView style={styles.gridHead}>
                {monthHeadDays.map((d) => (
                  <Text key={d.toISOString()} style={styles.gridHeadCell}>
                    {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
                  </Text>
                ))}
              </RNView>

              {monthGrid(monthAnchor).map((row) => (
                <RNView key={row[0].key} style={styles.gridRow}>
                  {row.map((cell) => {
                    const isToday = cell.key === todayKey;
                    const isShown = cell.key === on;
                    const logged = monthDays.has(cell.key);
                    // No day past today has anything to correct — the same
                    // bound web's own jump field holds with `max={now}` on
                    // `/dashboard/nutrition/days`. The ±1-day arrows are
                    // untouched by this and can still step forward; only this
                    // grid, which exists for CORRECTING a day, draws the line.
                    const future = offsetFromToday(cell.key) > 0;
                    return (
                      <PressableScale
                        key={cell.key}
                        disabled={future}
                        style={[styles.gridCell, isShown && styles.gridCellShown]}
                        onPress={() => {
                          setDay(offsetFromToday(cell.key));
                          setMonthOpen(false);
                        }}
                        accessibilityRole="button"
                        // The highlight is the only signal that this cell is
                        // the day behind the sheet, and a tint says nothing to
                        // a screen reader — the same gap `WeekPlanner`'s own
                        // grid closes with `selected` here.
                        accessibilityState={{ selected: isShown, disabled: future }}
                        accessibilityLabel={[
                          cell.date.toLocaleDateString(undefined, {
                            weekday: 'long',
                            day: 'numeric',
                            month: 'long',
                          }),
                          isToday ? 'today' : null,
                          logged ? 'logged' : null,
                          future ? "hasn't happened yet" : null,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                        testID={`food-month-day-${cell.key}`}
                      >
                        <Text
                          style={[
                            styles.gridDate,
                            !cell.inMonth && styles.gridSpill,
                            isToday && styles.gridToday,
                            future && styles.gridFuture,
                          ]}
                        >
                          {cell.date.getDate()}
                        </Text>
                        {/* Always rendered, so a dot appearing never shifts the
                            row's height as you page through months. */}
                        <RNView style={[styles.gridDot, logged && styles.gridDotOn]} />
                      </PressableScale>
                    );
                  })}
                </RNView>
              ))}
            </ScrollView>
          </View>
        )}
      </Modal>
    </RNView>
  );
}

/**
 * The signed day offset of a `YYYY-MM-DD` key from today, in whole days.
 *
 * Both sides parsed as UTC midnight and diffed there, matching `shortDate`'s
 * own rule for a stored day string: UTC has no DST, so this is exact where
 * local millisecond arithmetic would drift by an hour across a transition —
 * and a month-grid cell can be a whole DST boundary away from today.
 */
function offsetFromToday(key: string): number {
  const day = Date.parse(`${key}T00:00:00Z`);
  const today = Date.parse(`${dayString(new Date())}T00:00:00Z`);
  return Math.round((day - today) / 86_400_000);
}

const styles = StyleSheet.create({
  // A quiet row, not a button: authoring is the rare gesture here and logging
  // is the common one, so it must not compete with the cards above it.
  // 13 + 13 + ~18pt of text is 44 — the minimum this diff holds its other
  // controls to. At 12 it was ~42, which is the kind of near-miss the glyph
  // row's own note is about.
  manageTrackers: { paddingVertical: 13, alignItems: 'center' },
  manageTrackersText: { fontSize: 13, fontWeight: '700', color: vola.textMuted },
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { gap: 12 },
  body: { paddingHorizontal: 20, gap: 16 },
  summary: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  slotsAbsent: { fontSize: 13, color: vola.textMuted, marginTop: 18 },
  // One gap between the four `MealCard`s — the card itself owns everything
  // inside it now (N124/N113); this screen only stacks them.
  cards: { gap: 12 },

  // The month-jump sheet — N81/#415. Styling matches `WeekPlanner`'s own
  // month grid exactly (same tokens, same sizes) rather than a fresh set: one
  // grid convention in the app, not two that could quietly drift apart.
  sheet: { flex: 1 },
  sheetSwitcher: { flex: 1 },
  sheetToday: { minWidth: 52 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  sheetClose: { marginLeft: 'auto' },
  close: { fontSize: 14, fontWeight: '700', color: vola.lime },
  sheetBody: { padding: 14, gap: 2 },
  sheetHint: { fontSize: 12, color: vola.textDim, paddingBottom: 10 },

  gridHead: { flexDirection: 'row', paddingBottom: 6 },
  gridHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: vola.textDim,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
  },
  gridCellShown: { backgroundColor: vola.surface },
  gridDate: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  gridSpill: { color: vola.textDim, opacity: 0.5 },
  gridToday: { color: vola.lime, fontWeight: '800' },
  // A day that hasn't happened yet — nothing to correct there. Dimmer than a
  // spill day (0.35 vs 0.5) because a spill day is one tap from being the
  // shown month and this one is not reachable at all; the two must not read
  // the same.
  gridFuture: { color: vola.textDim, opacity: 0.35 },
  gridDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'transparent' },
  gridDotOn: { backgroundColor: vola.lime },
});
