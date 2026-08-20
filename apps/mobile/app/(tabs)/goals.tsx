/**
 * Why you are eating this much.
 *
 * ## Every line, or none of it
 *
 * The screen renders the derivation as an arithmetic ladder — resting rate,
 * daily movement, training, maintenance, the phase adjustment, the result —
 * because a calorie target is an argument, and an argument you cannot inspect
 * is a verdict. The project's standing principle is auditable recommendations,
 * and this is the surface where that gets paid for.
 *
 * That is also why a bound rail is stated out loud. Without the line, the last
 * step visibly does not follow from the one above it, and a reader concludes
 * the app cannot add up rather than that it declined to go further.
 *
 * ## It computes; accepting is a separate act
 *
 * The suggestion is never written on arrival. `Use this target` is the only
 * thing that stores anything, and it freezes this arithmetic onto the row — so
 * asking the same question in March gets March's numbers back rather than a
 * fresh derivation from a body that has since changed.
 *
 * ## Three ways a target gets its number, and this screen offers all three
 *
 * Until N72 it offered one. The derivation was here, in full, and the two ways
 * of DISAGREEING with it were on web only: typing your own number, and the
 * weekly adjustment that corrects a target against what your weight actually
 * did. So an athlete on a phone could read the entire argument for 2,700 kcal
 * and had nowhere to answer it — the reasoning reachable, the action not, which
 * is the exact failure the mobile-first rule in `CLAUDE.md` was written from.
 *
 *  - **derived** — the ladder below, accepted with `Use this target`.
 *  - **adjustment** — a weekly correction from what actually happened to your
 *    weight, shown in full before you take it. N27; see `AdjustmentCard`.
 *  - **manual** — a number you typed. It has no arithmetic and the screen says
 *    so rather than inventing one.
 *
 * **`What you are eating to` is the authority, and the ladder is not.** With
 * one source that distinction did not exist; with three it is the thing most
 * worth getting right, because a suggestion sitting under the heading "Your
 * target" is a number nobody chose being read as the number in force. So the
 * live row is fetched from the server, states its own provenance, and is
 * refreshed by every one of the three writes.
 *
 * ## When it cannot
 *
 * An incomplete profile returns `suggestion: null` with the fields named. The
 * screen says which, and sends you to the form that fixes them. It does NOT
 * fall back to the estimated resting baseline: `energy`'s own doc puts that
 * 20–30% high, which on a target is roughly 400 kcal a day and a cut that
 * never happens, invisibly, forever.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ModuleOffNotice } from '@/components/ModuleOffNotice';
import { ScreenHeader } from '@/components/ScreenHeader';
import { WeightTrendCard } from '@/components/WeightTrendCard';
import { Text } from '@/components/Themed';
import { AdjustmentCard } from '@/components/nutrition/AdjustmentCard';
import { ManualTarget } from '@/components/nutrition/ManualTarget';
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
import { useModules } from '@/lib/ModulesProvider';
import { foodLogGate } from '@/lib/modules';
import { setActivityLevel } from '@/lib/profile';
import { addDays } from '@/lib/history';
import { useAuthToken } from '@/lib/useAuthToken';
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
 * row live at its start, which is what makes a target set months ago the
 * answer to "what am I eating to" today. A year is arbitrary and generous; the
 * carry-in is what actually matters, and shortening this cannot lose the live
 * row.
 */
const HISTORY_DAYS = 365;

