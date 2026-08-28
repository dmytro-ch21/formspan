import { useAuth } from '@clerk/clerk-expo';
import { syncNow, useSyncState, request as requestSync } from '@/lib/sync';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View as RNView,
} from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';

import { Text, View } from '@/components/Themed';

import { Icon } from '@/components/ui/Icon';
import { PickSessionSheet } from '@/components/ui/PickSessionSheet';
import { PeriodSwitcher } from '@/components/ui/PeriodSwitcher';
import { SectionHeader } from '@/components/ui/Section';
import { WeekStrip } from '@/components/today/WeekStrip';
import { MomentumCard } from '@/components/today/MomentumCard';
import { UpNextCard } from '@/components/today/UpNextCard';
import { ProgressCard } from '@/components/today/ProgressCard';
import {
  LoggingCard,
  MiniCardRow,
  TrainingCard,
  TRAINING_WINDOW_DAYS,
} from '@/components/today/MiniCards';
import { parseRings, type RingKey, DEFAULT_RINGS } from '@/lib/macroRings';
import { TrackerList } from '@/components/TrackerList';
import { vola } from '@/constants/Colors';
import { addDays, dayString, weekDays } from '@/lib/calendar';
import { fetchThemes, type Theme } from '@/lib/themes';
import { formatElapsed } from '@/lib/rest';
import type { Session } from '@/lib/sessions';
import { trainingSince } from '@/lib/sessionStore';
import { listWorkingCurricula, type Curriculum } from '@/lib/curriculum';
import { classFocus, classHintText, type ClassFocus } from '@/lib/classFocus';
import { fetchProficiency } from '@/lib/proficiency';
import {
  funnelGap,
  parseDismissed,
  parseIdSet,
  parseMaster,
  serialiseDismissed,
  shouldOfferDetail,
  suggestionsAllowed,
} from '@/lib/suggestion';
import {
  PREF_DETAIL_OFFERS,
  PREF_DISMISSED_SUGGESTIONS,
  PREF_MACRO_RINGS,
  PREF_SUGGESTIONS,
  PREF_SUGGESTIONS_OFF,
  readPref,
  writePref,
} from '@/lib/prefs';
import { restLine } from '@/lib/trend';
import { enabledSports, labelFor, logsAfterwards, type Module } from '@/lib/modules';
import { sessionHref, startSessionHref } from '@/lib/startSession';
import type { PlannedOffer, Source } from '@/lib/trainBoard';
import {
  momentumDayKey,
  momentumLogFoodHref,
  momentumOpenFoodHref,
  trackerTapDay,
  type TodayLead,
} from '@/lib/todayBoard';
import { useTodayBoard } from '@/lib/useTodayBoard';
import { useModules } from '@/lib/ModulesProvider';
import { useAccent } from '@/lib/AccentProvider';
import { shiftDate } from '@/lib/anthropometry';
import { listCheckins, listPhases, type Checkin, type Phase } from '@/lib/body';
import {
  cacheTargets,
  localEntries,
  localLoggedDays,
  localTargetView,
  logFood,
  recentsFor,
} from '@/lib/foodLog';
import { hasFoodLog, moduleOffWithFoodLog } from '@/lib/modules';
import {
  rankRecents,
  scale,
  slotForClock,
  type Entry,
  type Food,
  type TargetView,
  eatenFrom,
  type EatenView,
  type LoggedDaysView,
} from '@/lib/nutrition';
import { listTargets, targetOn } from '@/lib/nutritionApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { useTrackerDay } from '@/lib/useTrackerDay';
import { useUnits } from '@/lib/useUnits';
import { countsAsSet } from '@/lib/sessions';

/**
 * Room under the scroll so the floating New Log never covers the last row.
 *
 * Scales with the text size, not fixed: the pill grows with its label, and at
 * the largest accessibility sizes a fixed clearance leaves it sitting on top of
 * the content it was moved off. Same function and same reasoning as the
 * workouts tab's — see `fabClearance` there, which this is deliberately a copy
 * of rather than an import, because the two screens' pills are allowed to
 * diverge and a shared constant would hide it when they did.
 */
function fabClearance(fontScale: number): number {
  return 44 + 20 * fontScale;
}

/**
 * Completed, non-warm-up sets — the backend's own working-volume rule.
 *
 * The `completed` half was missed when progressive volume landed, so this row
 * said "5 working sets" and the session it linked to said "Sets 0". Two screens
 * disagreeing about the same session is worse than either number alone.
 */
function workingSets(s: Session): number {
  // `countsAsSet`, not `contributesVolume` — a drop is part of the set above
  // it, so it does not add to the number the athlete counts.
  return s.sets.filter(countsAsSet).length;
}

