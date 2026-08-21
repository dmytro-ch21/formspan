/**
 * Why you are eating this much.
 *
 * ## Rebuilt to a supplied reference (N106)
 *
 * The previous version of this screen was a stack of labelled rows and running
 * prose. The verdict on it was *"the design is terrible"*, and separately it was
 * reported as *"Goals is still infinite scrollable"*. #484 measured that second
 * complaint and found **no layout fault**: the scroll extent equals the content
 * to the pixel in every state, at default and at accessibility text sizes. The
 * length was the design's own — 1,662–2,179pt against a 666pt viewport
 * ordinarily, and 7,759–9,492pt at accessibility sizes, which is twelve to
 * fifteen screens of prose with nothing a reader can skip.
 *
 * So this is a rebuild to the reference rather than a restyle, and the
 * reference answers the length complaint by itself: **it is exactly one iPhone
 * viewport**, status bar to tab bar. What replaced the prose is not deletion —
 * every sentence that carried an argument is still reachable — but three
 * `InfoMark` sheets and two foldable sections, so the reasoning is *available*
 * rather than *always present*. That is #446's answer to the same shape of
 * problem, applied with the default left open; `CollapsibleSection` argues that
 * choice in full.
 *
 * ## Every line, or none of it
 *
 * A calorie target is an argument, and an argument you cannot inspect is a
 * verdict. The project's standing principle is auditable recommendations and
 * this is the surface where that gets paid for — so the ladder still shows
 * every step, a clamped rail is still stated out loud, and the derivation is
 * one tap from the number it produced rather than four viewports below it.
 *
 * ## It computes; accepting is a separate act
 *
 * The suggestion is never written on arrival. `Use this target` is the only
 * thing on this screen that stores a derived target, and it freezes this
 * arithmetic onto the row — so asking the same question in March gets March's
 * numbers back rather than a fresh derivation from a body that has since
 * changed. The card at the top is the only thing that reports what is actually
 * in force.
 *
 * ## Three ways a target gets its number, and this screen offers all three
 *
 *  - **derived** — the ladder, accepted with `Use this target`.
 *  - **adjustment** — a weekly correction from what your weight actually did,
 *    shown in full before you take it. N27; see `AdjustmentCard`.
 *  - **manual** — a number you typed. It has no arithmetic and the screen says
 *    so rather than inventing one. It now opens from **`Edit target`** in the
 *    authority card, which is the reference's own affordance and the right
 *    place for it: disagreeing with a figure belongs beside the figure, not
 *    under a separate heading below the whole derivation.
 *
 * **The card is the authority, and the ladder is not.** With one source that
 * distinction did not exist; with three it is the thing most worth getting
 * right, because a suggestion sitting under a heading like "Your target" is a
 * number nobody chose being read as the number in force.
 *
 * ## When it cannot
 *
 * An incomplete profile returns `suggestion: null` with the fields named. The
 * screen says which, and sends you to the form that fixes them. It does NOT
 * fall back to the estimated resting baseline: `energy`'s own doc puts that
 * 20–30% high, which on a target is roughly 400 kcal a day and a cut that never
 * happens, invisibly, forever.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ModuleOffNotice } from '@/components/ModuleOffNotice';
import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { WeightTrendCard } from '@/components/WeightTrendCard';
import { Text } from '@/components/Themed';
import { AdjustmentCard } from '@/components/nutrition/AdjustmentCard';
import { BreakdownLadder, type LadderRow } from '@/components/nutrition/BreakdownLadder';
import { MacroDonut } from '@/components/nutrition/MacroDonut';
import { ManualTarget } from '@/components/nutrition/ManualTarget';
import { MovementChoice } from '@/components/nutrition/MovementChoice';
import { TargetCard } from '@/components/nutrition/TargetCard';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { Icon } from '@/components/ui/Icon';
import { InfoMark } from '@/components/ui/InfoSheet';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  ACTIVITY_DEFAULT,
  activityParam,
  adoptServerActivity,
  cacheActivityLevel,
  isActivityLevel,
  readActivityChoice,
  rememberActivityChoice,
  settleActivityChoice,
  type ActivityLevel,
} from '@/lib/activityLevel';
import { ApiError } from '@/lib/apiError';
import { CONFIDENCE_DAYS, readConfidence, type Confidence } from '@/lib/confidence';
import { localLoggedDayKcal } from '@/lib/foodLog';
import { macroColor, macroRows, macroRowsFromTarget } from '@/lib/macroModel';
import { useModules } from '@/lib/ModulesProvider';
import { foodLogGate } from '@/lib/modules';
import { setActivityLevel } from '@/lib/profile';
import { addDays } from '@/lib/history';
import { PREF_GOALS_COLLAPSED, readPref, writePref } from '@/lib/prefs';
import { useAuthToken } from '@/lib/useAuthToken';
import { formatWeight, formatWeightRate, type UnitSystem } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';
import type { ManualDraft, ManualTargetInput } from '@/lib/manualTarget';
import { profileGap, todayString, type Target } from '@/lib/nutrition';
import {
  fetchAdjustment,
  listTargets,
  saveTarget,
  suggestedTarget,
  targetOn,
  type Adjustment,
  type AdjustmentResponse,
  type Projection,
  type Suggested,
} from '@/lib/nutritionApi';

/**
 * The NEAT-only vocabulary, and the reason it stops at "active".
 *
 * Textbook multipliers run to 1.9 with exercise folded in. Using one of those
 * and then adding logged sessions counts every mat class twice, so the ladder
 * here covers daily movement ONLY and training arrives as its own line.
 */
const ACTIVITIES = [
  { key: 'sedentary', label: 'Desk job', hint: 'Mostly sitting, little walking' },
  { key: 'light', label: 'On your feet', hint: 'Some walking through the day' },
  { key: 'active', label: 'Physical job', hint: 'Moving most of the day' },
] as const;

/** The pill labels by key, so the assumption can be NAMED in prose rather than
 *  leaving "we guessed something" as the whole message. */
const ACTIVITY_LABELS: Record<string, string> = Object.fromEntries(
  ACTIVITIES.map((a) => [a.key, a.label]),
);

/** Said once, written once — a receipt that reads differently to a screen
 *  reader than to the screen is two receipts. */