/** The one offline sentence, said the same way wherever a write fails. */
const OFFLINE_MESSAGE =
  'Could not save it — this one needs a connection. Nothing has changed; try again when you have signal.';

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
 *
 * The client's own bounds now match the server's, so the refusal branch should
 * be rare. It is here because "should be rare" is not "cannot happen": the two
 * can drift, and this is what makes the drift legible instead of silent.
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
  const { units } = useUnits();

  // N61: this tab stays in the bar with nutrition off — see `(tabs)/_layout.tsx`
  // — so the screen has to say which module is off rather than deriving a
  // target for a feature the athlete has turned off. Shared with Food through
  // `foodLogGate`, whose `ready` half is what stops a cold start claiming
  // "turned off" from a module list nobody has read yet.
  const { modules, ready: modulesReady } = useModules();
  const { disabled: foodDisabled, off: foodOff } = foodLogGate(modules, modulesReady);

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
   *    true when the athlete presses a pill, and is only cleared by a later
   *    focus re-reading the cache and finding nothing owed. Driving the
   *    parameter off `unsynced` instead would flip it back the instant a push
   *    succeeded, which changes the request and refetches the whole derivation
   *    a second time for an answer that cannot have moved.
   *  - `unsynced` is for the athlete: "this is on your phone, not your account
   *    yet". It clears the moment the push lands.
   *
   * See `lib/activityLevel.ts` for why the value lives on the profile at all.
   */
  const { userId } = useAuth();
  /**
   * How many times a pill has been pressed this session.
   *
   * Read only inside promise callbacks, never during render. Its single job is
   * to let an in-flight cache read notice that the athlete chose something
   * after it started, so a stale snapshot cannot revert a fresh tap.
   */
  const choiceSeq = useRef(0);
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
  // server, and both deliberately independent of the activity pills. Web
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
  // Saved-in-place, because this screen is a TAB now rather than something
  // pushed from Food. It used to `router.back()` on success, which was the
  // whole confirmation: the screen you were on returning IS the receipt. A tab
  // has nowhere to go back to — calling it would drop the athlete onto
  // whichever screen they happened to visit before, or nowhere at all — so the
  // acknowledgement has to be said out loud here instead. A write with no
  // visible outcome is the failure mode the offline branch below already
  // exists to prevent; this is the same rule applied to success.
  const [saved, setSaved] = useState(false);
  // The day this screen is about, RE-READ ON EVERY FOCUS rather than computed
  // once at mount — see the focus effect below for why that distinction only
  // started to matter when this became a tab.
  const [on, setOn] = useState(todayString);

  /**
   * Refetch whenever the tab is focused, and re-read the date while doing it.
   *
   * **A pushed screen got this for free and a tab does not**, which is the one
   * lifecycle assumption that survived the move from `food/target.tsx` intact
   * and wrong. Pushed, this screen remounted on every open: the effect ran, the
   * ladder was current, and `todayString()` was evaluated afresh. A tab mounts
   * once, lazily, and then stays mounted for the life of the process — so
   * without this it would show the weight, training load and phase it read the
   * first time it was ever opened, for as long as the app stays alive.
   *
   * The date is the half that turns staleness into a WRONG WRITE rather than a
   * stale read. `on` is what `accept` saves against, so an app left open past
   * midnight would file tomorrow's target under yesterday, silently, and ask
   * the server for a suggestion about a day that has gone.
   *
   * Found in review of the move, not by a test — nothing in the suite mounts a
   * tab twice, and both symptoms need a second visit to appear.
   */
  /**
   * Read the stored level back, ON EVERY FOCUS.
   *
   * **A tab mounts once and stays mounted for the life of the process**, so a
   * `useEffect` keyed on `[userId]` would run exactly once, ever — and this
   * screen's whole ticket is a value that has to survive leaving the tab. The
   * same mistake is already documented one file over: Today read its
   * suggestion preferences from a mount effect, and the Settings switches
   * appeared to do nothing until the app was killed. Settings looked correct
   * when checked by hand because a pushed screen remounts and always reads back
   * what it just wrote; only the RETURN was broken.
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
      // Bumped by every pill press. Captured before the read so the resolution
      // can tell whether a tap landed while it was in flight: the read's
      // snapshot would then be older than what the athlete just chose, and
      // applying it reverts the pill under their thumb for the rest of the
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
           * The only other `setActivityLevel` call is a pill press, so a choice
           * made in a gym dead-spot would stay owed *forever* unless the
           * athlete happened to tap the same pill again while online — and web
           * would go on deriving at the stale level indefinitely, which is the
           * cross-surface disagreement this whole change exists to remove. The
           * screen even promises otherwise in as many words ("It reaches your
           * account next time you have signal"). Caught in review; the doc and
           * the copy described it and nothing implemented it.
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
            setActivity((prev) =>
              prev?.level === c.level ? { ...prev, unsynced: false } : prev,
            );
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
   * Nothing here sets state, so it is not the `set-state-in-effect` shape the
   * lint ratchet holds.
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
    // Same shape as `bjj/positions`, which guards the fetch rather than letting
    // the early return merely hide the answer.
    if (foodDisabled) return;
    // Nothing until the cache has answered. Asking first would send no
    // parameter, adopt whatever the server said, and overwrite a choice made
    // offline a moment before the read landed.
    if (!activityReady) return;
    let live = true;
    // Both flags are set from the CALLBACKS, never synchronously here. A reset
    // on the way in is a setState during the effect — the rule the lint ratchet
    // holds — and it also flickers the previous answer away for a frame each
    // time the activity pills move.
    suggestedTarget(getToken, on, activityQuery)
      .then((d) => {
        if (!live) return;
        setData(d);
        setFailed(false);
        // The receipt belongs to the numbers that were saved, and these are
        // different numbers. Moving an activity pill, or coming back to the tab
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
   * open, so the effect ran, the ladder was current, and the day it saves
   * against was evaluated afresh. A tab mounts once, lazily, and then stays
   * mounted for the life of the process: without this it would show the weight,
   * training load and phase it read the first time it was ever opened.
   *
   * The date is the half that turns a stale read into a WRONG WRITE. `on` is
   * what `accept` files the target under, so an app left open past midnight
   * would save tomorrow's target against yesterday.
   *
   * `useFocusEffect` re-runs when its callback's identity changes while the
   * screen is focused, and `load` changes with the activity — so moving a pill
   * refetches through this same path rather than through a second effect. That
   * matters: an earlier version had both, and the two fired together on mount,
   * asking three times for one opening and letting a late answer wipe the
   * "Saved" receipt a moment after it appeared.
   */
  useFocusEffect(
    useCallback(() => {
      setOn(todayString());
      return load();
    }, [load]),
  );

  /**
   * What is in force, and whether the weekly check has a proposal.
   *
   * A SECOND focus effect rather than more work inside the first, and the
   * dependency list is the reason: `load` changes with the activity pills, so
   * folding these in would refetch a year of target history and re-run the
   * adjustment computation on every pill press — two server round trips a chip
   * cannot possibly affect, on a phone that may be on cellular. Web made
   * exactly that mistake and its review caught it.
   *
   * Neither failure is fatal to the screen, so neither gets an error banner:
   * the derivation below still works, and a live-target row that cannot be read
   * simply says so. What it must NOT do is render a stale row as current, which
   * is why the state is a nullable rather than an empty array.
   */
  const loadLive = useCallback(() => {
    // Same guard as `load` above, and it needs saying twice because these are
    // two focus effects on purpose — see the comment above: folding them into
    // one refetches a year of history on every activity pill press.
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
    return () => {
      live = false;
    };
  }, [foodDisabled, getToken, on]);

  useFocusEffect(loadLive);

  /**
   * Record a level the athlete just picked.
   *
   * **Local first, then the account.** The pill has to move under the thumb and
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
      // `pinned` stays true through the successful push: it decides what the
      // NEXT derivation asks for, and flipping it back here would change the
      // query and refetch the whole ladder for an answer that cannot have
      // moved. The next focus clears it, having re-read the cache.
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
   * The level the number below was actually derived at.
   *
   * Taken from the RESPONSE rather than from local state, so the pills and the
   * arithmetic can never describe different things — which is the reported bug
   * in its purest form. Falls back to the documented default only before the
   * first response arrives.
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
      // heading above still says 2,700 — which reads as the save not having
      // worked, and is the exact disagreement between the three sources this
      // screen exists to prevent.
      loadLive();
      // SPOKEN, not just rendered. `router.back()` used to be the confirmation
      // and navigation announces itself; a Text appearing mid-page while focus
      // stays on the button does not, so a VoiceOver user tapped "Use this
      // target" and heard nothing at all. iOS has no live regions, which is why
      // this is an imperative announcement — the same call sign-in and sign-up
      // already make for their errors. Raised in review.
      AccessibilityInfo.announceForAccessibility(SAVED_MESSAGE);
    } catch {
      // Accepting a target is the one WRITE on this screen, and offline is this
      // app's ordinary weather. Without this the button simply un-dimmed and
      // nothing happened — the athlete would reasonably conclude it had saved.
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [data, getToken, on, saving, loadLive]);

  /**
   * A target somebody typed.
   *
   * `basis: null` and `source: 'manual'`, and both halves matter. The source is
   * what lets the row above say "you typed this one" instead of offering an
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
        // shape while saying nothing at all. A VoiceOver user heard "Saving…",
        // then silence, and concluded the target was set. Raised in review.
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

  // BELOW every hook, and that placement is the rule rather than a preference:
  // an early return above one changes hook ORDER between renders, which the
  // typechecker cannot see and which shipped a black screen on every BJJ
  // session opened from Today. `react-hooks/rules-of-hooks` is an error here
  // for exactly that reason.
  if (foodDisabled) {
    return <ModuleOffNotice module={foodOff} action="set a daily target" testID="goals-disabled" />;
  }

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
        <SectionHeader label="What you are eating to" />
        <LiveTarget target={live} known={targets !== null} />

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

        {/* Where you are against the goal, before any control that changes
            it. N56 — the card fetches its own check-ins so this screen does
            not grow three more requests and their failure states. */}
        <WeightTrendCard projection={b?.projection ?? null} />

        <SectionHeader label="Daily movement" />
        <View style={styles.pills}>
          {ACTIVITIES.map((a) => {
            const isOn = !assumed && a.key === activity?.level;
            // The one the derivation fell back to, with nobody having chosen.
            // Drawn as a DASHED outline rather than the accent border, and
            // `selected` stays false: a filled pill claims the athlete decided
            // this, and they did not. The contract's `activity_chosen` exists
            // precisely so a client can tell these apart, and rendering them
            // the same throws that away.
            const isAssumed = assumed && a.key === derivedAt;
            return (
              <Pressable
                key={a.key}
                onPress={() => void chooseActivity(a.key)}
                style={[
                  styles.pill,
                  isOn && { borderColor: accent.accent },
                  isAssumed && styles.pillAssumed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: isOn }}
                accessibilityLabel={
                  isAssumed
                    ? `${a.label}. ${a.hint}. Assumed — you have not chosen yet.`
                    : `${a.label}. ${a.hint}`
                }
                testID={`target-activity-${a.key}`}
              >
                <Text style={[styles.pillLabel, isOn && { color: accent.ink }]}>{a.label}</Text>
                <Text style={styles.pillHint}>{a.hint}</Text>
              </Pressable>
            );
          })}
        </View>

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
            Could not reach the server. This one number is worked out there, because it needs
            your training history — everything else in Food works offline.
          </Text>
        )}

        {failed && activity?.unsynced && (
          <Text style={styles.note} testID="target-activity-stale">
            The working out below is still from your previous answer. Your new one is saved and
            the number will catch up once there is signal.
          </Text>
        )}

        {!failed && !data && <Text style={styles.note}>Working it out…</Text>}

        {data && !s && (
          <View style={styles.gap}>
            {/* The explanation renders whenever a target cannot be derived —
                the button only when there is somewhere honest to send you.
                Gating both on `gap` hid the sentence too, so a field this build
                does not recognise would have produced a blank screen instead of
                a named reason. Raised in review. */}
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
                    either — so that branch of this very fix would have been
                    unguarded against the exact bug it exists to fix. The object
                    form names the route pattern as a literal, which both the
                    guard and the generated types can check. Raised in review.
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
            <SectionHeader label="The arithmetic" />
            <Row label="Resting rate" value={`${b.rmr_kcal} kcal`} hint={`${b.weight_kg} kg on ${b.weight_measured_on}`} />
            <Row label="Daily movement" value={`+${b.neat_kcal} kcal`} hint={`×${b.activity_factor} on resting`} />
            <Row
              label="Training"
              value={`+${b.training_kcal_per_day} kcal`}
              hint={`${b.training_sessions} sessions over ${b.training_days_covered} days, spread evenly`}
            />
            <Row label="Maintenance" value={`${b.tdee_kcal} kcal`} strong />
            <Row
              label={phaseLabel(b.phase_kind)}
              value={`${b.energy_delta_kcal >= 0 ? '+' : ''}${b.energy_delta_kcal} kcal`}
              hint={
                b.target_rate_kg_per_week === 0
                  ? 'Weight held where it is'
                  : `${fmt(b.target_rate_kg_per_week)} kg a week`
              }
            />
            {b.clamped && b.clamp_reason ? <Text style={styles.note}>{b.clamp_reason}.</Text> : null}
            <Pressable
              onPress={() => router.push('/phase')}
              accessibilityRole="button"
              accessibilityLabel="Change your phase"
              testID="target-phase"
            >
              <Text style={[styles.link, { color: accent.ink }]}>
                {b.phase_kind === 'maintenance' ? 'Start a cut or a bulk' : 'Change phase'}
              </Text>
            </Pressable>
            {/* "This works out to", not "Your target" — it was the latter when
                the derivation was the only way to get a number, and with three
                on one screen that heading now names something nobody has
                chosen. What you are eating to is at the top and says so. */}
            <Row label="This works out to" value={`${s.kcal} kcal`} strong />

            <Feasibility p={b.projection} />

            <SectionHeader label="Macros" />
            <Row label="Protein" value={`${s.protein_g} g`} hint={`${fmt(b.protein_g_per_kg)} g per kg`} />
            <Row label="Fat" value={`${s.fat_g} g`} hint={`${fmt(b.fat_g_per_kg)} g per kg`} />
            <Row label="Carbs" value={`${s.carb_g} g`} hint="Whatever the calories leave" />
            <Row label="Fibre" value={`${s.fibre_g} g`} hint="A floor, not a ceiling" />
            {b.relaxed ? (
              <Text style={styles.note}>
                These calories would not cover the usual protein and fat, so {b.relaxed} gave way
                first.
              </Text>
            ) : null}

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
            {saveFailed ? (
              <Text style={styles.problem}>
                Could not save it — this one needs a connection. Nothing has changed; try again
                when you have signal.
              </Text>
            ) : null}
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
            <Text style={styles.footnote}>
              Nothing is saved until you tap that. The workings above are stored with it, so this
              page still answers the question months from now.
            </Text>
          </>
        )}

        {/*
          OUTSIDE the derivation block, and that placement is the point.

          An athlete whose profile cannot support a derivation gets
          `suggestion: null` — no height on file, no recent weigh-in — and they
          are precisely the person who most needs to type a number in. Nesting
          this inside `s && b` would hide the escape hatch from the only people
          with no other way out, which is the same class of mistake as putting
          it on web.
        */}
        <SectionHeader label="Or set it yourself" />
        <Pressable
          onPress={() => {
            // Reseed on the way OPEN only, so the form picks up a target that
            // landed while it was closed.
            //
            // Read off the RENDERED `manualOpen` rather than from inside a
            // `setManualOpen` updater. An updater has to be pure — React may
            // call it twice — and `setManualSeq` inside one is a side effect
            // that would then bump the key by two. Harmless for a remount key
            // and wrong in a way that generalises badly.
            if (!manualOpen) setManualSeq((n) => n + 1);
            setManualOpen(!manualOpen);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: manualOpen }}
          accessibilityLabel="Type your own target"
          testID="manual-toggle"
        >
          <Text style={[styles.link, { color: accent.ink }]}>
            {manualOpen ? 'Never mind' : 'Type your own target'}
          </Text>
        </Pressable>
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
      </KeyboardAwareScrollView>
    </View>
  );
}

