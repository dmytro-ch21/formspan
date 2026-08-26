import { useAuth } from '@clerk/clerk-expo';
import { request as requestSync, syncNow, useSyncState } from '@/lib/sync';
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
import { RoadmapLine } from '@/components/RoadmapLine';
import { RoadmapOffer } from '@/components/RoadmapOffer';
import { SectionHeader } from '@/components/ui/Section';
import { TrendStrip } from '@/components/ui/TrendStrip';
import { SessionCard, type Metric } from '@/components/ui/SessionCard';
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
import { TrainingCalendar } from '@/components/TrainingCalendar';
import { WeekReview } from '@/components/WeekReview';
import { vola } from '@/constants/Colors';
import { formatDuration } from '@/lib/history';
import { addDays, dayString, startOfWeek, weekDays } from '@/lib/calendar';
import { fetchThemes, type Theme } from '@/lib/themes';
import { owedOn } from '@/lib/adherence';
import { listPlannedBetween, type PlannedSession } from '@/lib/plan';
import { formatElapsed } from '@/lib/rest';
import type { Session } from '@/lib/sessions';
import { cachedWorkouts, listLocalSessions, trainingSince } from '@/lib/sessionStore';
import { reviewWeek } from '@/lib/weekReview';
import { listWorkingCurricula, type Curriculum } from '@/lib/curriculum';
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
import { restLine, weeklyDays } from '@/lib/trend';
import { formatVolume, type UnitSystem } from '@/lib/units';
import {
  enabledSports,
  labelFor,
  logsAfterwards,
  moduleWithCatalog,
  type Module,
} from '@/lib/modules';
import { startSessionHref } from '@/lib/startSession';
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
import { totalWeightKg, contributesVolume, countsAsSet } from '@/lib/sessions';

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

/** Past this, an open session reads as abandoned rather than in progress. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

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

/** Weight × reps over a session's working sets. */
function sessionVolume(s: Session): number {
  let kg = 0;
  for (const set of s.sets) {
    if (contributesVolume(set) && set.weight_kg != null && set.reps != null) {
      kg += totalWeightKg(set) * set.reps;
    }
  }
  return kg;
}

/**
 * The measures worth showing on a session's card.
 *
 * **Every chip is omitted rather than zeroed when its measure doesn't apply.**
 * A BJJ session cannot legally hold a set (no BJJ exercises exist since
 * migration 000019), so a "0 sets" chip on one is not a neutral default — it
 * reads as an abandoned session, which is the same trap `describeSession`
 * documents. Likewise a bodyweight session has no tonnage, and an unfinished
 * one has no duration yet.
 *
 * The upshot is that a card can legitimately carry no chips at all, and that
 * is the honest rendering — the card still shows its name, sport, date and
 * state, which is everything actually known about it.
 */