const SAVED_MESSAGE = 'Saved. Food measures the day against this from now on.';

/**
 * How far back the target history is read.
 *
 * The window is not "the targets in these dates" — `listTargets` carries in the
 * row live at its start, which is what makes a target set months ago the answer
 * to "what am I eating to" today. A year is arbitrary and generous; the
 * carry-in is what actually matters, and shortening this cannot lose the live
 * row.
 */
const HISTORY_DAYS = 365;

/** The one offline sentence, said the same way wherever a write fails. */
const OFFLINE_MESSAGE =
  'Could not save it — this one needs a connection. Nothing has changed; try again when you have signal.';

/**
 * The two foldable sections, and the one that starts folded.
 *
 * `breakdown` and `macros` are in the reference, so they open expanded — see
 * `CollapsibleSection` for why the fold is offered at all rather than being the
 * default. `weight` is **not** in the reference: the trend card (N56) predates
 * this design, and Today's own rebuild (#487) puts weight and its trend on the
 * home screen. Deleting it here is not this ticket's call, so it keeps its place
 * and starts folded — the rule being that a section the reference does not
 * contain does not get to spend a viewport on arrival.
 */
const SECTIONS = { breakdown: false, macros: false, weight: true } as const;
type SectionKey = keyof typeof SECTIONS;

/** The explanations behind the three ⓘ marks. */
const INFO = {
  movement: [
    'This is how much you move when you are NOT training — walking to the station, standing at work, carrying shopping. It is the single biggest thing separating two people of the same size, and it is worth more calories a day than most training sessions.',
    'Training is counted separately, on its own line in the breakdown, from the sessions you actually logged. That is why the choices here stop at "physical job" rather than running up to the textbook multipliers you may have seen: those already have exercise folded in, and using one here would count every mat class twice.',
    'Whichever you choose is kept on your account, so the web app works your target out the same way. If you pick one with no signal it is saved on this phone and reaches your account next time you are online.',
  ],
  breakdown: [
    'Every step from your body to your target, in order. Resting rate is what you would burn doing nothing at all; daily movement multiplies it; training adds what your logged sessions actually cost, spread evenly across the days they covered. Those three are maintenance — the number that holds your weight where it is.',
    'The last step is your phase. A cut subtracts, a bulk adds, and maintenance leaves it alone. The rate comes from the phase you set, not from this screen.',
    'If the arithmetic hits a safety rail it says so rather than quietly going further. A target that would take you below what your body needs is capped, and the cap is stated — the line is there so the last step visibly follows from the one above it.',
    'Nothing here is saved. This is what we would suggest; it becomes your target only when you tap the button at the bottom, and the workings are stored alongside it so this page still answers the question months from now.',
  ],
  macros: [
    'Protein and fat are set per kilogram of bodyweight, because that is what the evidence is expressed in — protein high enough to hold muscle while you are in a deficit, fat high enough for hormones and for food to be worth eating. Carbohydrate is whatever the calories leave once those two are paid for, which is why it moves most when your target moves.',
    'Fibre is a floor, not a ceiling. Going over it is fine and normal; the number is the least you want, not the most you are allowed.',
    'The ring is drawn by GRAMS, not by calories, and the pill above it says so. An energy ring would be the obvious alternative and would be wrong here: fibre is itself a carbohydrate, so the four figures do not divide the calories between them and some of them would be counted twice. By grams the ring is a picture of the four numbers beside it and of nothing else.',
    'If the calories are too few to cover the usual protein and fat, one of them gives way rather than the target quietly becoming impossible — and the screen names which.',
  ],
} as const;

/**
 * Why a save failed, in words that match what actually happened.
 *
 * **The distinction is the whole point, and getting it wrong is a dead end
 * dressed as weather.** Every write on this screen used to report the offline
 * sentence unconditionally, so an athlete who typed 700 kcal — a dropped digit
 * — got a permanent 400 from the server's 800–8,000 rail and was told to try
 * again when they had signal. It would fail identically forever, and the copy
 * sent them to look for a better connection.
 *
 * An `ApiError` means the server ANSWERED and refused: its message is written
 * for a human and is the most useful thing available, so it is shown. Anything
 * else — `OfflineError`, a dropped socket — means nothing was answered at all,
 * and only then is "try again when you have signal" true.
 */
function refusalOrWeather(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return OFFLINE_MESSAGE;
}

/** What the typed-target form opens on, given a target. */
function draftFrom(t: {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
}): ManualDraft {
  return {
    kcal: String(t.kcal),
    protein_g: String(t.protein_g),
    carb_g: String(t.carb_g),
    fat_g: String(t.fat_g),
    // Absent, not zero — seeding "0" would turn a target that never stated
    // fibre into one that claims none, on the athlete's next save.
    fibre_g: t.fibre_g == null ? '' : String(t.fibre_g),
  };
}