/**
 * The number actually in force, and where it came from.
 *
 * Three states, and collapsing any two of them is the bug this component
 * exists to avoid:
 *
 *  - **not known** — the read failed or has not finished. Says so. It must
 *    never render as "no target yet", which would tell an athlete who set one
 *    last week to go and set it again.
 *  - **none** — read fine, genuinely nothing set.
 *  - **set** — the number, the date it took effect, and its provenance.
 *
 * The provenance line is not decoration. A derived target has an explanation
 * and a typed one does not, so saying which is what stops the ladder below
 * being read as the working behind a number it had nothing to do with.
 */
function LiveTarget({ target, known }: { target: Target | null; known: boolean }) {
  if (!known) {
    return (
      <Text style={styles.note} testID="live-target-unknown">
        Could not read what you are eating to — that lives on the server. The workings below
        still add up.
      </Text>
    );
  }
  if (!target) {
    return (
      <Text style={styles.note} testID="live-target-none">
        No target yet. Take the one below, or set your own.
      </Text>
    );
  }
  return (
    <View style={styles.live} testID="live-target">
      <Text style={styles.liveKcal}>{target.kcal} kcal</Text>
      <Text style={styles.note}>
        from {target.effective_on}
        {target.source ? ` · ${SOURCE_LABEL[target.source]}` : ''}
      </Text>
      <Text style={styles.note}>
        {target.protein_g} g protein · {target.fat_g} g fat · {target.carb_g} g carbs
        {target.fibre_g != null ? ` · ${target.fibre_g} g fibre` : ''}
      </Text>
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
function Feasibility({ p }: { p: Projection | null }) {
  if (!p) return null;

  if (p.already) {
    return (
      <Text style={styles.note} testID="target-feasibility">
        You are already at {p.target_weight_kg} kg. This phase has done its job.
      </Text>
    );
  }
  if (p.unreachable) {
    return (
      <Text style={styles.problem} testID="target-feasibility">
        This plan never reaches {p.target_weight_kg} kg — {p.unreachable_reason}. Change the
        goal weight or the phase.
      </Text>
    );
  }

  const late = p.meets_deadline === false;
  return (
    <Text style={late ? styles.problem : styles.note} testID="target-feasibility">
      {p.kg_to_go} kg to go. At this rate you reach {p.target_weight_kg} kg around{' '}
      {p.reached_on}
      {p.meets_deadline === null
        ? '.'
        : late
          ? `, which is ${p.days_late} days after your ${p.deadline_on} deadline — about ${p.shortfall_kg} kg short on the day.`
          : `, ahead of your ${p.deadline_on} deadline.`}
    </Text>
  );
}

function Row({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, strong && styles.rowLabelStrong]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]}>{value}</Text>
    </View>
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

/** One decimal, and no trailing `.0` on a whole number. */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: 48, gap: 10 },
  gap: { gap: 12 },
  live: { gap: 2, paddingBottom: 4 },
  liveKcal: { fontSize: 26, fontWeight: '800', color: vola.text, fontVariant: ['tabular-nums'] },
  pills: { gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  // The level the derivation ASSUMED, nobody having chosen. Deliberately not
  // the accent border a real choice gets — see the render site.
  //
  // `textMuted` (4.67:1) rather than `textDim`, which `constants/Colors.ts`
  // itself records at 2.51:1 — under the 3:1 floor for a non-text element, so
  // the dashed-versus-solid distinction would simply not exist for a low-vision
  // reader. The state is carried in prose and in the accessibility label too,
  // so this was never the sole channel; it costs nothing to make it legible.
  pillAssumed: { borderStyle: 'dashed', borderColor: vola.textMuted },
  pillLabel: { fontSize: 14, fontWeight: '600' },
  pillHint: { fontSize: 12, color: vola.textDim },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  rowMain: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 14, color: vola.textMuted },
  rowLabelStrong: { color: vola.text, fontWeight: '700' },
  rowHint: { fontSize: 11, color: vola.textDim },
  rowValue: { fontSize: 14, fontVariant: ['tabular-nums'], color: vola.textMuted },
  rowValueStrong: { fontSize: 16, fontWeight: '700', color: vola.text },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  problem: { fontSize: 12, color: vola.danger, lineHeight: 17 },
  saved: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  link: { fontSize: 13, fontWeight: '700', paddingVertical: 6 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