/** e.g. "Thursday, 31 July" — orientation, not decoration. */
function todayLabel(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Today — what am I doing right now, or next.
 *
 * ## Six blocks, in one fixed order (N179)
 *
 * 1. **NOW / NEXT** — the running session, or what today asks for. The screen's
 *    single primary; nothing else on it is a filled control.
 * 2. **LATER** — the next planned day after today, read-only.
 * 3. **DAILY PROGRESS** — fuel, trackers, the check-in. The things that are
 *    *asked for* today.
 * 4. **THIS WEEK** — the week strip and two compact counts. Context, not
 *    analysis.
 * 5. **INSIGHT** — at most one interpretation, and only when evidence exists.
 * 6. **CURRENT FOCUS** — the week's theme, if one is set.
 *
 * **N107 took the roadmap out of block 6.** It used to hold either the offer
 * to start one or a progress line for one already underway; both are gone —
 * the offer moved to Goals, and the progress line is not replaced here at
 * all, because You's `RoadmapSummary` already says it and this block saying
 * it too was the "three surfaces" review flagged. Today keeps only the #447
 * hint inside a scheduled BJJ session's card in block 1 — evidence about a
 * session on the calendar, not a standing readout.
 *
 * The order is the hierarchy: it descends from *act now* through *is asked of
 * you* to *is true about you*. It does not reorder itself — the CONTENT of a
 * block changes with the day, the sequence does not, because a screen whose
 * blocks move is one you have to read rather than glance at.
 *
 * ## What left, and where it went
 *
 * Today had grown into a dashboard: a month calendar, a full week review, an
 * eight-week bar chart and a recent-sessions list, all below the fold, none of
 * them answering *what do I do now*. All four left, and every one of them is
 * still reachable:
 *
 * - **`WeekReview`** → Progress, which renders the same component inside
 *   `components/progress/ThisWeek.tsx` (N178).
 * - **`TrendStrip`** → Progress, whose `TrainingSummary` already draws a bar
 *   per week over a selectable span. Drawing a second one would be the W2/W4
 *   shape; see `components/progress/TrainingHistory.tsx`.
 * - **`TrainingCalendar`** → Progress, through that component — the one of the
 *   three that had no equivalent there, and the last surface on the phone that
 *   opens a past session by date.
 * - **Recent sessions** → Train renders them from the same read, and the
 *   calendar above reaches them by date. A second copy on Today is the
 *   divergence this epic exists to remove.
 *
 * The **day stepper** went too, and that is the one removal that is a product
 * decision rather than a relocation. Today answered *what is on Thursday* with
 * a pair of arrows that quietly re-dated the whole top of the screen — past
 * mode, "Not logged" labels, a suggestion suppressed. Plan owns future intent
 * and already browses any day, any week, any month (`WeekPlanner`), so nothing
 * is unreachable; what is gone is a second, weaker planner sitting on top of
 * the screen an athlete opens to find out what to do in the next ten minutes.
 *
 * ## Nothing here claims an absence it has not checked
 *
 * Every read that can be absent is a {@link Source} — `unread`, `unavailable`,
 * `ready` — through `lib/useTodayBoard.ts` and `lib/todayBoard.ts`. Before
 * N179 this screen held `[]` and swallowed its read errors, so it asserted
 * **"Nothing planned"** on the first frame of every cold open and kept
 * asserting it when the read failed. A rest day and a broken disk produced the
 * identical screen, which is why the ticket's *"a rest day renders a real
 * state"* could not be satisfied without fixing it first.
 */
export default function TodayScreen() {
  const accent = useAccent();
  const { modules } = useModules();
  // is_sport filtered, not just enabled: nutrition is a module you can turn
  // on, but "Start a nutrition session" is nonsense — there is no catalog,
  // no session and no row behind it.
  const startable = enabledSports(modules);
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();
  const { units, unitsReady } = useUnits();

  // From the orchestrator, not a local copy. This screen used to `await` the
  // sync and then re-count — so the number was fresh. Now that the sync is
  // fire-and-forget (the orchestrator decides), a local copy would show
  // "N waiting to sync" straight through the successful sync this very focus
  // triggered, and keep showing it until the next focus.
  const { pending: pendingSessions, deferred } = useSyncState();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [picking, setPicking] = useState(false);

  /**
   * How many days from real `now` the switcher has stepped. 0 is today.
   *
   * **Restored on direct user instruction, after this ticket had removed it.**
   * The first pass read "Today is an orchestration layer" as meaning day
   * browsing belongs on Plan alone (`WeekPlanner` already browses any day,
   * week or month) and dropped the control entirely. The user's own words —
   * "we can go to before dates or future ones" — are continuous navigation
   * FROM Today, which a redirect to another tab does not satisfy, so it is
   * back. `ac-verifier` had already marked "existing route behavior remains
   * stable" MET on the grounds that Plan owns day-browsing; that verdict no
   * longer describes what ships, and the PR says so.
   *
   * An OFFSET, not a `Date`, for the same reason `dayOffset` was one before:
   * held as a date it would be anchored at mount and refreshed by nothing,
   * while `now` re-reads on focus and on `AppState` — so leaving the app on
   * this tab overnight and reopening it would move `now` to the new day while
   * a captured date stayed on the old one.
   */
  const [dayOffset, setDayOffset] = useState(0);
  const viewDay = useMemo(() => addDays(now, dayOffset), [now, dayOffset]);
  const isToday = dayOffset === 0;
  const isPast = dayOffset < 0;
  /** "TODAY" when it is; the weekday and date otherwise. */
  const dayLabel = isToday
    ? 'TODAY'
    : viewDay
        .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
        .toUpperCase();

  /**
   * The plan, the session list and the workout cache — one read each, three
   * states each, and the ordering rule they feed.
   *
   * See `lib/useTodayBoard.ts` for what this replaced. The short version: two
   * plain arrays, two overlapping queries and a sequence guard, none of which
   * could tell an empty answer from an unread one.
   */
  const {
    board,
    sessions,
    refresh: refreshBoard,
  } = useTodayBoard(userId ?? null, modules, now, viewDay);

  // Moved up from beside its other render-time uses so Momentum's own food
  // read (below) can see `resume` — a running session means "right now",
  // full stop, regardless of what the day switcher was left showing.
  const lead = board.lead;
  const resume = lead.state === 'ready' && lead.value.kind === 'resume' ? lead.value.offer : null;

  /**
   * The technique funnel, for the suggestion below it.
   *
   * Network-only and best-effort: a suggestion is an offer, so a failed read
   * means no card, never a banner. `null` is "not read yet" and `[]` is "read,
   * nothing there" — the Tier 0 prompt turns on the difference, and collapsing
   * them would flash "log more detail" at an athlete who has plenty while the
   * request is still in flight.
   */
  const [funnel, setFunnel] = useState<Awaited<ReturnType<typeof fetchProficiency>> | null>(null);
  /**
   * How many times the Tier 0 offer has been shown, ever. `null` until read.
   *
   * Persisted rather than derived from a session count: `sessions` here is the
   * most recent ~30 local rows, so a reinstall or a strength-heavy stretch put
   * the old `bjjSessions <= 4` bound back inside its band and the prompt
   * returned indefinitely — the exact thing the bound exists to stop.
   */
  const [offers, setOffers] = useState<number | null>(null);
  /**
   * Techniques the athlete has said no to. `null` until read.
   *
   * Null matters for the same reason it does on `funnel`: rendering before the
   * dismissals land would show a card the athlete has already dismissed, which
   * is worse than showing nothing for a beat.
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  /**
   * Whether suggestions are allowed at all, and for which disciplines.
   *
   * `null` until read, like the two above, and for the same reason: showing a
   * card to someone who has switched suggestions off — even for one frame — is
   * the setting not working.
   */
  const [policy, setPolicy] = useState<{ master: boolean; off: ReadonlySet<string> } | null>(null);
  /**
   * The roadmaps being worked. `null` until read, like the rest — rendering an
   * empty roadmap block for a beat is a claim that they are on none.
   */
  const [roadmaps, setRoadmaps] = useState<Curriculum[] | null>(null);

  const refreshRoadmaps = useCallback(async () => {
    if (!userId) return;
    try {
      setRoadmaps(await listWorkingCurricula(getToken));
    } catch {
      // Silent and deliberately NOT setRoadmaps([]) — the same distinction
      // refreshFunnel makes below. An unreadable answer is not "you are on no
      // roadmap", and rendering that would quietly retract something the
      // athlete committed to.
    }
  }, [getToken, userId]);

  const refreshFunnel = useCallback(async () => {
    if (!userId) return;
    try {
      setFunnel(await fetchProficiency(getToken));
    } catch {
      // Deliberately silent, and deliberately NOT setFunnel([]) — an offline
      // read must not be mistaken for "this athlete has logged no detail",
      // which is what turns the Tier 0 prompt on.
    }
  }, [getToken, userId]);

  /**
   * Re-read on FOCUS, not once per mount.
   *
   * `/settings/suggestions` is a Stack route pushed over the tabs, and a tab
   * screen stays mounted for the life of the process — so keyed on `[userId]`
   * this ran once, ever. Turning suggestions off, silencing a discipline, or
   * tapping "Suggest again" all appeared to do nothing until the app was
   * killed. The write direction worked, which is exactly why testing it by
   * hand missed this: Settings is pushed fresh every time and reads correctly.
   */
  const readSuggestionPrefs = useCallback(() => {
    if (!userId) return () => {};
    let alive = true;
    readPref(userId, PREF_DETAIL_OFFERS)
      .then((v) => {
        if (alive) setOffers(Number(v ?? 0) || 0);
      })
      .catch(() => {});
    Promise.all([readPref(userId, PREF_SUGGESTIONS), readPref(userId, PREF_SUGGESTIONS_OFF)])
      .then(([m, o]) => {
        if (alive) setPolicy({ master: parseMaster(m), off: parseIdSet(o) });
      })
      // Defaults are on, which is what an unreadable preference has to mean —
      // the alternative is a feature that silently disables itself.
      .catch(() => {
        if (alive) setPolicy({ master: true, off: new Set() });
      });
    readPref(userId, PREF_DISMISSED_SUGGESTIONS)
      .then((v) => {
        if (alive) setDismissed(parseDismissed(v));
      })
      .catch(() => {
        // Empty rather than left null, which is the OPPOSITE of `refreshFunnel`
        // beside it — and deliberately. A null dismissal set would hide every
        // suggestion until a successful read; an empty one re-offers something
        // the athlete said no to. Both are wrong, and the second is now
        // recoverable in one tap from Settings while the first looks like the
        // feature is broken.
        if (alive) setDismissed(new Set());
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  /**
   * Start what was planned.
   *
   * The branch itself lives in `lib/startSession.ts` — Train makes the same
   * decision, and two copies of it is how a technique-shaped discipline ends up
   * in the set logger on one surface and not the other. It keys on the CATALOG
   * KIND (`logsAfterwards`), never on `key === 'bjj'`, so a second
   * technique-shaped discipline gets the right screen without this file
   * learning its name.
   */
  const startPlanned = useCallback(
    (p: { sport: string; workoutId: string | null }) => {
      router.push(startSessionHref(p, modules));
    },
    [modules, router],
  );

  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [checkinsLoaded, setCheckinsLoaded] = useState(false);

  // Fuel. Read locally first, exactly like the day screen: the card must be
  // right with no signal, because the log it reports is written offline.
  //
  // **Keyed to the day it was read for, the same shape `app/(tabs)/food.tsx`
  // uses for its own stepper.** Momentum used to always read real "today",
  // deliberately — this ticket (N179/#584 follow-up) reverses that on direct
  // user instruction: *"no matter where we switch the Todays momentum with
  // cals and stuff shows todays stats we need to show real things"*. Without
  // the key, stepping the day would leave the PREVIOUS day's figures on
  // screen under the new date until the read resolves — the same stale-day
  // flash `food.tsx`'s own `loaded`/`dated` comments describe, and the reason
  // this is a keyed pair rather than two plain `useState`s.
  const [loadedFood, setLoadedFood] = useState<{ on: string; eaten: EatenView }>({
    on: '',
    eaten: { state: 'loading' },
  });
  const [datedFoodView, setDatedFoodView] = useState<{ on: string; view: TargetView }>({
    on: '',
    view: { state: 'checking' },
  });
  const [foodQuick, setFoodQuick] = useState<Food[]>([]);

  /**
   * The week's logged FOOD days, as day keys.
   *
   * WHICH days, not how many. A count cannot be turned back into a set, and
   * both the week strip and the `LOGGING` dots need the individual days.
   *
   * `null` until read — never an empty set, which would draw seven empty dots
   * as though the week were known and blank.
   */
  const [foodDays, setFoodDays] = useState<LoggedDaysView>({ state: 'checking' });

  /** Sessions and distinct days over the trailing 28. `null` until counted. */
  const [training, setTraining] = useState<{ sessions: number; days: number } | null>(null);

  /** Which macros the rings draw. `null` until the preference is read. */
  const [rings, setRings] = useState<readonly RingKey[] | null>(null);
  const foodEnabled = hasFoodLog(modules);
  // The module that WOULD carry the Fuel card, turned off. See the card's
  // render below — N61.
  const foodOff = moduleOffWithFoodLog(modules);

  /**
   * What the week strip's marks and the `LOGGING` card are allowed to claim.
   *
   * **Gated on the food module, like the Fuel card has always been.** Both
   * render food-log data, and without this a deployment with no food log got a
   * strip of empty marks and a card reading "0 of N days logged" forever —
   * about a feature it does not have — with a press target pointing at a tab
   * `tabHidden()` removes from the bar.
   */
  const loggedView: LoggedDaysView = foodEnabled ? foodDays : { state: 'off' };

  /**
   * The daily trackers, and the day they describe.
   *
   * `todayKey` is recomputed on every render rather than held in state: this
   * screen stays mounted for the life of the process, so a value captured once
   * would still say yesterday after midnight — and a cup tapped at 00:05 would
   * land on the day that just ended. `dayString`, never
   * `toISOString().slice(0,10)`, which is the UTC date and files an evening tap
   * under tomorrow west of Greenwich.
   */
  const trackerDay = useTrackerDay();
  const { refresh: refreshTrackers } = trackerDay;
  const todayKey = dayString(new Date());

  /**
   * The browsed day, as a day key — what Momentum now follows. See
   * `loadedFood`/`datedFoodView` above.
   *
   * **Real today whenever a session is resuming, regardless of `viewDay`.**
   * The switcher is hidden during `resume` (see the render below), so there
   * is no way to see or correct a leftover `dayOffset` from a previous
   * browse — and this screen stays mounted for the process's life, so that
   * leftover can genuinely still be sitting there. "The resume card leads,
   * full stop" already means nothing else on the screen describes a browsed
   * day while a session is running; Momentum falling back to `now` here is
   * what makes that true for it too, rather than silently showing whatever
   * day the switcher was last left on.
   *
   * The branch itself is {@link momentumDayKey} (`lib/todayBoard.ts`), pulled
   * out as a pure function specifically so it has its own test — this exact
   * one-line decision shipped with no test able to catch its deletion,
   * because reproducing "browsed away, then a session starts" through the
   * full rendered screen needs the plan window to widen before the resume
   * state changes, an awkward sequence to orchestrate and an easy one to get
   * subtly wrong.
   */
  const on = momentumDayKey(resume !== null, viewDay, todayKey);

  /**
   * Entries and target for the day the switcher is showing.
   *
   * Split out from the week/quick-add read below (`refreshFoodWeek`)
   * specifically so stepping the day — which changes `on` and therefore this
   * callback's identity — refetches only this, not checkins/summary/roadmaps
   * as well. Those are real-today reads with nothing to do with browsing.
   */
  const refreshFoodDay = useCallback(() => {
    let live = true;

    (userId ? localEntries(userId, on) : Promise.resolve<Entry[]>([]))
      .then((rows) => {
        if (live) setLoadedFood({ on, eaten: eatenFrom(rows) });
      })
      .catch(() => {
        // Was `.catch(() => {})`, which left the list empty and rendered a
        // failed read as "nothing logged" — a claim the athlete ate nothing.
        // See `EatenView`.
        if (live) setLoadedFood({ on, eaten: { state: 'unavailable' } });
      });

    // The one thing the phone cannot compute. Cache first, server second — and
    // a failed fetch leaves the cached answer standing rather than falling back
    // to "set a target", which would be a false claim about an athlete who set
    // one on web. See TargetView.
    // Sequenced rather than raced, same as the day screen: started in parallel
    // a slow cache read can land after a fast network answer and overwrite it.
    let answered = false;
    (userId ? localTargetView(userId, on) : Promise.resolve<TargetView>({ state: 'unknown' }))
      .catch((): TargetView => ({ state: 'unknown' }))
      .then((v) => {
        if (live && !answered) setDatedFoodView({ on, view: v });
        return listTargets(getToken, { from: on, to: on });
      })
      .then(async (ts) => {
        if (userId) await cacheTargets(userId, on, on, ts);
        if (!live) return;
        answered = true;
        const t = targetOn(ts, on);
        setDatedFoodView({ on, view: t ? { state: 'set', target: t } : { state: 'none' } });
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [getToken, userId, on]);

  // Derived, not stored directly — the same guard `food.tsx` uses. A read
  // answering for a day that is no longer on screen must not paint over the
  // day the athlete has since stepped to.
  const foodEaten: EatenView = loadedFood.on === on ? loadedFood.eaten : { state: 'loading' };
  const foodView: TargetView = datedFoodView.on === on ? datedFoodView.view : { state: 'checking' };

  /**
   * The week's logged-day count and the quick-add RANKING — still always
   * real TODAY's, and that half of this comment is unchanged: which foods
   * rank as "recent" depends on the CURRENT time-of-day slot
   * (`slotForClock(new Date())` below), and the week strip counts a real
   * calendar week — neither describes the day Momentum happens to be
   * showing, so neither should follow it.
   *
   * **What is no longer true here: "logging stays pinned to real today."**
   * That was this comment's own claim until N430/#692 (2026-08-28) reversed
   * it, on direct user report, past midnight, mid-catch-up: *"we have today
   * already past 12am but I need to catch up with logs and I can't????"* —
   * an athlete who stepped Today back to yesterday found `Log food`, the
   * quick-add chips and the day link all silently filing under real today
   * regardless of what the screen showed, with no way to log the day they
   * were actually looking at.
   *
   * The old reasoning — "the safer default is a tap here always logs to
   * today... avoiding a 'viewing Tuesday, tap Log Food, it silently logs to
   * today' surprise" — traded a surprise an athlete could immediately see
   * and correct for an inability to log a past day AT ALL, which is strictly
   * worse. See `quickLog` below, which now writes to the VIEWED day (`on`),
   * matching `TrackerList`'s own rule on Food ("a tap while reading Tuesday
   * belongs to Tuesday", `food.tsx:390-393`).
   */
  const refreshFoodWeek = useCallback(() => {
    let live = true;
    const today = dayString(new Date());
    const slot = slotForClock(new Date());

    // The week's logged-day count. Its own read, because it spans seven days
    // and the entries read above is one — and a failure here leaves the count
    // absent rather than zero, for the same reason.
    // `null` for the signed-out branch, NOT an empty list. An empty list is a
    // query that never ran rendering as "nothing logged" — the confident zero
    // this whole file refuses, and a discouraging one.
    const week = weekDays(new Date());
    const spanFrom = dayString(
      new Date(Math.min(week[0].getTime(), addDays(new Date(), -6).getTime())),
    );
    const spanTo = dayString(week[6]) > today ? dayString(week[6]) : today;
    (userId ? localLoggedDays(userId, spanFrom, spanTo) : Promise.resolve<string[] | null>(null))
      .then((days) => {
        if (!live) return;
        setFoodDays(days === null ? { state: 'checking' } : { state: 'ready', days: new Set(days) });
      })
      .catch(() => {
        // A failed read is NOT an empty week. See `LoggedDaysView`.
        if (live) setFoodDays({ state: 'unavailable' });
      });

    // Ranked for the CURRENT slot, so the chips are porridge at breakfast and
    // something else at dinner.
    (userId ? recentsFor(userId, slot) : Promise.resolve([]))
      .then((rs) => {
        if (live) setFoodQuick(rankRecents(rs, today));
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [userId]);

  /**
   * The trailing-28-day training count, and which rings to draw.
   *
   * Counted in SQLite rather than derived from `sessions`, which is capped at
   * the 30 most recent ROWS — see `trainingSince`. Both reads fail to `null`
   * rather than to a zero, because "we have not counted yet" and "you did
   * nothing" are different sentences and only one of them is discouraging.
   */
  const refreshSummary = useCallback(() => {
    let live = true;

    const since = new Date();
    since.setDate(since.getDate() - TRAINING_WINDOW_DAYS);
    (userId ? trainingSince(userId, since.toISOString()) : Promise.resolve(null))
      .then((t) => {
        if (live) setTraining(t);
      })
      .catch(() => {
        if (live) setTraining(null);
      });

    (userId ? readPref(userId, PREF_MACRO_RINGS) : Promise.resolve<string | null>(null))
      .then((raw) => {
        if (live) setRings(parseRings(raw));
      })
      // A preference that cannot be read is a preference nobody set.
      .catch(() => {
        if (live) setRings(DEFAULT_RINGS);
      });

    return () => {
      live = false;
    };
  }, [userId]);

  /**
   * The last `refreshFoodDay` this screen itself triggered (from `quickLog`),
   * so a second quick-add before the first read resolves can cancel it.
   *
   * Without this, two rapid taps race: the second write is the freshest, but
   * nothing stops the FIRST read — started before it — from resolving after
   * the second one's and overwriting it with stale figures. Both fetches are
   * keyed to the same `on`, so the `on`-match guard on `foodEaten`/`foodView`
   * cannot tell them apart; only cancelling the earlier one can.
   */
  const foodDayCancelRef = useRef<() => void>(() => {});

  /**
   * One tap from the card: log a serving of a ranked food, to the day
   * Momentum is showing.
   *
   * **Writes to `on`, not real today unconditionally.** `on` already folds
   * in the resume fallback (`momentumDayKey`, above) — a running session
   * still logs to real today regardless of a leftover `dayOffset` — so this
   * needed no separate branch of its own to preserve that. What changed is
   * everything else: this used to hardcode `dayString(new Date())` here,
   * which is the N430/#692 bug itself, not a safeguard against it — see the
   * reversal recorded on `refreshFoodWeek` above.
   *
   * `refreshFoodDay` now always re-runs after the write, unconditionally.
   * The old `isToday || resume` gate existed because the day written and the
   * day shown could differ; they cannot any more — the write targets `on`
   * and the card reads `on` — so re-fetching it is never wasted and never a
   * surprise repaint onto a day the athlete did not ask to see.
   */
  const quickLog = useCallback(
    async (food: Food) => {
      if (!userId) return;
      await logFood(userId, {
        eaten_on: on,
        meal: slotForClock(new Date()),
        name: food.name,
        servings: 1,
        serving_label: food.serving_label,
        ...scale(food, 1),
        source_food_id: food.id,
      });
      requestSync('food logged');
      refreshFoodWeek();
      // Cancel any still-in-flight read this same source started, so a slow
      // first tap cannot resolve after a fast second one and paint over it.
      foodDayCancelRef.current();
      foodDayCancelRef.current = refreshFoodDay();
    },
    [userId, on, refreshFoodWeek, refreshFoodDay],
  );

  /**
   * Refreshed on FOCUS, not once on mount.
   *
   * This is a tab screen and stays mounted for the life of the process, so a
   * mount-only fetch meant the card still said "Check in" with yesterday's
   * trend after you had just weighed in and come back — and stayed that way
   * until the app was killed. That is the feature's primary daily loop.
   */
  const refreshCheckins = useCallback(() => {
    let live = true;
    // `dayString`, NOT `toISOString().slice(0,10)` — that is the UTC date, so
    // west of Greenwich an evening weigh-in lands on tomorrow's row.
    const today = dayString(new Date());
    Promise.all([
      listCheckins(getToken, { from: shiftDate(today, -30), to: today }),
      listPhases(getToken),
    ])
      .then(([cs, ps]) => {
        if (!live) return;
        setCheckins(cs);
        setPhase(ps.find((p) => p.ended_on === null) ?? null);
      })
      .catch(() => {
        // Offline, or the endpoint is not deployed yet. `loaded` stays false so
        // the card says it could not refresh rather than asserting you have
        // never weighed in — two different sentences.
      })
      .finally(() => {
        if (live) setCheckinsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [getToken]);

  // The clock, on its own effect with NO dependencies.
  //
  // It used to sit at the top of the refresh effect below, whose dependency
  // list is eight callbacks long — so any one of them changing identity
  // re-dated the screen, and `setNow(new Date())` is a state change on every
  // call. In the app that is invisible (a focus is a focus), but it makes the
  // screen's re-render behaviour depend on the stability of eight unrelated
  // closures, which is not a property anybody is maintaining. Split, it cannot.
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      refreshCheckins();
      // Its cleanup is KEPT, unlike its neighbours'. Food is the one refresh on
      // this screen with a same-screen writer racing it — `quickLog` refreshes
      // again immediately after logging — so a slow read started at focus could
      // otherwise resolve last and paint over the row just added.
      const stopFood = refreshFoodWeek();
      const stopSummary = refreshSummary();
      refreshFunnel();
      // On focus, not on mount: enrolling happens on a screen pushed over these
      // tabs, and Today stays mounted for the life of the process.
      refreshRoadmaps();
      // Settings can have changed any of these while this screen sat mounted.
      const stop = readSuggestionPrefs();
      return () => {
        stopFood?.();
        stopSummary?.();
        stop?.();
      };
    }, [
      refreshFunnel,
      refreshRoadmaps,
      readSuggestionPrefs,
      refreshCheckins,
      refreshFoodWeek,
      refreshSummary,
    ]),
  );

  /**
   * Momentum's own read, and the trackers beside it — kept OUT of the bundle
   * above on purpose.
   *
   * `refreshFoodDay` depends on `on` (the browsed day), so stepping the
   * switcher changes its identity and — since the screen is already
   * focused — re-runs this effect immediately, the same way `food.tsx`'s day
   * stepper re-triggers its own `refresh`. Folding it into the combined focus
   * effect above would mean every day-step also re-runs checkins, the
   * training summary, the funnel and the roadmap read: none of those describe
   * the browsed day, so none of them need to answer again just because the
   * switcher moved.
   *
   * **Trackers joined this effect for N430/#692.** They used to read
   * `todayKey` unconditionally in the bundle above — real today, regardless
   * of what Momentum was showing — which is the same shape of bug `quickLog`
   * had: a browsed day's water/coffee counts never showed, and a `+` always
   * filed under today. `on` already carries the resume fallback
   * (`momentumDayKey`, above), so this one read is right for both the plain
   * browse and the session-resumed case with no extra branching needed here.
   */
  useFocusEffect(
    useCallback(() => {
      const stopFood = refreshFoodDay();
      const stopTrackers = refreshTrackers(on);
      return () => {
        stopFood?.();
        stopTrackers?.();
      };
    }, [refreshFoodDay, refreshTrackers, on]),
  );

  // The same staleness arrives without a focus change when the app is
  // foregrounded on the tab it was left on — which is the common case for an
  // app you open to check what you did yesterday. The board's own reads follow
  // `now`; this is only the clock.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => sub.remove();
  }, []);

  const { fontScale } = useWindowDimensions();
  const fabPad = fabClearance(fontScale);

  /**
   * The one suggestion, and the offer that precedes it.
   *
   * `funnel === null` means the read has not landed, which is neither of the
   * two states below.
   *
   * BJJ is the only discipline with a suggestion tier today, so the gate asks
   * about BJJ. When a second tier lands this becomes per-suggestion rather than
   * one call — the policy function already takes the sport for that reason
   * rather than answering a global yes/no.
   */
  const suggestionsOn = policy !== null && suggestionsAllowed(policy.master, policy.off, 'bjj');

  const suggestion = useMemo(
    () => (suggestionsOn && funnel && dismissed ? funnelGap(funnel, now, dismissed) : null),
    [suggestionsOn, funnel, now, dismissed],
  );

  /**
   * #447 — the focus/suggestion line a scheduled BJJ class card shows beneath
   * its Log button. See `lib/classFocus.ts` for the selection rule.
   *
   * `roadmaps === null` (not yet read) falls through to `null` here exactly
   * like every other roadmap-dependent read on this screen — a beat of "no
   * hint" reads as a plain class card, never as a false "no roadmap active".
   *
   * Evidence (the funnel + dismissals) is withheld, not just the suggestion
   * result, when suggestions are off or either has not loaded — `classFocus`
   * then still returns the FOCUS line (a fact the athlete committed to, not a
   * suggestion) with an empty suggestion list, matching `RoadmapLine`'s own
   * refusal to gate milestone reporting on the suggestions toggle.
   */
  const classFocusValue = useMemo(() => {
    if (!roadmaps) return null;
    const evidence = suggestionsOn && funnel && dismissed ? { funnel, dismissed } : null;
    return classFocus(roadmaps, evidence, now);
  }, [roadmaps, suggestionsOn, funnel, dismissed, now]);

  /**
   * Say no to one technique, permanently.
   *
   * The SUGGESTION is recomputed every read and the DISMISSAL is stored, which
   * is the split `lib/adherence.ts` argues for: a stored suggestion goes stale
   * against the evidence behind it, but a stored "no" is a fact about the
   * athlete and does not. Deleting the sessions still withdraws the claim; it
   * simply never gets made again for this technique.
   *
   * Optimistic. The next-best suggestion appears immediately rather than after
   * a round trip to local storage, and a failed write costs one returning card
   * rather than a screen that ignored a tap.
   */
  const dismiss = useCallback(
    (techniqueId: string) => {
      if (!userId || !dismissed) return;
      const next = new Set(dismissed).add(techniqueId);
      setDismissed(next);
      writePref(
        userId,
        PREF_DISMISSED_SUGGESTIONS,
        serialiseDismissed(dismissed, techniqueId),
      ).catch(() => {});
    },
    [userId, dismissed],
  );

  const offerDetail = useMemo(() => {
    // The Tier 0 offer is a suggestion too — switching suggestions off must
    // silence the thing that asks for more evidence to make them, or "off"
    // only means "off once it has something to say".
    if (!suggestionsOn || !funnel || suggestion || offers === null) return false;
    // Reads the session list only when it has ANSWERED.
    //
    // **Its effect is redundant today, and it stays anyway.** Defaulted to `[]`
    // the count would be 0, and `shouldOfferDetail` needs `>= 2`, so an
    // unanswered read cannot currently produce the prompt either way — no
    // mutation of this line changes any assertion. It is here because the
    // arithmetic is what makes it harmless, not the intent: the moment that
    // bound moves, or a second tier reads this list for something that fires on
    // a LOW count, `[]` becomes a confident zero about an athlete whose history
    // has not loaded. That is the exact shape this whole ticket is about, and
    // it is cheaper to keep the guard than to remember the coupling.
    if (sessions.state !== 'ready') return false;
    const bjj = sessions.value.filter((x) => logsAfterwards(x.sport, modules)).length;
    return shouldOfferDetail(bjj, funnel.length, offers);
  }, [suggestionsOn, funnel, suggestion, sessions, modules, offers]);

  /**
   * Count the offer once, when it is actually on screen.
   *
   * Writes the pref and does NOT touch state. Bumping `offers` here would make
   * the card vanish under the athlete mid-read on the third showing, and it
   * would be a `setState` inside an effect — the rule this app's lint ratchet
   * exists to stop growing. The next launch reads the incremented value, which
   * is the only moment the bound has to be right.
   */
  const counted = useRef(false);
  useEffect(() => {
    if (!offerDetail || !userId || offers === null || counted.current) return;
    counted.current = true;
    writePref(userId, PREF_DETAIL_OFFERS, String(offers + 1)).catch(() => {});
  }, [offerDetail, userId, offers]);

  // Tied to focus, not mount. Today stays mounted underneath the session
  // screen, so a mount-scoped interval would re-render once a second for the
  // entire workout — in the background, for nothing. Keyed on the id rather
  // than the object so a refresh returning an equivalent session doesn't tear
  // the timer down and rebuild it. A stale session gets no clock: a resume
  // button reading 506:24:12 is not information.
  const tickingId = resume && !resume.stale ? resume.session.id : null;
  useFocusEffect(
    useCallback(() => {
      if (!tickingId) return;
      const id = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(id);
    }, [tickingId]),
  );

  /**
   * This week's theme, if there is one.
   *
   * Network-only and deliberately not cached: a theme is one short string that
   * changes weekly, so a stale one is worse than none — it would tell somebody
   * their block is about guard retention a fortnight after they moved on. It
   * degrades to absent offline, which is the honest answer.
   */
  const [theme, setTheme] = useState<Theme | null>(null);
  const weekStartKey = dayString(weekDays(now)[0]);
  useEffect(() => {
    let live = true;
    fetchThemes(getToken, { from: weekStartKey, to: weekStartKey })
      .then((ts) => {
        if (live) setTheme(ts[0] ?? null);
      })
      .catch(() => {
        // Offline, or the endpoint is unreachable. No theme, no error — this
        // is decoration on a screen that must work in a basement.
      });
    return () => {
      live = false;
    };
  }, [getToken, weekStartKey]);

  const onRetrySync = useCallback(async () => {
    if (syncing || !userId) return;
    setSyncing(true);
    setSyncError(null);
    try {
      // syncNow, not request: a person pressed this, so it must always attempt
      // rather than being told now is not the moment — and it resolves with the
      // outcome so the button can report it instead of spinning and silently
      // achieving nothing. `syncSessions` reports failures in its return value
      // rather than throwing, so the result has to be read.
      const result = await syncNow();
      refreshBoard();
      if (result.lastError) setSyncError(result.lastError);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [refreshBoard, syncing, userId]);

  return (
    <RNView style={styles.screen}>
      <ScrollView
        // The pill's clearance only when there is a pill; otherwise it is 64pt
        // of dead space under the last row.
        contentContainerStyle={[
          styles.container,
          { paddingBottom: TAB_BAR_CLEARANCE + (startable.length > 0 ? fabPad : 0) },
        ]}
        contentInsetAdjustmentBehavior="never"
        testID="today-screen"
      >
        {/* Inside the ScrollView, so it scrolls away with the content and
            nothing passes under it — no bottom rule. See `ScreenHeader`. */}
        <ScreenHeader title="Today" contentScrollsUnder={false} />

        <View style={styles.body}>
          {/*
            Steps the day the section below describes. Restored on direct
            user instruction: "we can go to before dates or future ones" is
            continuous navigation FROM Today, which a redirect to Plan does
            not satisfy — see the note on `dayOffset` above for the full
            reasoning and the criterion this reverses.

            The label doubles as the way back: on any other day it is a button
            reading that day's date, and pressing it returns to today. On
            today it is a readout, because a control that does nothing is
            worse than no control.

            Hidden while a session is open, because the only thing it
            drives — the section below — is replaced by the resume card, which
            ignores `viewDay` entirely (see `buildTodayBoard`). Left visible it
            would be a control that moved the date line and nothing else.
          */}
          {!resume && (
            <PeriodSwitcher
              label={dayLabel}
              // The full date, folded into the pill rather than repeated in a
              // standalone line under it — see N179/#584. `TODAY` and
              // "Wednesday, 26 August" were the same fact stated twice.
              //
              // **Only on today, though (W14, #694).** The N179/#584 fix
              // above reasoned this should be ONE expression regardless of
              // `isToday`, on the grounds that `todayLabel(viewDay)` already
              // covers both cases without a second place to drift — true, but
              // it stated the SAME fact `label` already states on every other
              // day too: `dayLabel` is `todayLabel(viewDay)`'s own short form
              // (`FRI 28 AUG`) once `isToday` is false, so pairing them
              // reintroduced exactly the duplication this prop exists to
              // remove, one level down. `label` alone already carries the
              // date on a browsed day; the sub-line adds nothing there and is
              // omitted.
              subLabel={isToday ? todayLabel(viewDay) : undefined}
              onPrev={() => setDayOffset((d) => d - 1)}
              onNext={() => setDayOffset((d) => d + 1)}
              onPress={isToday ? undefined : () => setDayOffset(0)}
              icon="calendar"
              prevLabel="Previous day"
              nextLabel="Next day"
              pressLabel="Back to today"
              testID="today-day"
            />
          )}

          {/* ── 1. NOW / NEXT ─────────────────────────────────────────────
              The screen's single primary. Everything below it is outlined,
              flat or read-only, so there is never a second filled control
              competing for the same glance. */}
          <LeadBlock
            lead={lead}
            sessionsUnavailable={sessions.state === 'unavailable'}
            modules={modules}
            accent={accent}
            now={now}
            viewDay={viewDay}
            isToday={isToday}
            isPast={isPast}
            dayLabel={dayLabel}
            classFocusValue={classFocusValue}
            onOpenSession={(s) => router.push(sessionHref(s, modules))}
            onStart={startPlanned}
            onPlan={() => router.push('/(tabs)/workouts')}
          />

          {startable.length === 0 && (
            // Every discipline off is a reachable state — nothing stops a user
            // turning them all off — and the block rendered nothing at all,
            // which reads as a broken screen rather than a choice.
            <Pressable
              style={styles.startButton}
              onPress={() => router.push('/profile/edit')}
              accessibilityRole="button"
              accessibilityLabel="Choose what you train"
              testID="start-session-none"
            >
              <Text style={styles.startText}>Choose what you train</Text>
            </Pressable>
          )}

          {/* ── 2. LATER ──────────────────────────────────────────────────
              Read-only, and shown even beside a running session: it is not a
              competing action — there is no button on it — it is the answer to
              "and after this?", which an athlete finishing a session is
              entitled to have. Absent entirely when the read has not answered
              or there is nothing ahead; a "nothing planned this fortnight" row
              would be a permanent scold. */}
          <LaterBlock later={board.later} modules={modules} />

          {/* ── 3. DAILY PROGRESS ─────────────────────────────────────────
              The things today ASKS for: fuel, trackers, the weigh-in. Log Food
              stays exactly one tap — `onLog` pushes `/food/add` with no
              confirmation between, ON THE DAY MOMENTUM IS SHOWING (`on`) —
              N430/#692: this used to always push a bare `/food/add`, which
              `app/food/add.tsx` defaults to real today, so `Log food` on a
              browsed day silently filed the entry under the wrong one. */}
          <View style={styles.section}>
            <SectionHeader label="Daily progress" />
            {foodEnabled ? (
              <MomentumCard
                eaten={foodEaten}
                view={foodView}
                rings={rings ?? DEFAULT_RINGS}
                // NOT the switcher's `isToday` (`dayOffset === 0`). This card
                // reads whichever day `on` names — which falls back to real
                // today while a session is resuming, regardless of
                // `dayOffset` — so the title has to agree with THAT, not
                // with the switcher (W13, #693). See `on`'s own comment
                // above for why the two can disagree.
                isToday={on === todayKey}
                quickAdd={foodQuick}
                onLog={() => router.push(momentumLogFoodHref(on))}
                onQuickAdd={(f) => void quickLog(f)}
                // `?date=` seeds Food's own day-stepper (`dayOffsetFor`,
                // `lib/calendar.ts`) so the card's day link actually opens ON
                // the viewed day rather than always on real today — the other
                // half of N430/#692. Same `on` `quickLog` and `onLog` write
                // to, so what this opens always matches what got logged.
                onOpenDay={() => router.push(momentumOpenFoodHref(on))}
                onConfigureRings={() => router.push('/food/rings')}
                testID="today-momentum"
              />
            ) : (
              /* N61's last surface. DASHED, not a card, and that is the point
                 rather than decoration: a placeholder standing WHERE content
                 would stand is dashed, one standing BESIDE content is a card.
                 A solid card in the Fuel slot would read as content — an
                 athlete would take it for the thing rather than for its
                 absence.

                 Only when the module EXISTS and is off; a deployment without a
                 food log shows nothing, because promising a feature the server
                 does not have is the same lie as hiding one it does. */
              foodOff !== undefined && (
                <Pressable
                  style={({ pressed }) => [styles.fuelOff, pressed && styles.fuelOffPressed]}
                  onPress={() => router.push('/profile/edit')}
                  accessibilityRole="button"
                  accessibilityLabel={`${foodOff.label} is turned off. Turn it on to track calories and protein here`}
                  testID="today-fuel-off"
                >
                  <Text style={styles.fuelOffTitle}>{foodOff.label} is turned off</Text>
                  <Text style={styles.fuelOffNote}>
                    Turn it on to track calories and protein here.
                  </Text>
                </Pressable>
              )
            )}

            {/*
              The daily trackers — water today, coffee and whatever the athlete
              names later. Being on Today is the whole feature: a tracker you
              have to go and find is a tracker you forget.

              **Follows the browsed day now (N430/#692).** Used to be pinned
              to `todayKey` unconditionally — a tap always logged NOW and the
              cards always showed real today's counts, even while the rest of
              the screen said "FRI 28 AUG". That silently mislabeled every
              browsed-day count as today's and, worse, filed every tap under
              the wrong day with no way to tell. Read for the day, and file a
              tap under the day: see `dayAtTap` below for how TODAY
              specifically still resolves at the moment of the tap rather
              than at render.
            */}
            <TrackerList
              day={trackerDay}
              // TODAY resolves fresh at the MOMENT of the tap, exactly as
              // before: `dayString(new Date())` rather than the `on`/`now`
              // this render captured, because this screen never unmounts and
              // a phone left open across midnight would otherwise still hold
              // yesterday's `on` until something re-renders — the first tap
              // at 00:05 must not file a cup under the day that just ended.
              //
              // A BROWSED day has no such staleness risk — `dayOffset` is
              // already an explicit choice away from today, not a clock
              // reading — so it resolves to `on`, the same day the cards
              // above and `quickLog` write to.
              dayAtTap={() => trackerTapDay(isToday, on, () => new Date())}
              units={units}
              unitsReady={unitsReady}
              // Three, then a disclosure row — N78's answer to "several
              // trackers on Today do not crowd out what Today is for". The
              // server caps an athlete at eight; three is what fits here
              // without pushing the rest of the screen below the fold.
              collapseAfter={3}
              // Expanding is a decision about the day ON SCREEN, not just
              // about "today" any more. `on` changes when the switcher steps
              // — without keying on it, "2 more trackers" expanded on
              // Tuesday would still read as expanded after stepping to
              // Wednesday, the same one-shot trap `todayKey` alone existed
              // to prevent for a screen that never unmounts.
              collapseKey={on}
              testID="today-trackers"
            />

            {/* The weigh-in. It is here rather than on Progress because it is
                the one block on this screen that ASKS rather than reports —
                the check-in is a daily action. The trend it draws is the
                three-second version; the readable, exportable one is
                `/goals/trend`, which this card opens. */}
            <ProgressCard
              checkins={checkins}
              phase={phase}
              today={dayString(new Date())}
              units={units}
              loaded={checkinsLoaded}
              unitsReady={unitsReady}
              onOpen={() => router.push('/goals/trend')}
              testID="today-progress"
            />
          </View>

          {/* ── 4. THIS WEEK ──────────────────────────────────────────────
              Consistency, compactly. The month calendar, the full week review
              and the eight-week bar chart that used to sit here are on
              Progress now — this is the glance, that is the read. */}
          <View style={styles.section}>
            <SectionHeader label="This week" />
            <WeekStrip
              now={now}
              days={weekDays(now)}
              // `logged` is FOOD days, matching the `LOGGING` card below so the
              // two agree. The strip does not decide that for itself — it takes
              // a set — and Today owns the choice.
              logged={loggedView}
              // Goes to Progress, which is where the week review now lives. It
              // used to scroll to a card further down THIS screen; that card
              // moved, and a link to a place that no longer exists is worse
              // than a tab change.
              onWeekInReview={() => router.push('/(tabs)/progress')}
              testID="today-week-strip"
            />
            {/* LOGGING only exists where a food log does. Without one, TRAINING
                takes the row on its own rather than sitting beside a card that
                reports on a feature this deployment does not have. */}
            <MiniCardRow>
              <TrainingCard
                training={training}
                onPress={() => router.push('/(tabs)/progress')}
                testID="today-training"
              />
              {foodEnabled ? (
                <LoggingCard
                  loggedDays={loggedView}
                  days={weekDays(now)}
                  now={now}
                  onPress={() => router.push('/(tabs)/food')}
                  testID="today-logging"
                />
              ) : null}
            </MiniCardRow>
          </View>

          {/* ── 5. INSIGHT ────────────────────────────────────────────────
              At most one, and only when there is evidence for it. Three would
              be a report; the point is to change one thing about the next
              session. Absent entirely otherwise — a permanent "no insights
              yet" row is the app asking for homework. */}
          {(suggestion || offerDetail) && (
            <View style={styles.section}>
              <SectionHeader label="Insight" />

              {suggestion && (
                /*
                  It shows its own evidence rather than asserting. "Drilled 9
                  times across 3 sessions, never live" is checkable; "work on
                  your arm drag" is a verdict, and the recorded design rules out
                  self-assessment for the same reason.
                */
                <Pressable
                  style={({ pressed }) => [styles.suggestion, pressed && styles.planCardPressed]}
                  onPress={() => router.push(`/technique/${suggestion.techniqueId}`)}
                  accessibilityRole="button"
                  // Leads with the card's OWN visible title — WCAG 2.5.3. It
                  // read "try {name} live" while the card says "Try {name} in a
                  // round", so "tap try armbar in a round" matched nothing
                  // under Voice Control. The same fix this branch makes on the
                  // plan card and the Tier 0 offer; review caught that this one
                  // was inconsistent with its own neighbours.
                  accessibilityLabel={`Suggestion: Try ${suggestion.name} in a round. Drilled in ${suggestion.drilled} sessions and never logged live. Open the technique.`}
                  // The x below is a Pressable INSIDE this one, and UIKit does
                  // not descend into a view that is itself an accessibility
                  // element — so its label and hint are never announced, and
                  // neither VoiceOver nor Voice Control can invoke it. A rotor
                  // action on the card is the way out.
                  accessibilityActions={[{ name: 'dismiss', label: 'Dismiss this suggestion' }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'dismiss') dismiss(suggestion.techniqueId);
                  }}
                  testID="today-suggestion"
                >
                  <View style={styles.planMain}>
                    <Text style={[styles.suggestionEyebrow, { color: accent.ink }]}>
                      WORTH A GO
                    </Text>
                    <Text style={styles.planTitle} numberOfLines={2}>
                      Try {suggestion.name} in a round
                    </Text>
                    {/* ONE number. It read "drilled N times across N sessions",
                        which is the same fact twice: the wizard writes
                        `drilled` once per session, so the two columns are
                        equal. And the claim is about the record, not about the
                        athlete — the app cannot see a round it was not told
                        about. */}
                    <Text style={styles.suggestionMeta}>
                      Drilled in {suggestion.drilled} sessions, never logged live
                    </Text>
                  </View>
                  {/*
                    An explicit dismiss, not the long-press this app uses to
                    remove a planned session. Long-press is right for a row the
                    athlete deliberately created; this is unsolicited, and the
                    moment anyone wants it gone is the moment they should not
                    have to discover how.
                  */}
                  <Pressable
                    onPress={() => dismiss(suggestion.techniqueId)}
                    // Asymmetric. A symmetric 12 swallowed the whole 12pt gap
                    // between the meta line and the glyph, so a tap at the
                    // right edge of the evidence text dismissed the card rather
                    // than opening it — an invisible destructive target
                    // abutting a harmless one.
                    hitSlop={{ top: 12, bottom: 12, right: 12, left: 4 }}
                    style={({ pressed }) => [styles.dismiss, pressed && styles.dismissPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Dismiss the ${suggestion.name} suggestion`}
                    accessibilityHint="Stops VOLA suggesting this technique"
                    testID="today-suggestion-dismiss"
                  >
                    <Icon name="close" size={15} color={vola.textMuted} />
                  </Pressable>
                </Pressable>
              )}

              {offerDetail && (
                /*
                  Tier 0: the only prompt that CREATES the evidence the rest
                  read. Bounded on both sides — not on the first session,
                  because one is not a habit, and never past the fourth, because
                  by then the athlete has heard it and is choosing. A prompt
                  that repeats forever is the shame the UX direction rules out,
                  however politely it is worded.
                */
                <Pressable
                  style={({ pressed }) => [styles.suggestion, pressed && styles.planCardPressed]}
                  // The reflection wizard is where detail is added; the library
                  // is a catalog. Sending them to the catalog contradicted the
                  // copy, so this goes to Plan, where the week and its sessions
                  // are.
                  onPress={() => router.push('/(tabs)/workouts')}
                  accessibilityRole="button"
                  // Leads with the visible title — WCAG 2.5.3. Named only by
                  // the sentence version, "tap Add what happened in rolling"
                  // did nothing under Voice Control, and the label never said
                  // what pressing it does.
                  accessibilityLabel="Add what happened in rolling. Naming the techniques you drilled is what lets VOLA suggest what to work on. Opens your recent sessions."
                  testID="today-offer-detail"
                >
                  <View style={styles.planMain}>
                    <Text style={[styles.suggestionEyebrow, { color: accent.ink }]}>
                      ONE MORE STEP
                    </Text>
                    <Text style={styles.planTitle} numberOfLines={2}>
                      Add what happened in rolling
                    </Text>
                    <Text style={styles.planEmptyMeta}>
                      Naming the techniques you drilled is what lets VOLA suggest what to work on.
                    </Text>
                  </View>
                  <Icon name="chevron" size={16} color={vola.textDim} />
                </Pressable>
              )}
            </View>
          )}

          {/* ── 6. CURRENT FOCUS ──────────────────────────────────────────
              One commitment, at the foot of the screen: what the athlete
              decided in advance, rather than what the app inferred.

              Deliberately NOT beside the Insight block above — that one is
              inference over evidence, this is a commitment, and the design doc
              is explicit that conflating them turns a curriculum into a
              prescription. */}
          {theme && (
            <View style={styles.section}>
              <SectionHeader label="Current focus" />

              {/*
                What this week is for, if the athlete said. Read-only HERE —
                Today is a read surface throughout, and the theme fits that.
                As of N82 it is no longer web-only, though: `WeekPlanner`
                (the Plan tab, `components/WeekPlanner.tsx`) carries the
                actual editor, tap-to-edit on the shown week's row, so the
                capability itself is on the phone even though this particular
                card is not where it is set. The outer `theme &&` above is what
                keeps a permanent "no theme set" row from ever existing — the
                app asking for homework.
              */}
              <View style={styles.themeCard} testID="week-theme">
                <Text style={styles.themeLabel}>This week</Text>
                <Text style={styles.themeTitle}>{theme.title}</Text>
                {theme.notes !== '' && <Text style={styles.themeNotes}>{theme.notes}</Text>}
              </View>
            </View>
          )}

          {/* Only when there is something to say. The old screen showed
              "0 pending · 0 synced" permanently — a number that reassures
              precisely when nobody needed reassuring, and that trained the eye
              to skip the row on the day it finally said something. */}
          {pendingSessions > 0 && (
            <View style={styles.pendingRow} testID="sessions-pending">
              <Text style={styles.pendingText}>
                {pendingSessions} {pendingSessions === 1 ? 'session' : 'sessions'} waiting to sync
                {deferred > 0
                  ? ` — ${deferred === 1 ? 'one is' : `${deferred} are`} waiting on a plan that hasn't synced yet`
                  : ''}
              </Text>
              <Pressable
                onPress={onRetrySync}
                disabled={syncing}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Retry sync"
                accessibilityState={{ busy: syncing, disabled: syncing }}
                testID="retry-sync"
              >
                {syncing ? (
                  <ActivityIndicator />
                ) : (
                  <Text style={[styles.retryText, { color: accent.ink }]}>Retry</Text>
                )}
              </Pressable>
            </View>
          )}

          {/* A permanently-refused session would otherwise sit at "1 waiting to
              sync" forever behind a Retry that appears to do nothing. */}
          {syncError && (
            <Text style={styles.syncError} accessibilityLiveRegion="polite" testID="sync-error">
              {syncError}
            </Text>
          )}
        </View>

        <PickSessionSheet
          visible={picking}
          modules={modules}
          userId={userId ?? null}
          title="New log"
          onClose={() => setPicking(false)}
          onPick={(pick) => {
            // Closed before navigating: leaving the modal mounted over a push
            // means coming back from the session lands on the sheet again.
            setPicking(false);
            startPlanned(pick);
          }}
        />
      </ScrollView>

      {/*
        New Log, floating.

        It was "Start something" — a dashed full-width card sitting directly
        under the plan, third thing on the screen. Two problems with that. It
        spent the most valuable space on the *fallback*: the answer to "what
        should I do today" is the plan, and the escape hatch was as loud as it.
        And it is needed most often at the END of the flow — you came to log
        something you already did — by which point you had scrolled past it.
      */}
      {startable.length > 0 && (
        <Pressable
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: accent.accent },
            pressed && styles.fabPressed,
          ]}
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel="New log"
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          testID="today-new-log"
        >
          <Icon name="plus" size={16} color={accent.on} />
          {/* One line, always — at the largest accessibility sizes a second
              line makes the pill tall enough to cover the list again, which is
              the bug the clearance exists to prevent. */}
          <Text numberOfLines={1} style={[styles.fabText, { color: accent.on }]}>
            New log
          </Text>
        </Pressable>
      )}
    </RNView>
  );
}

/**
 * Block 1 — NOW / NEXT.
 *
 * Five renderings for five states, and the mapping is the whole point of this
 * component existing separately from the screen:
 *
 * | state | what it draws |
 * |---|---|
 * | `unread` | **nothing at all** — the read has not answered |
 * | `unavailable` | a dashed note saying so, never an empty day |
 * | `resume` | the running session, and nothing competing with it |
 * | `owed` | one card per plan `viewDay` has not met |
 * | `done` | planned, and all of it logged |
 * | `rest` | a real rest day, including anything logged off-plan |
 *
 * **`unread` draws nothing rather than a spinner.** A tab screen re-runs this
 * read on every focus, so a spinner would flash on every return from a session
 * — and the block below it is 40pt away, so the layout does not jump into a
 * hole. Silence for one frame is the honest rendering; a sentence is not.
 *
 * **`viewDay`/`isToday`/`isPast`/`dayLabel` only reach the `owed`/`done`/
 * `rest` copy** — `resume` and `unavailable` read neither, because the day
 * switcher above this block is hidden the moment a session is open (see the
 * screen's own render) and has nothing to say when the reads have failed.
 */
function LeadBlock({
  lead,
  sessionsUnavailable,
  modules,
  accent,
  now,
  viewDay,
  isToday,
  isPast,
  dayLabel,
  classFocusValue,
  onOpenSession,
  onStart,
  onPlan,
}: {
  lead: Source<TodayLead>;
  /**
   * Whether the SESSION read specifically is what failed.
   *
   * Only consulted in the `unavailable` branch, and it is the difference
   * between "we could not check for an unfinished session" and a claim that is
   * simply untrue — see there.
   */
  sessionsUnavailable: boolean;
  modules: Module[];
  accent: ReturnType<typeof useAccent>;
  now: Date;
  /** The day the switcher is showing. Only the OWED/DONE/REST copy reads it. */
  viewDay: Date;
  isToday: boolean;
  /** A day already gone. Disables the plan cards' press and changes the copy. */
  isPast: boolean;
  /** "TODAY", or the weekday and date — what the copy says for a browsed day. */
  dayLabel: string;
  /**
   * #447's roadmap focus/suggestion line, or null when there is nothing to
   * say. Only reaches a BJJ plan in the `owed` branch — see there.
   */
  classFocusValue: ClassFocus | null;
  onOpenSession: (s: Session) => void;
  onStart: (p: { sport: string; workoutId: string | null }) => void;
  onPlan: () => void;
}) {
  if (lead.state === 'unread') return null;

  if (lead.state === 'unavailable') {
    /*
      Dashed, per #468: it stands WHERE content would stand. And **which read
      failed is part of what the athlete is told**, because the two are not
      equivalent and this copy used to claim they were:

      - The SESSION read failing means the screen cannot tell whether something
        is part-finished — so the rule that a running session outranks
        everything is the one it has just lost the ability to apply. That is
        worth saying, because the athlete may have a session open.
      - The PLAN read failing while sessions answered means the opposite: we
        know nothing is open, because a resume would have short-circuited this
        block entirely. Saying "we could not check for an unfinished session"
        there is false, and it sends the athlete looking in the wrong place.

      Found in review, on copy that asserted both halves unconditionally.
      Train draws the same distinction with two separate notes.
    */
    return (
      <View style={styles.planEmpty} testID="today-lead-unavailable">
        <View style={styles.planMain}>
          <Text style={styles.planEmptyTitle}>
            {sessionsUnavailable
              ? "We couldn't read today just now."
              : "We couldn't read today's plan just now."}
          </Text>
          <Text style={styles.planEmptyMeta}>
            {sessionsUnavailable
              ? 'That covers your plan and any unfinished session. New log still works.'
              : 'New log still works.'}
          </Text>
        </View>
      </View>
    );
  }

  const value = lead.value;

  if (value.kind === 'resume') {
    const active = value.offer.session;
    const stale = value.offer.stale;
    return (
      <Pressable
        style={[styles.resumeCard, { borderColor: accent.accent }, stale && styles.resumeCardStale]}
        onPress={() => onOpenSession(active)}
        accessibilityRole="button"
        // Deliberately excludes the ticking time. A 1 Hz live region would be
        // hostile, but the label overrides the children entirely, so a
        // screen-reader user would otherwise get no progress at all — hence the
        // coarse, stable facts instead.
        accessibilityLabel={
          stale
            ? `Unfinished ${active.name || active.sport} session from ${new Date(
                active.started_at,
              ).toLocaleDateString()}, ${workingSets(active)} working sets. Open to finish or discard it.`
            : `Continue ${active.name || active.sport} session in progress, ${workingSets(
                active,
              )} working sets`
        }
        testID="resume-session"
      >
        <Text
          style={[styles.resumeEyebrow, { color: accent.ink }, stale && styles.resumeEyebrowStale]}
        >
          {stale ? 'UNFINISHED' : 'IN PROGRESS'}
        </Text>
        <Text style={styles.resumeTitle}>{active.name || active.sport}</Text>
        {/* Chips rather than a dot-joined string — the running clock is the
            most important number on this screen and it should not have to be
            read out of a sentence. Icons are decoration here: the Pressable's
            own accessibilityLabel replaces all of this for a screen reader. */}
        <View style={styles.resumeMetaRow}>
          <View style={styles.chip}>
            <Icon name={stale ? 'calendar' : 'timer'} size={13} color={vola.textMuted} />
            <Text style={styles.resumeMeta}>
              {stale
                ? new Date(active.started_at).toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : formatElapsed((now.getTime() - new Date(active.started_at).getTime()) / 1000)}
            </Text>
          </View>
          {/* Omitted, not zeroed, for a discipline that cannot hold a set —
              "0 working sets" on a mat session reads as abandoned. */}
          {!logsAfterwards(active.sport, modules) && (
            <View style={styles.chip}>
              <Icon name="layers" size={13} color={vola.textMuted} />
              <Text style={styles.resumeMeta}>
                {workingSets(active)} {workingSets(active) === 1 ? 'working set' : 'working sets'}
              </Text>
            </View>
          )}
        </View>
        <View style={[styles.resumeAction, stale && styles.resumeActionStale]}>
          <Text style={[styles.resumeActionText, stale && styles.resumeActionTextStale]}>
            {stale ? 'Finish or discard' : 'Continue'}
          </Text>
        </View>
      </Pressable>
    );
  }

  if (value.kind === 'owed') {
    return (
      <View style={styles.section}>
        <SectionHeader label="Up next" />
        {value.plans.map((p) => (
          <UpNextCard
            key={p.id}
            sport={p.sport}
            title={p.workoutName ?? `${labelFor(modules, p.sport)} session`}
            when={isToday ? 'Today' : dayLabel}
            // #447: the roadmap's current focus and up to two things worth
            // trying, beneath the Log button — BJJ only, since that is the
            // only discipline with a roadmap or a suggestion tier at all, and
            // never on a day already gone (a past class card says "Not
            // logged", not what to try next on it).
            hint={p.sport === 'bjj' && !isPast && classFocusValue ? classHintText(classFocusValue) : null}
            // A day already gone is a statement, not a control — the same
            // rule the plan card this replaced always drew: `past` drops the
            // handler and the Log button and says `pastLabel` instead of
            // dimming, because a blanket opacity took "Not logged" below AA.
            past={isPast}
            pastLabel="Not logged"
            // The verb comes from the CATALOG KIND, not the module key — a
            // discipline logged after the fact says Log, and it is the same
            // predicate `startSessionHref` routes on, so the word and the
            // destination cannot disagree.
            logLabel={logsAfterwards(p.sport, modules) ? 'Log' : 'Start'}
            onLog={() => onStart(p)}
            onOpen={() => onStart(p)}
            // Names the card by the SAME string it shows — WCAG 2.5.3. Labelled
            // with the bare discipline while the card reads "BJJ session", Voice
            // Control's "tap BJJ session" matches nothing.
            accessibilityLabel={
              isPast
                ? `${p.workoutName ?? `${labelFor(modules, p.sport)} session`}, planned and not logged`
                : `${
                    logsAfterwards(p.sport, modules) ? 'Log' : 'Start'
                  } ${p.workoutName ?? `${labelFor(modules, p.sport)} session`}, planned for ${
                    isToday ? 'today' : dayLabel.toLowerCase()
                  }${
                    // Explicit accessibilityLabel replaces UpNextCard's own
                    // default (which appends `hint` for us) — so the hint has
                    // to be repeated here, or a screen-reader user loses the
                    // one thing sighted athletes now see on this card.
                    p.sport === 'bjj' && classFocusValue
                      ? `. ${classHintText(classFocusValue)}`
                      : ''
                  }`
            }
            testID={`today-plan-${p.id}`}
          />
        ))}
      </View>
    );
  }

  if (value.kind === 'done') {
    /*
      Planned, and all of it done. Distinct from having planned nothing, and the
      distinction is the whole point: before this the screen said "Nothing
      planned for today" the moment you finished your last session, which is the
      one sentence that is flatly untrue at that exact moment.

      Past tense for a browsed PAST day — "was logged" rather than "is logged" —
      matching the wording the pre-N179 screen used for exactly this case.
    */
    return (
      <View style={styles.planDone} testID="today-all-done">
        <View style={styles.planMain}>
          <Text style={styles.planDoneTitle}>
            {isPast ? 'Everything planned was logged.' : 'That is everything planned.'}
          </Text>
          <Text style={styles.planEmptyMeta}>
            {value.planned === 1 ? '1 session' : `${value.planned} sessions`} logged against the
            plan.
          </Text>
        </View>
      </View>
    );
  }

  /*
    A rest day, and a real state rather than a blank one — for whichever day
    `viewDay` is showing, not always literal today.

    Four things can be true and each has its own sentence: nothing was
    scheduled; rest is a training state rather than a gap; the athlete trained
    anyway, off-plan (`loggedToday`, on both a past day and today — somebody
    who lifted without planning it, reading only "Nothing on the plan", has
    been told their session did not count); and a FUTURE day has not happened
    yet at all, so "rest counts" is the wrong sentence for it — nothing has
    been rested from.

    The rest line is circulated by date rather than picked at random, so the
    same day always says the same thing, and none of the lines congratulate or
    scold. `restLine(viewDay)`, not `restLine(now)` — the line has to describe
    the day being shown. See `lib/trend.ts`.
  */
  const restMeta = isPast
    ? value.loggedToday > 0
      ? `You logged ${value.loggedToday} ${
          value.loggedToday === 1 ? 'session' : 'sessions'
        } then anyway.`
      : 'Nothing was planned, and nothing logged.'
    : isToday
      ? value.loggedToday > 0
        ? `You logged ${value.loggedToday} ${
            value.loggedToday === 1 ? 'session' : 'sessions'
          } today anyway. Plan the next one here.`
        : 'Rest counts — or plan something here, or log an unplanned session with New log.'
      : 'Nothing planned yet. Plan something here.';

  return (
    <Pressable
      style={({ pressed }) => [styles.planEmpty, pressed && styles.planCardPressed]}
      onPress={onPlan}
      accessibilityRole="button"
      accessibilityLabel={`${restLine(viewDay)} ${restMeta}`}
      testID="today-unplanned"
    >
      <View style={styles.planMain}>
        <Text style={styles.planEmptyTitle}>{restLine(viewDay)}</Text>
        <Text style={styles.planEmptyMeta}>{restMeta}</Text>
      </View>
      <Icon name="chevron" size={16} color={vola.textDim} />
    </Pressable>
  );
}

/**
 * Block 2 — LATER.
 *
 * The soonest planned day after today, with no button on it. It is deliberately
 * NOT actionable: starting tomorrow's session today is how a plan stops meaning
 * anything, and the athlete who genuinely wants to is one tap from New log.
 *
 * Renders nothing at all when the read is `unread`, `unavailable` or empty. The
 * first two are the loading discipline; the third is a judgement — "nothing
 * planned for the next fortnight" is a true sentence and a scolding one, and it
 * is the Plan tab's business rather than this screen's.
 */
function LaterBlock({
  later,
  modules,
}: {
  later: Source<PlannedOffer | null>;
  modules: Module[];
}) {
  if (later.state !== 'ready' || later.value === null) return null;
  const p = later.value;
  const when = new Date(`${p.day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  return (
    <View style={styles.section}>
      <SectionHeader label="Later" />
      <View style={styles.later} testID="today-later">
        <Text style={styles.laterTitle}>
          {p.workoutName ?? `${labelFor(modules, p.sport)} session`}
        </Text>
        <Text style={styles.planEmptyMeta}>{when}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No horizontal padding here: the header manages its own, so it can sit
  // flush while the cards below stay inset.
  screen: { flex: 1 },
  themeCard: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 2,
  },
  themeLabel: {
    fontSize: 10,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  themeTitle: { fontSize: 15, fontWeight: '700' },
  themeNotes: { fontSize: 12, color: vola.textMuted, marginTop: 2 },
  container: { gap: 12 },

  // The workouts tab's pill, to the point: same radius, same padding, same
  // `bottom`, same accent shadow. Two floating primary actions that sat at
  // different heights would jump 16pt as you switched tabs.
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    // NO GLOW (N108). The user has said twice that they do not want haze
    // anywhere on this screen. Removing the `accentGlow` call alone would not
    // have done it: `shadowColor` defaults to BLACK, and Android draws
    // `elevation` regardless of colour.
  },
  fabPressed: { opacity: 0.85 },
  fabText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  body: { paddingHorizontal: 20, gap: 16 },

  resumeCard: {
    backgroundColor: vola.surfaceRaised,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 4,
  },
  // Stale sessions drop the lime entirely: lime is this app's "act on this
  // now", and a workout from last Tuesday is not that.
  resumeCardStale: { borderColor: vola.line, backgroundColor: vola.surface },
  resumeEyebrow: { fontSize: 11, letterSpacing: 1.2, fontWeight: '700' },
  resumeEyebrowStale: { color: vola.warn },
  resumeActionStale: { backgroundColor: 'transparent', borderWidth: 1, borderColor: vola.line },
  resumeActionTextStale: { color: vola.text },
  resumeTitle: { fontSize: 22, fontWeight: '700' },
  // Tabular figures so a ticking clock doesn't shuffle the text beside it.
  resumeMeta: { color: vola.textMuted, fontSize: 14, fontVariant: ['tabular-nums'] },
  resumeMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  resumeAction: {
    marginTop: 12,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  resumeActionText: { fontWeight: '700', fontSize: 16 },

  // Planned and finished. A statement, not a control — there is nothing left
  // to press, and a card that looks pressable and is not is worse than a flat
  // one.
  planDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  planDoneTitle: { color: vola.text, fontSize: 15, fontWeight: '700' },

  // LATER. Flat and buttonless on purpose — see `LaterBlock`.
  later: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 2,
  },
  laterTitle: { fontSize: 15, fontWeight: '700' },

  // Quieter than a plan card and louder than the empty state: a solid surface
  // with no accent fill and no button. The plan is the thing to act on; this
  // is the thing to consider.
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  suggestionEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  // `textMuted` (6.85:1 here), not `textDim` (3.67:1, under AA at 12pt). This
  // line carries the card's entire justification — it is the evidence, not
  // decoration, and a card that asks to be judged on its reasoning has to let
  // it be read.
  suggestionMeta: { color: vola.textMuted, fontSize: 12, lineHeight: 16 },
  // 44pt of touch with `hitSlop`, so the one control on this card that cannot
  // be undone is not the fiddliest thing on the screen.
  dismiss: { padding: 6, marginRight: -6, borderRadius: 14 },
  // Opacity, not a square fill — a hard 27pt square flashing inside a 14pt-
  // radius card reads as a rendering fault.
  dismissPressed: { opacity: 0.5 },

  planCardPressed: { backgroundColor: vola.surfaceHover },
  planMain: { flex: 1, gap: 2, marginLeft: 13 },
  planTitle: { fontSize: 18, fontWeight: '700' },

  planEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  planEmptyTitle: { fontSize: 15, fontWeight: '700', color: vola.textMuted },
  planEmptyMeta: { fontSize: 12, color: vola.textDim },

  // Outlined, never filled — see the comment at its call site.
  startButton: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: vola.line,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  startText: { color: vola.text, fontWeight: '600', fontSize: 16 },

  // The Fuel slot when nutrition is off. Dashed and unfilled, matching
  // `startButton` above rather than MomentumCard — it marks an absence, and a
  // solid card here would read as the thing itself.
  fuelOff: {
    borderWidth: 1,
    borderColor: vola.line,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 2,
  },
  fuelOffPressed: { opacity: 0.6 },
  fuelOffTitle: { color: vola.text, fontWeight: '600', fontSize: 14 },
  // textMuted, not textDim: at 12pt this is small text, and textDim measures
  // 3.96:1 on `bg` — below AA's 4.5:1. This sits on `bg` rather than a card, so
  // textMuted here is 7.38:1.
  fuelOffNote: { color: vola.textMuted, fontSize: 12 },

  // The cards space themselves; the header sits a touch closer to the first
  // one than the gap between cards, so the label reads as belonging to them.
  section: { gap: 8, marginTop: 4 },

  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pendingText: { color: vola.warn, fontSize: 13 },
  retryText: { fontWeight: '600', fontSize: 14 },
  syncError: { color: vola.danger, fontSize: 13, marginTop: -8 },
});