export default function TargetScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { units, unitsReady } = useUnits();

  // N61: this tab stays in the bar with nutrition off — see `(tabs)/_layout.tsx`
  // — so the screen has to say which module is off rather than deriving a
  // target for a feature the athlete has turned off. Shared with Food through
  // `foodLogGate`, whose `ready` half is what stops a cold start claiming
  // "turned off" from a module list nobody has read yet.
  const { modules, ready: modulesReady } = useModules();
  const { disabled: foodDisabled, off: foodOff } = foodLogGate(modules, modulesReady);

  const { userId } = useAuth();
  /**
   * How many times a pill has been pressed this session.
   *
   * Read only inside promise callbacks, never during render. Its single job is
   * to let an in-flight cache read notice that the athlete chose something
   * after it started, so a stale snapshot cannot revert a fresh tap.
   */
  const choiceSeq = useRef(0);
  /**
   * The daily-movement level, and how much authority this device has over it.
   *
   * **`null` means the cache has not been consulted yet**, which is distinct
   * from `{ level: null }` — a device that HAS looked and found the athlete has
   * never chosen. The derivation waits for the first; it renders an assumption
   * for the second.
   *
   * Three fields rather than the two `readActivityChoice` returns, because the
   * debt does two unrelated jobs and collapsing them costs a round trip:
   *
   *  - `pinned` decides whether to SEND the level as a query parameter. It goes
   *    true when the athlete presses a card, and is only cleared by a later
   *    focus re-reading the cache and finding nothing owed. Driving the
   *    parameter off `unsynced` instead would flip it back the instant a push
   *    succeeded, which changes the request and refetches the whole derivation
   *    a second time for an answer that cannot have moved.
   *  - `unsynced` is for the athlete: "this is on your phone, not your account
   *    yet". It clears the moment the push lands.
   */
  const [activity, setActivity] = useState<{
    level: ActivityLevel | null;
    pinned: boolean;
    unsynced: boolean;
  } | null>(null);
  const [data, setData] = useState<Suggested | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // What is actually in force, and the weekly proposal — both read from the
  // server, and both deliberately independent of the movement cards. Web
  // learned this the expensive way: sharing one loader with the suggestion made
  // every chip press refetch a year of targets and re-run the adjustment check,
  // neither of which a chip can affect.
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [adjustment, setAdjustment] = useState<AdjustmentResponse | null>(null);
  const [writing, setWriting] = useState<null | 'manual' | 'adjustment'>(null);
  // The MESSAGE travels with the failure, not just which write failed. A
  // boolean here is what forced every failure to share one sentence, which is
  // how a permanent server refusal came to be reported as a bad connection.
  const [writeFailed, setWriteFailed] = useState<{
    which: 'manual' | 'adjustment';
    message: string;
  } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  /**
   * Remount key for the typed-target form.
   *
   * The form seeds itself at mount and never again, which is what stops a late
   * fetch overwriting digits somebody is mid-way through typing. Bumping this
   * is therefore the ONLY way to reseed it — done when it is opened, and after
   * a save, so it opens on what is now in force rather than on what was.
   */
  const [manualSeq, setManualSeq] = useState(0);
  // Saved-in-place, because this screen is a TAB rather than something pushed
  // from Food. It used to `router.back()` on success, which was the whole
  // confirmation: the screen you were on returning IS the receipt. A tab has
  // nowhere to go back to, so the acknowledgement has to be said out loud here.
  const [saved, setSaved] = useState(false);
  // The day this screen is about, RE-READ ON EVERY FOCUS rather than computed
  // once at mount — see the focus effect below for why that distinction only
  // started to matter when this became a tab.
  const [on, setOn] = useState(todayString);

  /**
   * The last fortnight's logging, by day.
   *
   * `null` is "not read", which is NOT "nothing logged" — the confidence block
   * is simply not rendered until there is an answer, rather than briefly
   * claiming a zero. Same rule as `foodLogged` on Today, and it was raised in
   * review there: resolving `[]` for the signed-out branch produced a confident
   * "0 of 7 days logged", which is both false and discouraging.
   */
  const [logged, setLogged] = useState<{ day: string; kcal: number }[] | null>(null);

  /** Which sections are folded. `null` until the preference has been read, so
   *  nothing flashes open and then shut on arrival. */
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean> | null>(null);

  /**
   * Read the stored level back, ON EVERY FOCUS.
   *
   * **A tab mounts once and stays mounted for the life of the process**, so a
   * `useEffect` keyed on `[userId]` would run exactly once, ever — and this
   * screen's whole ticket is a value that has to survive leaving the tab. The
   * same mistake is already documented one file over: Today read its suggestion
   * preferences from a mount effect, and the Settings switches appeared to do
   * nothing until the app was killed.
   *
   * It also picks up a level chosen on ANOTHER device — the cache is refreshed
   * from the server by the derivation below, so coming back to this tab is what
   * makes the browser's answer appear here.
   *
   * The value is compared before being stored rather than set unconditionally.
   * `load` is keyed on what this produces, and a fresh object every focus would
   * change its identity, re-run the focus effect and ask the server twice for
   * one visit.
   */
  useFocusEffect(
    useCallback(() => {
      let live = true;
      // Bumped by every card press. Captured before the read so the resolution
      // can tell whether a tap landed while it was in flight: the read's
      // snapshot would then be older than what the athlete just chose, and
      // applying it reverts the card under their thumb for the rest of the
      // visit. One SQLite read is a narrow window, but it is not a closed one.
      const seq = choiceSeq.current;
      readActivityChoice(userId ?? '')
        .then(async (c) => {
          if (!live || seq !== choiceSeq.current) return;
          setActivity((prev) =>
            prev && prev.level === c.level && prev.pinned === c.owed && prev.unsynced === c.owed
              ? prev
              : { level: c.level, pinned: c.owed, unsynced: c.owed },
          );

          /**
           * Retry a push the account has never heard.
           *
           * **Without this the offline half of the feature does not exist.**
           * The only other `setActivityLevel` call is a card press, so a choice
           * made in a gym dead-spot would stay owed *forever* unless the
           * athlete happened to tap the same card again while online — and web
           * would go on deriving at the stale level indefinitely. The screen
           * even promises otherwise in as many words.
           *
           * `pinned` is deliberately left set. It is what keeps this visit's
           * derivation on the athlete's own level, and clearing it here would
           * change the query and refetch the ladder for an answer that cannot
           * have moved. The next focus clears it, having re-read a settled
           * cache.
           */
          if (!c.owed || !c.level || !userId) return;
          try {
            await setActivityLevel(getToken, c.level);
            await settleActivityChoice(userId, c.level).catch(() => {});
            if (!live || seq !== choiceSeq.current) return;
            setActivity((prev) => (prev?.level === c.level ? { ...prev, unsynced: false } : prev));
          } catch {
            // Still unreachable. The debt stands on disk and the next focus
            // tries again — which is the whole contract.
          }
        })
        .catch(() => {
          // The cache is unreadable — a corrupt database, or a signed-out
          // launch. Fall through to "never chosen" rather than blocking the
          // derivation forever: the server still knows, and the screen will
          // adopt its answer.
          if (live) setActivity((prev) => prev ?? { level: null, pinned: false, unsynced: false });
        });
      return () => {
        live = false;
      };
    }, [userId, getToken]),
  );

  /**
   * Keep the cache in step with whatever we have settled on.
   *
   * A plain effect rather than a write inside the fetch callback, because that
   * callback updates state through a FUNCTIONAL updater — React may invoke one
   * twice, and a database write is not something to run twice by accident.
   *
   * Skipped while a debt is outstanding: `cacheActivityLevel` writes without
   * `owed`, and although `writePref` preserves an existing debt rather than
   * clearing it, writing the server's value over a pending local choice would
   * still be wrong.
   */
  useEffect(() => {
    if (!userId || !activity || activity.unsynced || !activity.level) return;
    void cacheActivityLevel(userId, activity.level).catch(() => {});
  }, [userId, activity]);

  /**
   * Which sections this athlete has folded away.
   *
   * A mount effect rather than a focus effect, unlike everything else here: the
   * only thing that writes this key is this screen, so there is no other
   * surface whose change needs picking up on return. Re-reading on every focus
   * would fight the athlete's own toggle for no benefit.
   */
  useEffect(() => {
    let live = true;
    // Signed out: return WITHOUT setting anything. `collapsed` stays null and
    // the render falls through to `SECTIONS`, which is the same picture — and
    // it avoids a synchronous setState in an effect body, which is a warning
    // this app's lint ratchet counts. "Nothing to read" and "read, and nothing
    // was folded" happen to render identically here, so there is no state worth
    // storing to tell them apart.
    if (!userId) {
      return () => {
        live = false;
      };
    }
    readPref(userId, PREF_GOALS_COLLAPSED)
      .then((v) => {
        if (!live) return;
        // Absent means "never chosen" and takes the defaults. An empty STRING
        // means "chosen, and nothing is folded" — different facts, and `??`
        // rather than `||` is what keeps them different.
        const folded = v == null ? null : new Set(v.split(',').filter(Boolean));
        setCollapsed(
          folded
            ? (Object.fromEntries(
                (Object.keys(SECTIONS) as SectionKey[]).map((k) => [k, folded.has(k)]),
              ) as Record<SectionKey, boolean>)
            : { ...SECTIONS },
        );
      })
      .catch(() => {
        // Unreadable preferences must not cost the athlete the screen.
        if (live) setCollapsed({ ...SECTIONS });
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const toggleSection = useCallback(
    (key: SectionKey) => {
      setCollapsed((prev) => {
        const base = prev ?? { ...SECTIONS };
        const next = { ...base, [key]: !base[key] };
        if (userId) {
          const folded = (Object.keys(next) as SectionKey[]).filter((k) => next[k]);
          // Fire and forget: the toggle has to move under the thumb whether or
          // not the write lands, and a failed preference write is not something
          // to interrupt anybody about.
          void writePref(userId, PREF_GOALS_COLLAPSED, folded.join(',')).catch(() => {});
        }
        return next;
      });
    },
    [userId],
  );

  /**
   * What to send as `?activity=`, and whether we may ask at all.
   *
   * Extracted as PRIMITIVES rather than letting `load` depend on the `activity`
   * object, and that is load-bearing: adopting the server's answer produces a
   * new object but the same query, so keying on the object would refetch the
   * derivation every time it confirmed what we already had.
   */
  const activityReady = activity !== null;
  const activityQuery = activity
    ? activityParam({ level: activity.level, owed: activity.pinned })
    : undefined;

  const load = useCallback(() => {
    // Nothing to derive for a module that is off, and this is a server round
    // trip on every focus of a screen that is showing an explanation instead.
    if (foodDisabled) return;
    // Nothing until the cache has answered. Asking first would send no
    // parameter, adopt whatever the server said, and overwrite a choice made
    // offline a moment before the read landed.
    if (!activityReady) return;
    let live = true;
    // Both flags are set from the CALLBACKS, never synchronously here. A reset
    // on the way in is a setState during the effect — the rule the lint ratchet
    // holds — and it also flickers the previous answer away for a frame each
    // time the movement cards move.
    suggestedTarget(getToken, on, activityQuery)
      .then((d) => {
        if (!live) return;
        setData(d);
        setFailed(false);
        // The receipt belongs to the numbers that were saved, and these are
        // different numbers. Moving a movement card, or coming back to the tab
        // on a new day, produces a fresh and UNSAVED suggestion — leaving
        // "Saved" under it would attach a confirmation to something that was
        // never stored, which is worse than showing nothing at all.
        setSaved(false);
        // Take the server's word for the level, when we are not holding a
        // choice it has never heard. This is the ONLY path by which a level set
        // in the browser reaches this phone — and the identity check is what
        // stops a confirmation of what we already believed from re-running this
        // very fetch.
        setActivity((prev) => {
          if (!prev) return prev;
          const next = adoptServerActivity({ level: prev.level, owed: prev.pinned }, d);
          return next.level === prev.level ? prev : { ...prev, level: next.level };
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [foodDisabled, getToken, on, activityQuery, activityReady]);

  /**
   * FOCUS is the only trigger, and it is deliberately the only one.
   *
   * A pushed screen got this for free — `food/target.tsx` remounted on every
   * open. A tab mounts once, lazily, and then stays mounted for the life of the
   * process: without this it would show the weight, training load and phase it
   * read the first time it was ever opened.
   *
   * The date is the half that turns a stale read into a WRONG WRITE. `on` is
   * what `accept` files the target under, so an app left open past midnight
   * would save tomorrow's target against yesterday.
   */
  useFocusEffect(
    useCallback(() => {
      setOn(todayString());
      return load();
    }, [load]),
  );

  /**
   * What is in force, the weekly proposal, and the fortnight's logging.
   *
   * A SECOND focus effect rather than more work inside the first, and the
   * dependency list is the reason: `load` changes with the movement cards, so
   * folding these in would refetch a year of target history and re-run the
   * adjustment computation on every press — server round trips a card cannot
   * possibly affect, on a phone that may be on cellular. Web made exactly that
   * mistake and its review caught it.
   *
   * Neither failure is fatal to the screen, so neither gets an error banner:
   * the derivation still works, and a live-target row that cannot be read
   * simply says so. What it must NOT do is render a stale row as current, which
   * is why the state is a nullable rather than an empty array.
   */
  const loadLive = useCallback(() => {
    if (foodDisabled) return;
    let live = true;
    listTargets(getToken, { from: addDays(on, -HISTORY_DAYS), to: on })
      .then((t) => {
        if (live) setTargets(t);
      })
      .catch(() => {
        if (live) setTargets(null);
      });
    fetchAdjustment(getToken, on)
      .then((a) => {
        if (live) setAdjustment(a);
      })
      .catch(() => {
        // Silence, deliberately. The weekly check is an offer; an offer that
        // could not be fetched is nothing to report, and an error card here
        // would put a red box on a screen whose main job succeeded.
        if (live) setAdjustment(null);
      });
    // The fortnight is LOCAL — food entries live in SQLite and sync from there
    // — so this one works in a gym with no signal, unlike the two above.
    (userId
      ? localLoggedDayKcal(userId, addDays(on, -(CONFIDENCE_DAYS - 1)), on)
      : Promise.resolve<{ day: string; kcal: number }[] | null>(null))
      .then((rows) => {
        if (live) setLogged(rows);
      })
      .catch(() => {
        // Null, never `[]`. An unreadable database is not a fortnight of not
        // eating, and the confidence block renders nothing rather than a zero.
        if (live) setLogged(null);
      });
    return () => {
      live = false;
    };
  }, [foodDisabled, getToken, on, userId]);

  useFocusEffect(loadLive);

  /**
   * Record a level the athlete just picked.
   *
   * **Local first, then the account.** The card has to move under the thumb and
   * the ladder has to recompute whether or not there is any signal — this is a
   * gym — so the choice is written to the device and marked owed BEFORE the
   * push is attempted. Marking it owed only in the catch would lose the change
   * to a crash between the two.
   *
   * Never rejects. The caller is an `onPress`, and an escaping rejection is an
   * unhandled rejection.
   */
  const chooseActivity = useCallback(
    async (level: ActivityLevel) => {
      // Before any await, so a cache read already in flight sees it.
      choiceSeq.current += 1;
      setActivity({ level, pinned: true, unsynced: true });
      if (userId) {
        await rememberActivityChoice(userId, level).catch(() => {
          // In memory for this launch only. Nothing here can recover that, and
          // the push below may still succeed.
        });
      }
      try {
        await setActivityLevel(getToken, level);
        if (userId) await settleActivityChoice(userId, level).catch(() => {});
        setActivity((prev) => (prev?.level === level ? { ...prev, unsynced: false } : prev));
      } catch {
        // Offline, or refused. The debt is already on disk from the write
        // above; leaving `unsynced` set is what tells the athlete their phone
        // and their account currently disagree.
      }
    },
    [getToken, userId],
  );

  const live = targets ? targetOn(targets, on) : null;

  /**
   * The fortnight, read.
   *
   * The yardstick for "was that a whole day" is the target that was in force on
   * THAT day, which `targets` already holds — see `confidence.ts`. Memoised
   * because it walks fourteen days against a year of targets and neither input
   * changes while somebody scrolls.
   */
  const confidence: Confidence | null = useMemo(() => {
    if (!logged) return null;
    return readConfidence(logged, on, (day) =>
      targets ? (targetOn(targets, day)?.kcal ?? null) : null,
    );
  }, [logged, on, targets]);

  /**
   * The level the number below was actually derived at.
   *
   * Taken from the RESPONSE rather than from local state, so the cards and the
   * arithmetic can never describe different things — which is N93's reported
   * bug in its purest form. Falls back to the documented default only before
   * the first response arrives.
   */
  const derivedAt: ActivityLevel = isActivityLevel(data?.activity)
    ? data.activity
    : (activity?.level ?? ACTIVITY_DEFAULT);
  /** Nobody has picked one; the ladder is running on an assumption. */
  const assumed = activity !== null && activity.level === null;

  const accept = useCallback(async () => {
    const s = data?.suggestion;
    if (!s || saving) return;
    setSaving(true);
    setSaveFailed(false);
    setSaved(false);
    try {
      await saveTarget(getToken, on, {
        kcal: s.kcal,
        protein_g: s.protein_g,
        carb_g: s.carb_g,
        fat_g: s.fat_g,
        fibre_g: s.fibre_g,
        source: 'derived',
        basis: s.basis,
      });
      setSaved(true);
      // The live row is the screen's authority on what is in force, so every
      // write has to move it. Without this the athlete accepts 2,400 and the
      // card above still says 2,700 — which reads as the save not having
      // worked, and is the exact disagreement between the three sources this
      // screen exists to prevent.
      loadLive();
      // SPOKEN, not just rendered. `router.back()` used to be the confirmation
      // and navigation announces itself; a Text appearing mid-page while focus
      // stays on the button does not, so a VoiceOver user tapped "Use this
      // target" and heard nothing at all. iOS has no live regions, which is why
      // this is an imperative announcement.
      AccessibilityInfo.announceForAccessibility(SAVED_MESSAGE);
    } catch {
      // Accepting a target is the one derived WRITE on this screen, and offline
      // is this app's ordinary weather. Without this the button simply un-dimmed
      // and nothing happened — the athlete would reasonably conclude it saved.
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [data, getToken, on, saving, loadLive]);

  /**
   * A target somebody typed.
   *
   * `basis: null` and `source: 'manual'`, and both halves matter. The source is
   * what lets the card above say "you typed this one" instead of offering an
   * explanation that was never true; the null basis is what stops a derivation
   * being attached to a number that has none. Sending the current suggestion's
   * basis along would be the tidy-looking version of exactly that lie.
   */
  const saveManual = useCallback(
    async (input: ManualTargetInput) => {
      if (writing) return;
      setWriting('manual');
      setWriteFailed(null);
      try {
        await saveTarget(getToken, on, { ...input, source: 'manual', basis: null });
        setManualOpen(false);
        // Reseed, so reopening the form starts from what is now in force rather
        // than from the numbers that were there before the save.
        setManualSeq((n) => n + 1);
        loadLive();
        AccessibilityInfo.announceForAccessibility(
          `Saved. Your target is ${input.kcal} kcal from ${on}.`,
        );
      } catch (e) {
        const why = refusalOrWeather(e);
        setWriteFailed({ which: 'manual', message: why });
        // Spoken as well as rendered. Both SUCCESS paths announce and the
        // invalid-form path announces, each because focus stays on the button
        // and iOS has no live regions — and the failure path had the identical
        // shape while saying nothing at all.
        AccessibilityInfo.announceForAccessibility(why);
      } finally {
        setWriting(null);
      }
    },
    [getToken, on, writing, loadLive],
  );

  /**
   * Take the weekly proposal.
   *
   * Filed under the PROPOSAL's own date, never today's. The server picks
   * tomorrow deliberately — a target applied retroactively judges a day already
   * mostly eaten, and the remaining figure would jump under the athlete's
   * thumb. Substituting `on` here is the one-character version of that bug.
   */
  const acceptAdjustment = useCallback(
    async (a: Adjustment) => {
      if (writing) return;
      setWriting('adjustment');
      setWriteFailed(null);
      try {
        await saveTarget(getToken, a.effective_on, {
          kcal: a.to_kcal,
          protein_g: a.protein_g,
          carb_g: a.carb_g,
          fat_g: a.fat_g,
          fibre_g: a.fibre_g,
          source: 'adjustment',
          // An adjustment's arithmetic is a DIFFERENT shape from a derivation's,
          // and the target row stores the latter. Null keeps the stored
          // explanation honest: this came from an adjustment, and `source` says
          // so.
          basis: null,
        });
        loadLive();
        AccessibilityInfo.announceForAccessibility(
          `Saved. You are eating ${a.to_kcal} kcal from ${a.effective_on}.`,
        );
      } catch (e) {
        const why = refusalOrWeather(e);
        setWriteFailed({ which: 'adjustment', message: why });
        AccessibilityInfo.announceForAccessibility(why);
      } finally {
        setWriting(null);
      }
    },
    [getToken, writing, loadLive],
  );

  const s = data?.suggestion ?? null;
  // Null once a target is derivable, so the fix-this button cannot render for a
  // screen that has nothing left to fix.
  const gap = profileGap(data?.missing ?? []);
  const b = s?.basis ?? null;

  /**
   * The four macro figures for the tiles and the donut.
   *
   * **What is in force wins over what is proposed**, and that is the same rule
   * the big number follows: the card is about the target you are eating to, so
   * its tiles have to be that target's macros. Falling back to the suggestion
   * is right only when there is nothing in force to show.
   */
  const cardRows = useMemo(
    () => (live ? macroRowsFromTarget(live) : macroRows(s, b)),
    [live, s, b],
  );
  const derivedRows = useMemo(() => macroRows(s, b), [s, b]);

  const ladder: LadderRow[] = useMemo(() => {
    if (!b || !s) return [];
    return [
      {
        key: 'resting',
        glyph: 'calories',
        colour: macroColor('fat'),
        label: 'Resting rate',
        // The weigh-in behind it, in the athlete's own units. Held back until
        // the unit preference has been read from the cache: `useUnits` reports
        // `metric` before it has looked, so printing this on the first frame
        // shows an imperial athlete a figure in kilograms.
        hint: unitsReady ? `${formatWeight(b.weight_kg, units)} on ${b.weight_measured_on}` : null,
        value: `${b.rmr_kcal} kcal`,
        direction: null,
      },
      {
        key: 'movement',
        glyph: 'route',
        colour: macroColor('carbs'),
        label: 'Daily movement',
        hint: `×${b.activity_factor} on resting`,
        value: `${b.neat_kcal > 0 ? '+' : ''}${b.neat_kcal} kcal`,
        direction: b.neat_kcal > 0 ? 'up' : null,
      },
      {
        key: 'training',
        glyph: 'workout',
        colour: macroColor('protein'),
        label: 'Training',
        hint:
          b.training_sessions === 0
            ? `Nothing logged in the last ${b.training_days_covered} days`
            : `${b.training_sessions} sessions over ${b.training_days_covered} days, spread evenly`,
        // **A zero is never drawn as a gain.** `+0 kcal` in the accent reads as
        // credit for training that did not happen — the "no zeroes presented as
        // achievements" rule, in the one row where an athlete with an empty
        // fortnight is guaranteed to meet it. Plain type and no plus sign.
        value: `${b.training_kcal_per_day > 0 ? '+' : ''}${b.training_kcal_per_day} kcal`,
        direction: b.training_kcal_per_day > 0 ? 'up' : null,
      },
      {
        key: 'maintenance',
        glyph: 'progress',
        colour: macroColor('fibre'),
        label: 'Maintenance',
        hint: 'What holds your weight where it is',
        value: `${b.tdee_kcal} kcal`,
        direction: null,
        strong: true,
      },
      {
        key: 'phase',
        glyph: b.energy_delta_kcal < 0 ? 'weight' : 'goal',
        colour: b.energy_delta_kcal < 0 ? vola.danger : macroColor('carbs'),
        label: phaseLabel(b.phase_kind),
        hint:
          b.target_rate_kg_per_week === 0
            ? 'Weight held where it is'
            : unitsReady
              ? `${formatWeightRate(b.target_rate_kg_per_week, units)} per week`
              : null,
        value: `${b.energy_delta_kcal > 0 ? '+' : ''}${b.energy_delta_kcal} kcal`,
        direction: b.energy_delta_kcal === 0 ? null : b.energy_delta_kcal > 0 ? 'up' : 'down',
      },
    ];
  }, [b, s, units, unitsReady]);

  // BELOW every hook, and that placement is the rule rather than a preference:
  // an early return above one changes hook ORDER between renders, which the
  // typechecker cannot see and which shipped a black screen on every BJJ
  // session opened from Today. `react-hooks/rules-of-hooks` is an error here
  // for exactly that reason.
  if (foodDisabled) {
    return <ModuleOffNotice module={foodOff} action="set a daily target" testID="goals-disabled" />;
  }

  const folded = collapsed ?? SECTIONS;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Your target" />

      <KeyboardAwareScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {/* THE AUTHORITY, and it comes first for that reason. Everything below
            is a proposal — a derivation, a weekly correction, a field to type
            in — and with three of them on one screen the number actually in
            force has to be unmistakable and has to say where it came from. */}
        <TargetCard
          date={longDate(on)}
          kcal={live ? live.kcal : (s?.kcal ?? null)}
          inForce={live !== null}
          provenance={live?.source ? SOURCE_LABEL[live.source] : null}
          known={targets !== null}
          from={live?.effective_on ?? null}
          rows={cardRows}
          confidence={confidence}
          onEdit={() => {
            // Reseed on the way OPEN only, so the form picks up a target that
            // landed while it was closed.
            //
            // Read off the RENDERED `manualOpen` rather than from inside a
            // `setManualOpen` updater. An updater has to be pure — React may
            // call it twice — and `setManualSeq` inside one is a side effect
            // that would then bump the key by two.
            if (!manualOpen) setManualSeq((n) => n + 1);
            setManualOpen(!manualOpen);
          }}
        />

        {/*
          Directly under the card it argues with.

          It used to sit at the very bottom under its own heading, four
          viewports below the figure it exists to disagree with — which is the
          same "the reasoning was reachable and the action was not" failure the
          mobile-first rule was written from, in miniature. It is NOT nested
          inside the derivation block: an athlete whose profile cannot support a
          derivation gets `suggestion: null`, and they are precisely the person
          who most needs to type a number in.
        */}
        {manualOpen ? (
          <ManualTarget
            key={manualSeq}
            // What is in force first, the suggestion second, blank last. The
            // common act on a phone is disagreeing with ONE number, not
            // authoring five on a number pad — so the form opens on something
            // to edit whenever there is anything at all to open on.
            seed={live ? draftFrom(live) : s ? draftFrom(s) : null}
            on={on}
            saving={writing === 'manual'}
            failed={writeFailed?.which === 'manual' ? writeFailed.message : null}
            onSave={(input) => void saveManual(input)}
          />
        ) : null}

        {adjustment ? (
          <AdjustmentCard
            response={adjustment}
            units={units}
            onAccept={(a) => void acceptAdjustment(a)}
            accepting={writing === 'adjustment'}
          />
        ) : null}
        {writeFailed?.which === 'adjustment' ? (
          <Text
            style={styles.problem}
            testID="adjustment-failed"
            // Android's half; iOS takes the imperative announcement in the
            // catch, having no live regions of its own.
            accessibilityLiveRegion="polite"
          >
            {writeFailed.message}
          </Text>
        ) : null}

        <SectionHeader
          label="Daily movement"
          info={<InfoMark about="Daily movement" body={INFO.movement} testID="info-movement" />}
        />
        <MovementChoice
          options={ACTIVITIES}
          chosen={assumed ? null : (activity?.level ?? null)}
          assumed={assumed ? derivedAt : null}
          onChoose={(level) => void chooseActivity(level)}
        />

        {assumed && (
          <Text style={styles.note} testID="target-activity-assumed">
            {`Assuming ${ACTIVITY_LABELS[derivedAt]} until you pick one. Whichever you choose is
              kept on your account, so the web app works your target out the same way.`.replace(
              /\s+/g,
              ' ',
            )}
          </Text>
        )}

        {activity?.unsynced && (
          <Text style={styles.note} testID="target-activity-unsynced">
            Saved on this phone. It reaches your account next time you have signal.
          </Text>
        )}

        {failed && (
          <Text style={styles.note}>
            Could not reach the server. This one number is worked out there, because it needs your
            training history — everything else in Food works offline.
          </Text>
        )}

        {failed && activity?.unsynced && (
          <Text style={styles.note} testID="target-activity-stale">
            The working out below is still from your previous answer. Your new one is saved and the
            number will catch up once there is signal.
          </Text>
        )}

        {!failed && !data && <Text style={styles.note}>Working it out…</Text>}

        {data && !s && (
          <View style={styles.gap}>
            {/* The explanation renders whenever a target cannot be derived —
                the button only when there is somewhere honest to send you.
                Gating both on `gap` hid the sentence too, so a field this build
                does not recognise would have produced a blank screen instead of
                a named reason. */}
            <Text style={styles.note}>
              A target needs a few things first: {data.missing.map(profileLabel).join(', ')}.
            </Text>
            {gap && (
              <Pressable
                onPress={() =>
                  /*
                    The literals live HERE so Expo Router's generated types check
                    them, and the check-in uses the OBJECT form on purpose.

                    `` `/checkin/${date}` `` is a template literal, which the
                    route guard deliberately skips and CI's `tsc` cannot see
                    either. The object form names the route pattern as a
                    literal, which both the guard and the generated types can
                    check.
                  */
                  gap.kind === 'profile'
                    ? router.push('/profile/edit')
                    : router.push({
                        pathname: '/checkin/[date]',
                        params: { date: todayString() },
                      })
                }
                style={[styles.primary, { backgroundColor: accent.accent }]}
                accessibilityRole="button"
                accessibilityLabel={gap.label}
                testID="target-profile"
              >
                <Text style={[styles.primaryText, { color: accent.on }]}>{gap.label}</Text>
              </Pressable>
            )}
          </View>
        )}

        {s && b && (
          <>
            <CollapsibleSection
              label="Calorie breakdown"
              open={!folded.breakdown}
              onToggle={() => toggleSection('breakdown')}
              info={
                <InfoMark about="Calorie breakdown" body={INFO.breakdown} testID="info-breakdown" />
              }
              testID="section-breakdown"
            >
              <BreakdownLadder
                rows={ladder}
                result={`${s.kcal} kcal`}
                note={b.clamped && b.clamp_reason ? `${b.clamp_reason}.` : null}
                changePhaseLabel={
                  b.phase_kind === 'maintenance' ? 'Start a cut or a bulk' : 'Change phase'
                }
                onChangePhase={() => router.push('/phase')}
                testID="target-ladder"
              />
            </CollapsibleSection>

            {/* OUTSIDE the fold. "Does this look right?" is the one line that
                can tell an athlete their plan does not arrive, and a warning
                behind a disclosure is a warning nobody reads. It renders
                nothing when there is nothing to say. */}
            <Feasibility p={b.projection} units={units} ready={unitsReady} />

            <CollapsibleSection
              label="Macros"
              open={!folded.macros}
              onToggle={() => toggleSection('macros')}
              info={<InfoMark about="Macros" body={INFO.macros} testID="info-macros" />}
              trailing={
                <View style={styles.pill}>
                  <Text style={styles.pillText}>g per day</Text>
                </View>
              }
              testID="section-macros"
            >
              <MacroDonut rows={derivedRows} />
              {b.relaxed ? (
                <Text style={styles.note}>
                  These calories would not cover the usual protein and fat, so {b.relaxed} gave way
                  first.
                </Text>
              ) : null}
            </CollapsibleSection>

            <Pressable
              onPress={() => void accept()}
              style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Use this target"
              testID="target-accept"
            >
              <Text style={[styles.primaryText, { color: accent.on }]}>
                {saving ? 'Saving…' : 'Use this target'}
              </Text>
            </Pressable>
            {saveFailed ? <Text style={styles.problem}>{OFFLINE_MESSAGE}</Text> : null}
            {saved ? (
              <Text
                style={styles.saved}
                testID="target-saved"
                // Android's half of the same problem; iOS ignores it and takes
                // the imperative announcement above.
                accessibilityLiveRegion="polite"
              >
                {SAVED_MESSAGE}
              </Text>
            ) : null}
            <View style={styles.lock}>
              <Icon name="lock" size={12} color={vola.textDim} />
              {/*
                **"Your target", not "Nothing".** The reference's line reads
                "Nothing is saved until you tap that", and on this screen that
                is not quite true: choosing a movement card writes the level to
                the device and pushes it to the account, and the screen says so
                itself a few rows up ("Saved on this phone. It reaches your
                account next time you have signal"). Two lines on one screen
                contradicting each other about whether anything was saved is
                worse than the slightly longer sentence.

                What IS true, and is what the athlete needs, is that the target
                — the number, the macros and the workings — is not written until
                this button. That is asserted by a test rather than left as a
                claim.
              */}
              <Text style={styles.footnote} testID="target-promise">
                Your target is not saved until you tap that. The workings above are stored with it,
                so this page still answers the question months from now.
              </Text>
            </View>
          </>
        )}

        {/* Not in the reference, and folded on arrival for that reason — see
            SECTIONS. The trend still belongs to an athlete who wants it. */}
        <CollapsibleSection
          label="Your weight"
          open={!folded.weight}
          onToggle={() => toggleSection('weight')}
          testID="section-weight"
        >
          <WeightTrendCard projection={b?.projection ?? null} />
        </CollapsibleSection>
      </KeyboardAwareScrollView>
    </View>
  );
}

/** Provenance in the athlete's words, not the column's. */
const SOURCE_LABEL: Record<string, string> = {
  derived: 'worked out below',
  manual: 'you typed this one',
  adjustment: 'from a weekly adjustment',
};

/**
 * `2026-08-20` → `AUG 20, 2026`, the reference's eyebrow.
 *
 * Built from the ISO parts rather than through `Date`, deliberately: parsing
 * `YYYY-MM-DD` with `new Date()` yields UTC midnight, which renders as the
 * PREVIOUS day for anyone west of Greenwich. That is the exact class of bug the
 * mobile suite runs under `TZ=America/Los_Angeles` to catch, and it is not
 * worth a timezone conversion to abbreviate three letters.
 */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!month) return iso;
  return `${month} ${Number(d)}, ${y}`;
}

/**
 * "Does this look right?" — §5's third section, and the one that existed
 * nowhere until N69.
 *
 * A phase carries a goal weight, a deadline and a rate, and nothing compared
 * them. So an athlete could set "lose eight kilos by Christmas", be handed a
 * perfectly safe rate that arrives in April, and find out in April.
 *
 * **Renders nothing when there is nothing to say.** `projection` is null with
 * no goal weight or no live phase, and an all-clear in that case would be a
 * claim we never checked — the same absence-is-not-an-answer rule the rest of
 * this module runs on. Silence is the honest output.
 *
 * The arithmetic is the server's, so this screen and web cannot disagree about
 * whether a plan works.
 */
function Feasibility({
  p,
  units,
  ready,
}: {
  p: Projection | null;
  units: UnitSystem;
  /** The unit preference has been read. Every line here names a weight, and
   *  `useUnits` answers `metric` before it has looked. */
  ready: boolean;
}) {
  if (!p || !ready) return null;

  // Every weight here arrives in kilograms and every one of them is a number
  // the athlete is meant to act on — a goal, a gap, a shortfall against a
  // competition deadline.
  if (p.already) {
    return (
      <Text style={styles.note} testID="target-feasibility">
        You are already at {formatWeight(p.target_weight_kg, units)}. This phase has done its job.
      </Text>
    );
  }
  if (p.unreachable) {
    return (
      <Text style={styles.problem} testID="target-feasibility">
        This plan never reaches {formatWeight(p.target_weight_kg, units)} — {p.unreachable_reason}.
        Change the goal weight or the phase.
      </Text>
    );
  }

  const late = p.meets_deadline === false;
  return (
    <Text style={late ? styles.problem : styles.note} testID="target-feasibility">
      {formatWeight(p.kg_to_go, units)} to go. At this rate you reach{' '}
      {formatWeight(p.target_weight_kg, units)} around {p.reached_on}
      {p.meets_deadline === null
        ? '.'
        : late
          ? `, which is ${p.days_late} days after your ${p.deadline_on} deadline — about ${formatWeight(p.shortfall_kg, units)} short on the day.`
          : `, ahead of your ${p.deadline_on} deadline.`}
    </Text>
  );
}

/** The phase vocabulary as a sentence about food, not as a database enum. */
function phaseLabel(kind: string): string {
  switch (kind) {
    case 'cut':
      return 'Cutting';
    case 'lean_bulk':
      return 'Lean bulk';
    case 'making_weight':
      return 'Making weight';
    case 'recomposition':
      return 'Recomp';
    default:
      return 'Maintaining';
  }
}

/** Server field names, said the way the profile form says them. */
function profileLabel(field: string): string {
  switch (field) {
    case 'height_cm':
      return 'your height';
    case 'date_of_birth':
      return 'your date of birth';
    case 'sex':
      return 'your sex';
    case 'weight_kg':
      return 'a recent weigh-in';
    default:
      return field;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: TAB_BAR_CLEARANCE + 20, gap: 12 },
  gap: { gap: 12 },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  problem: { fontSize: 12, color: vola.danger, lineHeight: 17 },
  saved: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  lock: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16, flex: 1 },
  pill: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  pillText: { fontSize: 11, color: vola.textDim, fontWeight: '600' },
  primary: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryText: { fontWeight: '800', fontSize: 16 },
  off: { opacity: 0.5 },
});