function sessionMetrics(s: Session, mods: Module[], units: UnitSystem): Metric[] {
  const out: Metric[] = [];

  if (s.ended_at) {
    const seconds = (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    out.push({ icon: 'timer', value: formatDuration(seconds) });
  }

  if (!logsAfterwards(s.sport, mods)) {
    const n = workingSets(s);
    if (n > 0) out.push({ icon: 'layers', value: `${n} ${n === 1 ? 'set' : 'sets'}` });
  }

  const kg = sessionVolume(s);
  if (kg > 0) out.push({ icon: 'barbell', value: formatVolume(kg, units) });

  return out;
}

/** e.g. "Mon 28" — short enough to sit in a column down the right of the list. */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

/** e.g. "Thursday, 31 July" — orientation, not decoration. */
function todayLabel(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Where tapping a session goes.
 *
 * Keyed on the SAME predicate as the log button, deliberately: a sport that
 * logs afterwards is a sport whose sessions cannot hold a set, so sending one
 * to the set logger renders "Sets 0 · Reps 0 · Volume —" over an empty list.
 * That is what shipped, and it made the whole reflection unreachable — the
 * wizard is entered by `replace` from the log screen and linked from nowhere
 * else, so a logged class had no surface that would ever show it back.
 *
 * If the two predicates ever disagree, a session opens a screen built for a
 * different shape. Reusing the one function is what stops that.
 */
function sessionHref(s: Session, mods: Module[]) {
  // The object form rather than a template string: expo-router's typed routes
  // reject a bare `string`, and going through the generated pathname literals
  // means a renamed route breaks the build instead of the tap.
  return logsAfterwards(s.sport, mods)
    ? ({ pathname: '/bjj/session/[id]', params: { id: s.id } } as const)
    : ({ pathname: '/session/[id]', params: { id: s.id } } as const);
}

function describeSession(s: Session, mods: Module[]): string {
  const parts = [
    new Date(s.started_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
  ];
  // "0 sets" on every mat session is not a neutral default — it reads as an
  // abandoned session. A BJJ session legally cannot hold a set (no BJJ
  // exercises exist since migration 000019), so the count is structurally
  // zero and saying it is worse than saying nothing.
  if (!logsAfterwards(s.sport, mods)) {
    const n = workingSets(s);
    parts.push(`${n} ${n === 1 ? 'set' : 'sets'}`);
  }
  if (s.ended_at) {
    parts.push(
      formatElapsed((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000),
    );
  } else {
    // Says why this row has no duration, rather than leaving a gap that reads
    // as a rendering fault.
    parts.push('unfinished');
  }
  return parts.join(' · ');
}

/**
 * Today — what am I doing right now, or next.
 *
 * The screen this replaced was the first vertical slice with three layers of
 * scaffolding still showing: a hardcoded "Log a BJJ session" form, a raw list
 * printing `bjj_session` at the athlete, and a permanent "0 pending · 0 synced"
 * readout. All of it was plumbing on display, and none of it answered the
 * question someone opens this tab to ask.
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

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // From the orchestrator, not a local copy. This screen used to `await` the
  // sync and then re-count — so the number was fresh. Now that the sync is
  // fire-and-forget (the orchestrator decides), a local copy would show
  // "N waiting to sync" straight through the successful sync this very focus
  // triggered, and keep showing it until the next focus. The orchestrator
  // already recounts after every run; `useSyncState` had no consumers until
  // now, which is its own smell.
  const { pending: pendingSessions, deferred, lastSyncAt } = useSyncState();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [picking, setPicking] = useState(false);
  /**
   * The whole visible week's plan, for the calendar's dots and day list.
   *
   * Read in the same pass as today's, from one query — the lead card and the
   * calendar directly beneath it disagreeing about whether Thursday is planned
   * would be the same contradiction the week strip and stat row already avoid.
   */
  const [weekPlan, setWeekPlan] = useState<PlannedSession[]>([]);
  /**
   * The day the top of the screen is describing, which is not always today.
   *
   * Separate from `now`, which stays the real clock: "is this day in the past"
   * and "which day is highlighted" are claims about the actual date and must
   * not move when you step away. Same split the Plan tab draws between its
   * `anchor` and its `now`, and for the same reason.
   *
   * Only the Upcoming block follows it. The calendar, the week summary, Recent
   * and the trend are all week- or history-scoped — stepping to Thursday to see
   * what is on it should not rewrite what you did this week.
   */
  /**
   * How many days from today the Upcoming block is describing. 0 is today.
   *
   * An OFFSET, not a `Date`, and that is the whole point. Held as a date it is
   * anchored at mount and refreshed by nothing: `now` re-reads on focus and on
   * AppState `active`, so leaving the app on this tab overnight and reopening
   * it moved `now` to the new day while `viewDay` stayed on the old one — and
   * `isPast` then rendered the main screen in past mode, switcher reading
   * yesterday, plan cards dimmed and marked "Not logged", without the athlete
   * having navigated anywhere.
   *
   * Deriving it from `now` means every refresh of `now` re-derives it, so the
   * whole class is gone rather than patched at the two places that happened to
   * refresh. Same bug `refreshedAnchor` exists for on the Plan tab.
   */
  const [dayOffset, setDayOffset] = useState(0);
  /**
   * Plans for `viewDay` alone, resolved to template names.
   *
   * Carries `day` even though every row has the same one: `matchPlans` groups
   * by day internally, and without it a plan on a day outside the current week
   * has nothing to be matched against — see `owed` below.
   */
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
  const [viewPlans, setViewPlans] = useState<
    (PlannedSession & { workoutName: string | null })[]
  >([]);

  const refreshSessions = useCallback(async () => {
    if (!userId) return;
    try {
      // Local first: the list must render with no signal, because that's
      // exactly when you want to see the session you just logged. 30 rather
      // than 5 so the week summary has a whole week to work from; the list
      // below shows only the most recent handful.
      setSessions(await listLocalSessions(userId, 30));
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    } finally {
      // Marks that the *local* read has happened, which is what lets the empty
      // state below claim "nothing logged yet" without it being a guess.
      setLoaded(true);
    }
    // Ask the orchestrator; it decides whether now is a moment worth a run
    // (see lib/sync.ts). This screen no longer waits on the network to show
    // the list — the local read above already did that.
    requestSync('today-focus');
    try {
      setSessions(await listLocalSessions(userId, 30));
    } catch {
      // Offline is not an error state here — the local list already rendered.
    }
  }, [getToken, userId]);

  /**
   * Today's plan, re-read on focus so planning a day and coming straight back
   * shows it — the exact flow the Plan tab's calendar is for.
   */
  /**
   * Bumped on every plan read, and captured by each one. A read that resolves
   * after the day moved is dropped rather than rendered.
   *
   * Reachable by tapping the switcher's arrow twice quickly: three reads go out
   * per step, and the second step's can land before the first's, leaving
   * Thursday's plans under a heading reading Friday. The Plan tab hit the same
   * thing with its week arrows and solved it the same way — see `readSeq`
   * there. This screen did not have the problem until the switcher gave it one.
   */
  const planSeq = useRef(0);

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

  const refreshPlan = useCallback(async () => {
    if (!userId) return;
    planSeq.current += 1;
    const seq = planSeq.current;
    const days = weekDays(new Date());
    const viewKey = dayString(addDays(new Date(), dayOffset));
    try {
      // The visible week for the calendar, and the viewed day separately —
      // stepping the switcher can leave the current week entirely, and the
      // calendar underneath must keep showing the week it is labelled with.
      // Two small reads against the same local table rather than one wide one
      // whose range depends on how far the athlete has stepped.
      const [week, viewed, cached] = await Promise.all([
        listPlannedBetween(userId, dayString(days[0]), dayString(days[6])),
        listPlannedBetween(userId, viewKey, viewKey),
        cachedWorkouts(userId),
      ]);
      if (seq !== planSeq.current) return;
      setWeekPlan(week);
      const named = (p: PlannedSession) => ({
        ...p,
        // Null when the plan names a template the cache no longer has. The
        // card then renders the discipline alone, which is still true.
        workoutName: cached.find((w) => w.id === p.workoutId)?.name ?? null,
      });
      setViewPlans(viewed.map(named));
    } catch {
      // A plan that can't be read is a quieter screen, not a broken one — the
      // unplanned state below is a safe thing to show.
    }
  }, [userId, dayOffset]);

  /**
   * Start what was planned.
   *
   * Routes on the SAME predicate as everything else that opens a session
   * (`logsAfterwards`): a discipline that logs after the fact cannot hold a
   * set, so sending it to the live set logger gives it a screen it can never
   * fill. The workout id rides along so the chooser doesn't reappear for a
   * day whose template is already decided.
   */
  // Re-read the local list whenever a sync finishes. Without this the list is
  // only as fresh as the last focus, so a session logged on the web appeared
  // one focus late — and the sync this screen triggers on focus never showed
  // its own results.
  //
  // The plan is re-read alongside it, for exactly the same reason and now with
  // a second source: a day planned on the web arrives through the plan pull,
  // and this lead card is the whole point of that trip. Declared after
  // `refreshPlan` rather than beside its sibling effects — a `useCallback` is
  // a `const`, so referencing it earlier is a temporal-dead-zone error.
  useEffect(() => {
    if (!userId || lastSyncAt === null) return;
    let alive = true;
    listLocalSessions(userId, 30)
      .then((rows) => {
        if (alive) setSessions(rows);
      })
      .catch(() => {});
    refreshPlan();
    // The roadmaps too, and this is N122. A BJJ reflection is written into
    // SQLite and pushed by the outbox, so the tags that advance a roadmap
    // reach the server strictly AFTER `finish()` calls `requestSync` and
    // navigates away. The focus effect below refetched `/curricula/working`
    // at that moment — before the push — and then never again, so an athlete
    // who logged a technique their roadmap names watched the figure stay put
    // and reasonably concluded nothing had counted. Sessions and the plan
    // were already re-read here for exactly this reason; the roadmaps were
    // the one live-server read left out.
    refreshRoadmaps();
    return () => {
      alive = false;
    };
  }, [lastSyncAt, userId, refreshPlan, refreshRoadmaps]);

  const startPlanned = useCallback(
    (p: { sport: string; workoutId: string | null }) => {
      // The branch itself lives in `lib/startSession.ts` — the Train tab makes
      // the same decision, and two copies of it is how a technique-shaped
      // discipline ends up in the set logger on one surface and not the other.
      router.push(startSessionHref(p, modules));
    },
    [modules, router],
  );

  // On focus rather than on mount: coming back from a session should show its
  // new numbers, not the list as it was when the tab first rendered.
  //
  // `now` is refreshed here too, and that is not cosmetic. A tab screen stays
  // mounted for the life of the process, so without this the date is frozen at
  // whenever the app first launched — use it on Sunday evening, reopen it on
  // Monday, and the header still says Sunday while `startOfWeek` anchors to
  // *last* Monday, reporting last week's training as this week's.
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [checkinsLoaded, setCheckinsLoaded] = useState(false);

  // Fuel. Read locally first, exactly like the day screen: the card must be
  // right with no signal, because the log it reports is written offline.
  const [foodEaten, setFoodEaten] = useState<EatenView>({ state: 'loading' });
  // Null until the read answers, so the card can say nothing rather than say
  // "0 of 7" — which would be a claim about the athlete's week made from a
  // query that has not run.
  const [foodView, setFoodView] = useState<TargetView>({ state: 'checking' });
  const [foodQuick, setFoodQuick] = useState<Food[]>([]);

  /**
   * The week's logged FOOD days, as day keys.
   *
   * WHICH days, not how many. A count cannot be turned back into a set, and
   * both the week strip and the `LOGGING` dots need the individual days.
   *
   * `null` until read — never an empty set, which would draw seven empty dots
   * as though the week were known and blank.
   *
   * This replaced a separate rolling-seven-day COUNT that used to feed the
   * nutrition card. Two counts over two different spans were rendered a few
   * hundred points apart on one screen — `0 of 5` on the strip and `0 of 7`
   * below it — which is the W2/W4 shape: one question, two answers. Seen on a
   * device, which is the only place it was ever going to be obvious.
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

  const refreshFood = useCallback(() => {
    let live = true;
    const today = dayString(new Date());
    const slot = slotForClock(new Date());

    (userId ? localEntries(userId, today) : Promise.resolve<Entry[]>([]))
      .then((rows) => {
        if (live) setFoodEaten(eatenFrom(rows));
      })
      .catch(() => {
        // Was `.catch(() => {})`, which left the list empty and rendered a
        // failed read as "nothing logged" — a claim the athlete ate nothing.
        // See `EatenView`.
        if (live) setFoodEaten({ state: 'unavailable' });
      });

    // The week's logged-day count. Its own read, because it spans seven days
    // and the entries read above is one — and a failure here leaves the count
    // absent rather than zero, for the same reason.
    // `null` for the signed-out branch, NOT an empty list. An empty list is a
    // query that never ran rendering as "nothing logged" — the confident zero
    // this whole file refuses, and a discouraging one. Found in review.
    // Widened to Monday..Sunday of the CURRENT week (N108), because the week
    // strip and the LOGGING dots both need the calendar week. One read, one
    // answer to "did I log on Tuesday" — a second would be a second answer.
    const week = weekDays(new Date());
    const spanFrom = dayString(
      new Date(Math.min(week[0].getTime(), addDays(new Date(), -6).getTime())),
    );
    const spanTo = dayString(week[6]) > today ? dayString(week[6]) : today;
    (userId
      ? localLoggedDays(userId, spanFrom, spanTo)
      : Promise.resolve<string[] | null>(null))
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

    // The one thing the phone cannot compute. Cache first, server second — and
    // a failed fetch leaves the cached answer standing rather than falling back
    // to "set a target", which would be a false claim about an athlete who set
    // one on web. See TargetView.
    // Sequenced rather than raced, same as the day screen: started in parallel
    // a slow cache read can land after a fast network answer and overwrite it.
    let answered = false;
    (userId ? localTargetView(userId, today) : Promise.resolve<TargetView>({ state: 'unknown' }))
      .catch((): TargetView => ({ state: 'unknown' }))
      .then((v) => {
        if (live && !answered) setFoodView(v);
        return listTargets(getToken, { from: today, to: today });
      })
      .then(async (ts) => {
        if (userId) await cacheTargets(userId, today, today, ts);
        if (!live) return;
        answered = true;
        const t = targetOn(ts, today);
        setFoodView(t ? { state: 'set', target: t } : { state: 'none' });
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [getToken, userId]);

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

  /** One tap from the card: log a serving of a ranked food, right now. */
  const quickLog = useCallback(
    async (food: Food) => {
      if (!userId) return;
      await logFood(userId, {
        eaten_on: dayString(new Date()),
        meal: slotForClock(new Date()),
        name: food.name,
        servings: 1,
        serving_label: food.serving_label,
        ...scale(food, 1),
        source_food_id: food.id,
      });
      requestSync('food logged');
      refreshFood();
    },
    [userId, refreshFood],
  );
  /**
   * Refreshed on FOCUS, not once on mount.
   *
   * This is a tab screen and stays mounted for the life of the process, so a
   * mount-only fetch meant the card still said "Check in" with yesterday's
   * trend after you had just weighed in and come back — and stayed that way
   * until the app was killed. That is the feature's primary daily loop. Raised
   * in review; the rest of this screen already refreshes on focus.
   */
  const refreshCheckins = useCallback(() => {
    let live = true;
    // `dayString`, NOT `toISOString().slice(0,10)` — that is the UTC date, so
    // west of Greenwich an evening weigh-in lands on tomorrow's row. This
    // screen already uses `dayString` twenty lines up; `lib/calendar.ts` exists
    // for exactly this. Raised in review.
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
        // never weighed in — two different sentences. Raised in review.
      })
      .finally(() => {
        if (live) setCheckinsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [getToken]);

  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      refreshSessions();
      refreshPlan();
      refreshCheckins();
      // Its cleanup is KEPT, unlike its neighbours'. Food is the one refresh on
      // this screen with a same-screen writer racing it — `quickLog` refreshes
      // again immediately after logging — so a slow read started at focus could
      // otherwise resolve last and paint over the row just added.
      const stopFood = refreshFood();
      // Same treatment as food, and for the same reason: this screen writes to
      // it (every tap re-reads the day), so a slow read started at focus could
      // otherwise resolve last and paint over a cup just added.
      const stopTrackers = refreshTrackers(todayKey);
      // On focus only, not on every day-step: the funnel is an aggregate over
      // every session ever logged and does not change because you looked at
      // Thursday.
      const stopSummary = refreshSummary();
      refreshFunnel();
      // On focus, not on mount: enrolling happens on a screen pushed over these
      // tabs, and Today stays mounted for the life of the process.
      refreshRoadmaps();
      // Settings can have changed any of these while this screen sat mounted.
      const stop = readSuggestionPrefs();
      return () => {
        stopFood?.();
        stopTrackers?.();
        stopSummary?.();
        stop?.();
      };
    }, [refreshSessions, refreshPlan, refreshFunnel, refreshRoadmaps, readSuggestionPrefs, refreshCheckins, refreshFood, refreshTrackers, refreshSummary, todayKey]),
  );

  // The same staleness arrives without a focus change when the app is
  // foregrounded on the tab it was left on — which is the common case for an
  // app you open to check what you did yesterday.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      setNow(new Date());
      refreshSessions();
    });
    return () => sub.remove();
  }, [refreshSessions]);

  // The newest unfinished session. Older unfinished ones stay in the list
  // below rather than vanishing — see `recent`.
  const { fontScale } = useWindowDimensions();
  const fabPad = fabClearance(fontScale);

  const active = useMemo(() => sessions.find((s) => !s.ended_at) ?? null, [sessions]);

  /**
   * Today's plans that have not been met yet — what the lead card offers.
   *
   * Derived rather than filtered where it is loaded, because it depends on two
   * things that arrive separately and change independently: the plan list, and
   * the sessions. Filtering inside the plan loader froze the answer at the
   * moment plans were read, so finishing a session left the card still saying
   * "BJJ · Start" for a class that had just been logged — the exact duplicate
   * this branch is about, in its second and louder form.
   */
  /**
   * The viewed day's plans that nothing has met yet.
   *
   * Matched against the viewed day's OWN rows. It used to be matched against
   * `weekPlan`, which covers only the current week — so stepping two weeks back
   * to a day that WAS trained left its plan looking unmet, and `isPast` renders
   * an unmet past plan as "Not logged". The screen asserted something false
   * about a day the athlete had trained.
   */
  const owed = useMemo(() => owedOn(sessions, viewPlans), [viewPlans, sessions]);

  const viewDay = useMemo(() => addDays(now, dayOffset), [now, dayOffset]);
  const isToday = dayOffset === 0;
  const isPast = dayOffset < 0;

  /**
   * What the switcher reads. TODAY when it is, the weekday and date otherwise —
   * the same rule as the Plan tab's label, and the only thing on this screen
   * saying you have stepped away from today.
   */
  const dayLabel = isToday
    ? 'TODAY'
    : viewDay
        .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
        .toUpperCase();

  /**
   * Eight weeks of days-trained for the strip under Recent.
   *
   * Off the same `sessions` array everything else here uses. That read is
   * capped, so a very heavy eight weeks can under-report the oldest bars — it
   * degrades by drawing a quieter past, never a busier one, which is the right
   * direction for a chart nobody should be reading as a record.
   */
  const trend = useMemo(() => weeklyDays(sessions, now, 8), [sessions, now]);

  /**
   * The one suggestion, and the offer that precedes it.
   *
   * Deliberately only on today. A suggestion is about what to do next, and
   * attaching it to a day you have stepped to would read as a claim about that
   * day. `funnel === null` means the read has not landed, which is neither of
   * the two states below.
   */
  /**
   * BJJ is the only discipline with a suggestion tier today, so the gate asks
   * about BJJ. When a second tier lands this becomes per-suggestion rather
   * than one call — the policy function already takes the sport for that
   * reason rather than answering a global yes/no.
   */
  const suggestionsOn = policy !== null && suggestionsAllowed(policy.master, policy.off, 'bjj');

  const suggestion = useMemo(
    () =>
      isToday && suggestionsOn && funnel && dismissed
        ? funnelGap(funnel, now, dismissed)
        : null,
    [isToday, suggestionsOn, funnel, now, dismissed],
  );

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
    if (!isToday || !suggestionsOn || !funnel || suggestion || offers === null) return false;
    const bjj = sessions.filter((x) => logsAfterwards(x.sport, modules)).length;
    return shouldOfferDetail(bjj, funnel.length, offers);
  }, [isToday, suggestionsOn, funnel, suggestion, sessions, modules, offers]);

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

  // A session left open overnight was almost certainly abandoned, not paused.
  // Past this the card stops pretending to be a running clock: a resume button
  // reading 506:24:12 is not information, and `formatElapsed` has no upper
  // bound to stop it getting there.
  const activeIsStale =
    active != null && now.getTime() - new Date(active.started_at).getTime() > STALE_SESSION_MS;

  // Tied to focus, not mount. Today stays mounted underneath the session
  // screen, so a mount-scoped interval would re-render and recompute the week
  // summary once a second for the entire workout — in the background, for
  // nothing. Keyed on the id rather than the object so a refresh returning an
  // equivalent session doesn't tear the timer down and rebuild it.
  const tickingId = activeIsStale ? null : (active?.id ?? null);
  useFocusEffect(
    useCallback(() => {
      if (!tickingId) return;
      const id = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(id);
    }, [tickingId]),
  );

  // Local, for the reason the old `summariseWeek` recorded and this inherits:
  // Today has to answer on a gym floor with no signal, and a summary that
  // blanks out offline is worse than none. It also cannot disagree with the
  // calendar directly beneath it, which a separately-fetched rollup would.
  const review = useMemo(() => reviewWeek(sessions, weekPlan, now), [sessions, weekPlan, now]);

  /**
   * This week's theme, if there is one.
   *
   * Network-only and deliberately not cached: a theme is one short string that
   * changes weekly, so a stale one is worse than none — it would tell somebody
   * their block is about guard retention a fortnight after they moved on. It
   * degrades to absent offline, which is the honest answer.
   */
  /**
   * The body check-in, and the phase it is measured against.
   *
   * Fetched here rather than inside the card so the card stays a pure render —
   * the same shape every other Today block uses. A failure costs the card and
   * nothing else: a missing weigh-in must not take the screen down.
   *
   * The window is 30 days because the trend needs 7 and the rate needs 14 with
   * a full window at each end; 30 covers both with room for gaps.
   */

  const [theme, setTheme] = useState<Theme | null>(null);
  const weekStartKey = dayString(startOfWeek(now));
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
  // Everything except the card above, finished or not. Filtering to
  // `ended_at` here would make a *second* unfinished session invisible on the
  // phone entirely — not the resume card, not the list — while it kept
  // counting toward the week summary, so the header would say "3 sessions"
  // above a list of two. Two open sessions is reachable: the workout screen
  // starts one with no active-session guard, and so does web.
  const recent = useMemo(
    () => sessions.filter((s) => s.id !== active?.id).slice(0, 4),
    [sessions, active],
  );

  const onRetrySync = useCallback(async () => {
    if (syncing || !userId) return;
    setSyncing(true);
    setSyncError(null);
    try {
      // `syncSessions` reports failures in its return value rather than
      // throwing, so the result has to be read. Discarding it made Retry a
      // button that could spin and silently achieve nothing forever — a
      // session the server permanently refuses would sit at "1 waiting to
      // sync" with no way to find out why. "The count is the honest signal"
      // is only true of transient failures.
      // syncNow, not request: a person pressed this, so it must always
      // attempt rather than being told now is not the moment — and it
      // resolves with the outcome so the button can report it instead of
      // spinning and silently achieving nothing.
      const result = await syncNow();
      setSessions(await listLocalSessions(userId, 30));
      if (result.lastError) setSyncError(result.lastError);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [getToken, syncing, userId]);

  /**
   * "Week in review" scrolls to the `WeekReview` card on this screen.
   *
   * Two offsets, not one: `onLayout` reports a child's `y` relative to its
   * PARENT, and the card sits inside `styles.body`, which itself sits below the
   * header inside the scroll container. Using the card's `y` alone would land
   * short by the height of everything above `body`.
   *
   * Both default to 0 and the press is a no-op until they are measured, which
   * is one frame — a scroll to the wrong place is worse than a scroll that has
   * not happened yet.
   */
  const scrollRef = useRef<ScrollView>(null);
  const bodyY = useRef(0);
  const weekReviewY = useRef<number | null>(null);
  const scrollToWeekReview = useCallback(() => {
    if (weekReviewY.current === null) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, bodyY.current + weekReviewY.current - 12),
      animated: true,
    });
  }, []);

  return (
    <RNView style={styles.screen}>
    <ScrollView
      ref={scrollRef}
      // The pill's clearance only when there is a pill; otherwise it is 64pt of
      // dead space under the last row.
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

      <View
        style={styles.body}
        onLayout={(e) => {
          bodyY.current = e.nativeEvent.layout.y;
        }}
      >
        {/*
          The week strip (N108). It sits ABOVE the day switcher deliberately:
          the strip is the week, the switcher steps a day inside it, and the
          reference puts the week first.

          `logged` is FOOD days. That is a choice the strip does not make for
          itself — it takes a set — and it is flagged on the PR as a question,
          because "logged" could equally mean a training session. Food is the
          reading that matches the `LOGGING` card at the foot, so the two agree.
        */}
        <WeekStrip
          now={now}
          days={weekDays(now)}
          logged={loggedView}
          // Scrolls to the `WeekReview` card FURTHER DOWN THIS SCREEN, which is
          // what "Week in review" actually names. It used to push
          // `/(tabs)/goals`, whose header reads "Your target" — a link whose
          // label and destination described different things.
          onWeekInReview={scrollToWeekReview}
          testID="today-week-strip"
        />

        {/*
          Steps the day the Upcoming block below describes. Before this the
          screen could only ever answer "what is on today", so the answer to
          "am I training Thursday" was in another tab.

          The label doubles as the way back: on any other day it is a button
          reading that day's date, and pressing it returns to today. On today
          it is a readout, because a control that does nothing is worse than no
          control. Same component as the Plan tab's week — see PeriodSwitcher.
        */}
        {/* Hidden while a session is open, because the only thing it drives —
            the Upcoming block — is replaced by the resume card below. Left
            visible it was a control that moved the date line and nothing else,
            which is the same defect the label's own `onPress` guard avoids. */}
        {!active && (
        <PeriodSwitcher
          label={dayLabel}
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

        <Text style={styles.date}>
          {isToday || active
            ? todayLabel(now)
            : viewDay.toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
        </Text>

        {sessionError && (
          <Text
            style={styles.errorText}
            accessibilityLiveRegion="polite"
            testID="session-list-error"
          >
            {sessionError}
          </Text>
        )}

        {/* An unfinished session outranks everything else here. It is the only
            thing on the screen with a clock running, and it used to sit inside
            a list wearing a small "in progress" label — which made the one
            urgent thing look exactly like the four finished ones. */}
        {active ? (
          <Pressable
            style={[
              styles.resumeCard,
              { borderColor: accent.accent },
              activeIsStale && styles.resumeCardStale,
            ]}
            onPress={() => router.push(sessionHref(active, modules))}
            accessibilityRole="button"
            // Deliberately excludes the ticking time. A 1 Hz live region would
            // be hostile, but the label overrides the children entirely, so a
            // screen-reader user would otherwise get no progress at all —
            // hence the coarse, stable facts instead.
            accessibilityLabel={
              activeIsStale
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
              style={[
                styles.resumeEyebrow,
                { color: accent.ink },
                activeIsStale && styles.resumeEyebrowStale,
              ]}
            >
              {activeIsStale ? 'UNFINISHED' : 'IN PROGRESS'}
            </Text>
            <Text style={styles.resumeTitle}>{active.name || active.sport}</Text>
            {/* Chips rather than a dot-joined string, matching the session
                cards below — the running clock is the most important number
                on this screen and it should not have to be read out of a
                sentence. Icons are decoration here: the Pressable's own
                accessibilityLabel replaces all of this for a screen reader. */}
            <View style={styles.resumeMetaRow}>
              <View style={styles.chip}>
                <Icon
                  name={activeIsStale ? 'calendar' : 'timer'}
                  size={13}
                  color={vola.textMuted}
                />
                <Text style={styles.resumeMeta}>
                  {activeIsStale
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
                    {workingSets(active)}{' '}
                    {workingSets(active) === 1 ? 'working set' : 'working sets'}
                  </Text>
                </View>
              )}
            </View>
            <View style={[styles.resumeAction, activeIsStale && styles.resumeActionStale]}>
              <Text
                style={[styles.resumeActionText, activeIsStale && styles.resumeActionTextStale]}
              >
                {activeIsStale ? 'Finish or discard' : 'Continue'}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View style={styles.startBlock}>
            {/*
              What today is FOR, before what you could do about it.

              This replaced a stack of full-width filled buttons — one shouted
              imperative per enabled discipline ("Start Strength", then "BJJ")
              — which is a menu dressed as a primary action, and which got
              louder the more disciplines an athlete turned on. The plan leads
              now; starting something unplanned is still one press away, just
              no longer the first thing the screen says.
            */}
            <SectionHeader label={isPast ? 'That day' : 'Upcoming'} />

            {/*
              INSIDE Upcoming and above the plan cards, because a roadmap is
              the same kind of thing they are: something the athlete decided in
              advance. It is deliberately NOT beside the suggestion below —
              that one is inference over evidence, this is a commitment, and
              the design doc is explicit that conflating them turns a
              curriculum into a prescription.

              Only on today. A roadmap is not a fact about the Thursday you
              stepped back to.

              TWO STATES, ONE SLOT — N96. On a roadmap, this is where the
              progress line goes; on none, it is where the offer goes. That is
              the fix: the only surface that ever offered an un-enrolled
              roadmap was a horizontal strip below the week grid on the Plan
              tab, so an athlete who had never taken one on saw nothing about
              roadmaps anywhere they actually looked. See `lib/roadmapEntry.ts`
              for the full diagnosis.

              `roadmaps === null` renders NEITHER, and that is the whole reason
              `refreshRoadmaps` refuses to `setRoadmaps([])` on a failed read:
              an unknown list is not "you are on no roadmap", and offering one
              on the strength of an offline read would quietly retract
              something the athlete committed to.

              Gated on a discipline whose catalog is TECHNIQUES, never on
              `key === 'bjj'` — the same predicate the Plan tab and the Library
              ask. With it off there is nothing to offer, and `CurriculaStrip`
              already owns the "turn it back on" case (N61).
            */}
            {isToday &&
              roadmaps !== null &&
              (roadmaps.length > 0 ? (
                roadmaps.map((c) => <RoadmapLine key={c.id} curriculum={c} />)
              ) : moduleWithCatalog(modules, 'techniques') ? (
                <RoadmapOffer />
              ) : null)}

            {owed.length > 0 ? (
              owed.map((p) => (
                /*
                  UP NEXT, one row per owed plan.

                  Reshaped onto `UpNextCard` (N108). Two things the reference
                  shows are deliberately NOT rendered here:

                  - **a clock time.** `PlannedSession` has a `day` and no time
                    at all, so `Today • 7:00 PM` is data this app does not hold.
                    The day is what it knows and the day is what it says.
                  - **the belt hero.** It lived on this card and is dropped with
                    the reshape rather than kept as texture behind a tighter
                    row; `usesBelt` still governs it wherever it returns.

                  The past-day behaviour is preserved exactly: no press target,
                  `accessibilityRole="text"`, and the state said in WORDS rather
                  than by dimming — a blanket opacity took "Not logged" to
                  1.96:1, which is the measurement that comment records.
                */
                <UpNextCard
                  key={p.id}
                  sport={p.sport}
                  title={p.workoutName ?? `${labelFor(modules, p.sport)} session`}
                  when={isToday ? 'Today' : dayLabel}
                  past={isPast}
                  pastLabel="Not logged"
                  logLabel={logsAfterwards(p.sport, modules) ? 'Log' : 'Start'}
                  onLog={() => startPlanned(p)}
                  onOpen={() => startPlanned(p)}
                  accessibilityLabel={
                    isPast
                      ? `${p.workoutName ?? labelFor(modules, p.sport)}, planned and not logged`
                      : `Start ${p.workoutName ?? labelFor(modules, p.sport)}, planned for ${
                          isToday ? 'today' : dayLabel.toLowerCase()
                        }`
                  }
                  testID={`today-plan-${p.id}`}
                />
              ))
            ) : viewPlans.length > 0 ? (
              /*
                Planned, and all of it done. Distinct from having planned
                nothing, and the distinction is the whole point: before this
                the screen said "Nothing planned for today" the moment you
                finished your last session, which is the one sentence that is
                flatly untrue at that exact moment.
              */
              <View style={styles.planDone} testID="today-all-done">
                <View style={styles.planMain}>
                  <Text style={styles.planDoneTitle}>
                    {isPast ? 'Everything planned was logged.' : 'That is everything planned.'}
                  </Text>
                  <Text style={styles.planEmptyMeta}>
                    {viewPlans.length === 1
                      ? '1 session'
                      : `${viewPlans.length} sessions`}{' '}
                    logged against the plan.
                  </Text>
                </View>
              </View>
            ) : (
              // Says what is true and offers the fix, rather than leaving a gap
              // that reads as a screen that failed to load.
              <Pressable
                style={({ pressed }) => [styles.planEmpty, pressed && styles.planCardPressed]}
                onPress={() => router.push('/(tabs)/workouts')}
                accessibilityRole="button"
                accessibilityLabel={
                  isPast
                    ? `${restLine(viewDay)} Nothing was planned, and nothing logged.`
                    : `${restLine(viewDay)} Open Plan to schedule something.`
                }
                testID="today-unplanned"
              >
                <View style={styles.planMain}>
                  {/* Circulated by date rather than picked at random — the same
                      day always says the same thing. See `lib/trend.ts` for why
                      none of these congratulate or scold. */}
                  <Text style={styles.planEmptyTitle}>{restLine(viewDay)}</Text>
                  <Text style={styles.planEmptyMeta}>
                    {isPast
                      ? 'Nothing was planned, and nothing logged.'
                      : 'Plan one here — or log an unplanned session with New log.'}
                  </Text>
                </View>
                <Icon name="chevron" size={16} color={vola.textDim} />
              </Pressable>
            )}

            {/*
              One suggestion, under the plan rather than above it.

              What you meant to do today outranks what the app noticed about
              last month — and a suggestion that pushed the plan down the
              screen would be the app talking over the athlete. At most one:
              three would be a report, and the point is to change one thing
              about the next session.

              It shows its own evidence rather than asserting. "Drilled 9 times
              across 3 sessions, never live" is checkable; "work on your arm
              drag" is a verdict, and the recorded design rules out
              self-assessment for the same reason.
            */}
            {suggestion && (
              <Pressable
                style={({ pressed }) => [styles.suggestion, pressed && styles.planCardPressed]}
                onPress={() => router.push(`/technique/${suggestion.techniqueId}`)}
                accessibilityRole="button"
                accessibilityLabel={`Suggestion: try ${suggestion.name} live. Drilled in ${suggestion.drilled} sessions and never logged live. Open the technique.`}
                // The x below is a Pressable INSIDE this one, and UIKit does
                // not descend into a view that is itself an accessibility
                // element — so its label and hint are never announced, and
                // neither VoiceOver nor Voice Control can invoke it. A rotor
                // action on the card is the way out: it keeps the card one
                // swipe for a screen-reader user and leaves the visible x for
                // everyone else.
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
                      which is the same fact twice: the wizard writes `drilled`
                      once per session, so the two columns are equal. And the
                      claim is about the record, not about the athlete — the
                      app cannot see a round it was not told about. */}
                  <Text style={styles.suggestionMeta}>
                    Drilled in {suggestion.drilled} sessions, never logged live
                  </Text>
                </View>
                {/*
                  An explicit dismiss, not the long-press this app uses to
                  remove a planned session. Long-press is right for a row the
                  athlete deliberately created and is deleting; this is
                  unsolicited, and the moment anyone wants it gone is the
                  moment they should not have to discover how. It replaces the
                  chevron rather than joining it: the chevron said "this
                  opens", which the card already implies, and two glyphs on a
                  small card would make the destructive one the quieter.
                */}
                <Pressable
                  onPress={() => dismiss(suggestion.techniqueId)}
                  // Asymmetric. A symmetric 12 swallowed the whole 12pt gap
                  // between the meta line and the glyph, so a tap at the right
                  // edge of the evidence text dismissed the card rather than
                  // opening it — an invisible destructive target abutting a
                  // harmless one.
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

            {/*
              Tier 0: the only prompt that CREATES the evidence the rest read.

              Bounded on both sides — not on the first session, because one is
              not a habit, and never past the fourth, because by then the
              athlete has heard it and is choosing. A prompt that repeats
              forever is the shame the UX direction rules out, however politely
              it is worded.
            */}
            {offerDetail && (
              <Pressable
                style={({ pressed }) => [styles.suggestion, pressed && styles.planCardPressed]}
                // The reflection wizard is where detail is added; the library
                // is a catalog. Sending them to the catalog contradicted the
                // copy, so this goes to Plan, where the week and its sessions
                // are.
                onPress={() => router.push('/(tabs)/workouts')}
                accessibilityRole="button"
                // Leads with the visible title — WCAG 2.5.3. Named only by the
                // sentence version, "tap Add what happened in rolling" did
                // nothing under Voice Control, and the label never said what
                // pressing it does.
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

            {/* Every discipline off is a reachable state — nothing stops a
                user turning them all off — and the block rendered nothing at
                all, which reads as a broken screen rather than a choice. */}
            {startable.length === 0 && (
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
          </View>
        )}

        {/* Momentum, not analytics. The You tab owns the real history surface;
            this is the week put where it can be read at a glance — collapsed
            by default, opening to the week and then to the month only when
            asked for. */}
        <TrainingCalendar
          now={now}
          userId={userId ?? null}
          sessions={sessions}
          planned={weekPlan}
          modules={modules}
          units={units}
          onOpenSession={(s) => router.push(sessionHref(s, modules))}
        />

        {/*
          What this week is for, if the athlete said.

          Read-only here — themes are authored on web, per the platform rule
          that planning is a desk activity. It sits directly above the week's
          numbers because that is the pairing: the intent, then what actually
          happened against it.

          Absent when there is no theme. A permanent "no theme set" row would be
          the app asking for homework.
        */}
        {theme && (
          <View style={styles.themeCard} testID="week-theme">
            <Text style={styles.themeLabel}>This week</Text>
            <Text style={styles.themeTitle}>{theme.title}</Text>
            {theme.notes !== '' && <Text style={styles.themeNotes}>{theme.notes}</Text>}
          </View>
        )}

        {/* The check-in, above the week's readout: it is the one block here
            that asks for something rather than reporting. */}
        {/*
          PROGRESS (N108), replacing `CheckinCard` in place.

          A replacement rather than an addition: both render the weight trend,
          and two cards on one screen answering the same question with different
          arithmetic is the W2/W4 shape this repo has already shipped twice.
        */}
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

        {/* TRAINING and LOGGING, the two small cards at the foot of the
            reference. Placed here rather than at the very bottom so the
            reporting blocks stay together. */}
        {/* LOGGING only exists where a food log does. Without one, TRAINING
            takes the row on its own rather than sitting beside a card that
            reports on a feature this deployment does not have. */}
        <MiniCardRow>
          <TrainingCard
            training={training}
            onPress={() => router.push('/(tabs)/workouts')}
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

        {/* Fuel sits beside the check-in because both ASK for something rather
            than reporting, and the two belong together above the blocks that
            only report. Two numbers and nothing else: remaining calories and
            remaining protein. */}
        {foodEnabled ? (
          <MomentumCard
            eaten={foodEaten}
            view={foodView}
            rings={rings ?? DEFAULT_RINGS}
            quickAdd={foodQuick}
            onLog={() => router.push('/food/add')}
            onQuickAdd={(f) => void quickLog(f)}
            onOpenDay={() => router.push('/food')}
            onConfigureRings={() => router.push('/food/rings')}
            testID="today-momentum"
          />
        ) : (
          /* N61's last surface, and the one the first audit missed — it fell
             between two rows that each looked like they covered it: the tabs
             row is about the tab BAR, and the Today row said a disabled SPORT,
             which nutrition is not (`is_sport: false`).

             DASHED, not a card, and that is the point rather than decoration.
             The other N61 placeholders (Library, the Plan strip) are solid
             cards; the rule is the POSITION rather than the screen — a
             placeholder standing where content would stand is dashed, one
             standing beside content is a card.
             Today's own precedent for "this is off, go turn it on" is the
             dashed "Choose what you train" button below, and a solid card in
             the Fuel slot would read as content — an athlete would take it for
             the thing rather than for its absence. A placeholder should look
             like a placeholder.

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
          names later.

          Above WeekReview and below NutritionCard, in the band of cards that
          ASK for something rather than the band that only reports. Being on
          Today is the whole feature: a tracker you have to go and find is a
          tracker you forget, which is the sentence the ticket opens with.

          Pinned to `todayKey` rather than the day stepper's `date`: a tap logs
          a cup NOW, and offering the row on a day the athlete is merely reading
          would make it possible to log water into last Tuesday by accident.
          Reading a past day's trackers is a Food-screen job, where the day is
          the subject rather than a lens.
        */}
        <TrackerList
          day={trackerDay}
          // Read at the MOMENT of the tap, not at render. `todayKey` is computed
          // during render and this screen never unmounts, so a phone left open
          // across midnight still holds yesterday's key until something
          // re-renders — and the first tap at 00:05 would file a cup under the
          // day that just ended. Found in review; the 23:58 case was covered and
          // this, its mirror, was not.
          dayAtTap={() => dayString(new Date())}
          units={units}
          unitsReady={unitsReady}
          // Three, then a disclosure row — N78's answer to "several trackers on
          // Today do not crowd out what Today is for". The server caps an
          // athlete at eight; three is what fits here without pushing the
          // session, the readiness and the week below the fold. Which three is
          // the athlete's own choice, which is why reorder is part of the same
          // ticket. Food renders all of them: that is where trackers live.
          collapseAfter={3}
          // Expanding is a decision about TODAY. Today never unmounts, so
          // without a key the first tap on "2 more" would leave the list
          // expanded for every day after it.
          collapseKey={todayKey}
          testID="today-trackers"
        />

        {/*
          The week, summed up — what happened, against what was meant to, and
          which way it moved.

          This replaced a bare three-stat row. The figures are the same ones
          (`Stat` still renders them, discs and all); what it adds is the
          comparison, the per-discipline split and the plan. A count of sessions
          says nothing on its own, and one tonnage figure hides whether the week
          was three lifts or three classes.
        */}
        <RNView
          onLayout={(e) => {
            weekReviewY.current = e.nativeEvent.layout.y;
          }}
        >
          <WeekReview
            review={review}
            modules={modules}
            units={units}
            unitsReady={unitsReady}
          />
        </RNView>

        {recent.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Recent" />
            {recent.map((s) => (
              <SessionCard
                key={s.id}
                name={s.name || s.sport}
                sport={labelFor(modules, s.sport)}
                sportKey={s.sport}
                when={shortDay(s.started_at)}
                metrics={sessionMetrics(s, modules, units)}
                complete={!!s.ended_at}
                onPress={() => router.push(sessionHref(s, modules))}
                // Folds the meta line in, because the label replaces the
                // children rather than adding to them.
                accessibilityLabel={`${s.name || s.sport} session, ${describeSession(s, modules)}`}
                testID={`session-${s.id}`}
              />
            ))}
          </View>
        )}

        {/* Under Recent, which answers "what did I just do". This answers
            "have I been showing up", which is the question a list cannot
            answer and the only one worth putting on a screen whose job is to
            get you to the gym. Gated on having trained at all: eight empty
            columns is a chart telling a new athlete they have failed. */}
        {trend.some((w) => w.days > 0) && (
          <View style={styles.section}>
            <SectionHeader label="Last 8 weeks" />
            <TrendStrip weeks={trend} testID="today-trend" />
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
              {syncing ? <ActivityIndicator /> : <Text style={[styles.retryText, { color: accent.ink }]}>Retry</Text>}
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

        {/* Gated on `loaded` so this can only claim "nothing yet" after a read
            actually succeeded — the same invariant the profile and records
            screens now hold. An empty state is a statement about the athlete,
            and it has to be earned. */}
        {loaded && sessions.length === 0 && !sessionError && (
          <Text style={styles.empty} testID="today-empty">
            Nothing logged yet. Start a session and it shows up here.
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

      Floating puts it where a primary action goes on a phone, in reach of a
      thumb, and takes it out of the reading order at the top entirely. The
      clearance below matches the workouts tab's, for the same reason: a pill
      over a scrolling list has to stop covering the last row.
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
        {/* One line, always — at the largest accessibility sizes a second line
            makes the pill tall enough to cover the list again, which is the
            bug the clearance exists to prevent. */}
        <Text numberOfLines={1} style={[styles.fabText, { color: accent.on }]}>
          New log
        </Text>
      </Pressable>
    )}
    </RNView>
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
  // different heights would jump 16pt as you switched tabs, which is the
  // "two conventions" this is trying not to be — the first cut had exactly
  // that, at `TAB_BAR_CLEARANCE + 4` against the other's 16.
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
    // NO GLOW (N108). This pill used to carry an accent-coloured bloom, set up
    // by `accentGlow` supplying the colour and the four properties below
    // supplying the geometry. The user has said twice that they do not want
    // haze anywhere on this screen, so BOTH halves are gone.
    //
    // Removing the `accentGlow` call alone would not have done it: `shadowColor`
    // defaults to BLACK, and Android draws `elevation` regardless of colour —
    // so the pill would have kept a grey drop shadow and looked like a bug
    // rather than a decision.
  },
  fabPressed: { opacity: 0.85 },
  fabText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  body: { paddingHorizontal: 20, gap: 16 },
  date: { color: vola.textMuted, fontSize: 13, marginTop: -4 },

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

  startBlock: { gap: 8 },

  // A planned day that has been and gone. Dimmed rather than removed: the plan
  // is still the record of what was meant, and hiding it would make the week
  // read as if nothing had been intended.
  // `warn`, at full strength, because that is what "you missed this" means —
  // and because it has to carry the distinction between a missed plan and a
  // startable one on its own now that the card is not dimmed.
  planMissed: { color: vola.warn, fontSize: 12, fontWeight: '700' },

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
  // be undone is not the fiddliest thing on the screen. `textMuted` at 6.85:1
  // rather than `textDim` at 3.67:1 — it is a control, not decoration.
  dismiss: { padding: 6, marginRight: -6, borderRadius: 14 },
  // Opacity, not the plan card's square fill — a hard 27pt square flashing
  // inside a 14pt-radius card reads as a rendering fault.
  dismissPressed: { opacity: 0.5 },

  // The planned day. A card rather than a filled button: it is a statement
  // about today that happens to be actionable, and the lime is spent on the
  // one word that is the action.
  planCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    overflow: 'hidden',
    paddingLeft: 0,
    paddingRight: 12,
    paddingVertical: 14,
  },
  planCardPressed: { backgroundColor: vola.surfaceHover },
  planRule: { width: 3, alignSelf: 'stretch', marginVertical: -14 },
  // Behind the content, off the right edge, and faint: it is texture. At full
  // strength it competes with the Log button, which is the one thing on this
  // card anyone is meant to press.
  // Centred, not bled off the right edge. `contain` rather than `cover`, so
  // the whole belt is in frame — a cropped one reads as a layout accident,
  // which is what it looked like when it was cut by the card's edge.
  planHero: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -14,
    bottom: -14,
    opacity: 0.22,
    zIndex: -1,
  },
  planMain: { flex: 1, gap: 2, marginLeft: 13 },
  // Colour set inline, from the discipline.
  planEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  planTitle: { fontSize: 18, fontWeight: '700' },
  planGo: { borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  planGoText: { fontWeight: '800', fontSize: 15 },

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
  // `startButton` above rather than NutritionCard — it marks an absence, and
  // a solid card here would read as the thing itself.
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

  errorText: { color: vola.danger, fontSize: 13 },
  empty: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
});
