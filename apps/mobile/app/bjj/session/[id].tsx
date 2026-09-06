import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { EndTimeCorrection } from '@/components/EndTimeCorrection';
import { HoldToConfirm } from '@/components/HoldToConfirm';
import { HRSessionReport } from '@/components/HRSessionReport';
import { SelectAllTextInput } from '@/components/SelectAllTextInput';
import { SessionCelebration } from '@/components/SessionCelebration';
import { ShareCardHost, ShareSessionButton, useSessionShare } from '@/components/SessionShare';
import { Icon } from '@/components/ui/Icon';
import { CardGlass } from '@/components/ui/CardGlass';
import { worthCelebrating, type SessionSummary } from '@/lib/celebration';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Card } from '@/constants/Card';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { useAccent } from '@/lib/AccentProvider';
import {
  addDays,
  dayString,
  finishTimestampFor,
  monthGrid,
  weekDays as calendarWeekDays,
} from '@/lib/calendar';
import { getSessionMetrics, listBiometricSamples, type SessionMetrics } from '@/lib/biometric';
import { buildHRTimeline, type HRTimelinePoint } from '@/lib/hrTimeline';
import {
  getDetail,
  KINDS,
  LIVE_ROWS,
  describeRPE,
  MAX_RPE,
  rollingMinutes,
  techniqueOutcomeCount,
  type SessionDetail,
} from '@/lib/bjjSession';
import {
  deleteLocalSession,
  saveLocalBjjDetail,
  finishLocalSession,
  readLocalBjjDetail,
  readLocalSession,
  renameLocalSession,
  rescheduleLocalSession,
  type LocalSession,
} from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';
import { carriedTheStreak, fetchHistory, localZone, streakRange, weekStreak } from '@/lib/history';
import {
  accomplishmentBadge,
  accomplishmentsFromSession,
  fetchAccomplishments,
} from '@/lib/accomplishments';
import { milestoneForSession, type Milestone } from '@/lib/milestones';

/**
 * Reading a BJJ session back.
 *
 * This screen exists because the logging half shipped without it, and that
 * turned out to be the whole feature rather than a missing corner. Today's
 * list sent every session to `/session/[id]`, which knows only about sets —
 * so a class opened to "Sets 0 · Reps 0 · Volume —" and an empty list, and
 * the reflection was reachable from nowhere at all. You could record what you
 * drilled and what happened live, and the app would never show it to you
 * again.
 *
 * The rule it now follows is the same one the log screen follows: a BJJ
 * session is not a strength session with the numbers missing, it is a
 * different shape. What a mat session has is time, rounds, effort and
 * evidence; showing it a volume tile is showing it a column it can never
 * fill.
 */

function minutesBetween(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : 0;
}

/**
 * A class, in the shape the completion card and the share card both take.
 *
 * ONE function, called from two places that used to be one: finishing built
 * this inline, so the card existed only in the seconds after the hold, and a
 * class opened from Today afterwards had no way to produce it. Extracting it
 * is what makes "share a class you logged last Tuesday" the same card rather
 * than a second, drifting description of it.
 *
 * BJJ has no records and no tonnage, and those stay zero/empty rather than
 * being invented: `lib/records.ts` is strength-only, and a "you showed up"
 * medal to fill the gap is precisely the wallpaper that devalues real ones.
 */
function bjjSummaryFor(session: LocalSession, detail: SessionDetail | null): SessionSummary {
  return {
    title: session.name || 'Session',
    sport: 'bjj',
    durationSeconds: session.started_at
      ? Math.max(
          0,
          (new Date(session.ended_at ?? Date.now()).getTime() -
            new Date(session.started_at).getTime()) /
            1000,
        )
      : 0,
    exercises: 0,
    sets: 0,
    reps: 0,
    tonnageKg: 0,
    rounds: detail?.rounds ?? undefined,
    matMinutes:
      detail?.rounds && detail?.round_minutes ? detail.rounds * detail.round_minutes : undefined,
    // `session_rpe` is the athlete's own rating of the session, so it belongs
    // in the card's "How it felt" block rather than beside the measurements.
    hardestRpe: detail?.session_rpe ?? null,
    records: [],
    recordExerciseIDs: [],
  };
}

export default function BjjSessionScreen() {
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { userId } = useAuth();
  const getToken = useAuthToken();

  const [session, setSession] = useState<LocalSession | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [celebrating, setCelebrating] = useState<SessionSummary | null>(null);
  /*
    The weekly streak is sport-agnostic, so a week opened on the mat carries it
    exactly as a week opened under a barbell does — and for this app's core
    athlete it is usually the mat that opens it. Wiring only the strength card
    would have left the chime firing almost never for a BJJ+strength athlete:
    silent here for want of the props, and silent on the week's first strength
    session because by then the week already holds one.
  */
  const [celebrationStreak, setCelebrationStreak] = useState<{
    weeks: number;
    carried: boolean;
  } | null>(null);
  /*
    And the MILESTONE, for exactly the reason stated above — the argument does
    not merely also apply here, it applies harder.

    `milestoneForSession` fires only on the session that carried the streak into
    the rung. So if the mat opens the week and this screen does not compute one,
    no later session can pick it up: every strength session that week has
    `carried === false`. The rung is not delayed, it is **lost**, silently, for
    that week and that week only — and for a BJJ+strength athlete the mat is
    usually what opens the week, so "lost" would have been the normal case.

    Review caught this after the strength screen was wired and this one was not.
    The comment above predicted the shape and the fix still missed the file.
  */
  const [celebrationMilestone, setCelebrationMilestone] = useState<Milestone | null>(null);
  const [streakSettled, setStreakSettled] = useState(false);
  useEffect(() => {
    if (!celebrating) return;
    let live = true;
    const { from, to } = streakRange();
    fetchHistory(getToken, { from, to, tz: localZone() })
      .then((h) => {
        if (!live) return;
        const carried = carriedTheStreak(h.days);
        setCelebrationStreak({ weeks: weekStreak(h.days), carried });
        // Same pass, same `carried` — so the card cannot show a milestone whose
        // streak line disagrees with it.
        setCelebrationMilestone(milestoneForSession(h.days, carried));
      })
      .catch(() => {
        // No history, no streak line and no chime — same silence as the
        // strength card, for the same reason.
      })
      .finally(() => {
        if (live) setStreakSettled(true);
      });
    return () => {
      live = false;
    };
  }, [celebrating, getToken]);

  /*
    And the BADGE — what this session was the first of.

    The mat's answer to the personal-record row, and it arrives the same way:
    the SERVER decides, every award carries the session that earned it, and
    this filters. Re-deriving "is this a first?" here would be a second opinion
    that can disagree with the accomplishments the rest of the app shows.

    `settled` is what makes the chime precedence real rather than a race. It
    starts false, so BJJ now has a genuine lookup to wait for where it
    previously had none — see the note at the call site, which used to say the
    opposite and was true when it was written.

    Offline it never settles, and that is the honest outcome the PR row already
    chose: silence is not a claim, a wrong medal is.
  */
  /*
    ONE piece of state, stamped with the session it answered for, rather than a
    value plus a `settled` boolean.

    Two states would need a synchronous reset at the top of the effect, which
    `react-hooks/set-state-in-effect` refuses — and the rule is right here
    rather than merely satisfied: stamping is also the stronger version. A
    result can never be read as a different session's, because settledness IS
    "the answer I hold is for the id on screen" instead of a flag somebody has
    to remember to clear.
  */
  const [badge, setBadge] = useState<{
    sessionID: string;
    value: { label: string } | null;
  } | null>(null);
  // `badge != null` first: `badge?.sessionID === id` alone is `undefined ===
  // undefined` when both are absent, which would open the streak gate before
  // anything had been looked up. Unreachable today (a celebration needs a
  // loaded session, which needs an id) and closed anyway, because it costs a
  // comparison and the failure is silent.
  const badgeSettled = badge != null && badge.sessionID === id;
  const celebrationBadge = badgeSettled ? badge.value : null;
  useEffect(() => {
    if (!celebrating || !id) return;
    let live = true;
    fetchAccomplishments(getToken, localZone())
      .then((all) => accomplishmentBadge(accomplishmentsFromSession(all, id)))
      // No network, no badge and no claim — silent, because a failed lookup is
      // not an error to raise on a celebration screen.
      .catch(() => null)
      .then((value) => {
        // A FAILURE STILL SETTLES, matching the strength card exactly: offline
        // the answer is "nothing to show", and the streak chime must not wait
        // forever for a lookup that is never coming back. An earlier version
        // here never settled on failure and claimed that matched the PR row --
        // it did the opposite, and review caught the contradiction. One rule
        // for both sports; suppressing a streak the athlete really did carry,
        // because an unrelated endpoint failed, punishes them for a server
        // fault.
        if (live) setBadge({ sessionID: id, value });
      });
    return () => {
      live = false;
    };
  }, [celebrating, getToken, id]);

  const [loading, setLoading] = useState(true);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);

  const [error, setError] = useState<string | null>(null);
  // True once the server has been asked and had nothing either.
  const [remoteMissing, setRemoteMissing] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  // Which day the reschedule sheet is open to. Null means closed — not a
  // separate boolean, so the sheet always opens anchored on the month the
  // session's OWN date falls in rather than whatever month it was last left
  // on, which matters the moment a correction is more than a few days back.
  const [reschedulingAnchor, setReschedulingAnchor] = useState<Date | null>(null);
  const [reschedulingError, setReschedulingError] = useState<string | null>(null);
  /**
   * N487/#848: a real end time for the live-session Finish path, set only
   * when the athlete corrects it — `null` means `finishNow` below keeps
   * stamping real "now", exactly as it did before this ticket. The app-
   * tracked session case this exists for: the athlete trained, forgot to
   * finish it, and only opens the app to close it out hours later — "now" at
   * that moment is the couch, not the mat, and N476/N477 already join HR
   * data to this window.
   */
  const [finishEndOverride, setFinishEndOverride] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!userId || !id) return;
    try {
      const [s, d] = await Promise.all([
        readLocalSession(userId, id),
        readLocalBjjDetail(userId, id),
      ]);
      setSession(s);
      setDetail(d);

      // The blob is local-only: the pull writes the session row but not
      // `bjj_json`, so after a reinstall or on a second device a reflection
      // the SERVER is holding reads as "nothing recorded" — the same
      // write-only failure this screen exists to fix, displaced one device
      // over. Fall back to the API and cache what comes back, so the next
      // open is offline-fast and the wizard can edit it.
      if (!d) {
        setRemoteMissing(false);
        try {
          const { detail: fromServer } = await getDetail(getToken, id);
          setDetail(fromServer);
          await saveLocalBjjDetail(userId, id, fromServer);
        } catch {
          // Offline, or genuinely no reflection. Either way the floor still
          // rendered; `remoteMissing` only decides which sentence shows.
          setRemoteMissing(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId, id, getToken]);

  // On focus, not just on mount: the whole point of this screen is that the
  // wizard is reachable from it, and coming back from an edit to the numbers
  // you just changed still showing the old ones would read as the edit having
  // been lost — which is the exact class of doubt this screen exists to fix.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Technique names for the drilled chips. Best-effort and non-blocking: the
  // reflection stores ids, and a cold offline launch has no catalog — the
  // chips fall back to the id rather than the section vanishing, because
  // "you drilled 3 things but we can't name them" is still worth showing.
  useEffect(() => {
    let cancelled = false;
    fetchTechniques(getToken)
      .then((list) => {
        if (!cancelled) setTechniques(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  // HR report (N480/#825, N488/#849) — best-effort and non-blocking, same
  // shape as the technique lookup above. A session that never ended has no
  // window to have computed metrics from, so this doesn't even ask; a
  // finished one may still have nothing (no wearable, offline, or the watch
  // hasn't synced yet — design doc §6.4: "session_metrics being absent is a
  // normal state, not an error"), and `getSessionMetrics` already turns that
  // 404 into `null` rather than throwing. `<HRSessionReport>`
  // (components/HRSessionReport.tsx, backed by lib/hrSessionReport.ts) is
  // what decides whether — and how much of — any of this reaches the screen.
  const [hrMetrics, setHrMetrics] = useState<SessionMetrics | null>(null);
  // Separate from `hrMetrics` itself: `null` is BOTH "haven't asked yet" and
  // "asked, and there is genuinely nothing" (a 404), and `<HRSessionReport>`
  // reads `metrics === null` as the latter — an honest "no HR data" card. Not
  // gating on this would flash that card for every session while the fetch
  // is still in flight, the exact "an in-flight load is not an empty answer"
  // bug `components/TrendCard.tsx`'s own tests exist to catch, one screen
  // over.
  const [hrLoaded, setHrLoaded] = useState(false);
  useEffect(() => {
    // No synchronous reset here on purpose (react-hooks/set-state-in-effect):
    // `hrMetrics` already starts `null`, and nothing on this screen ever
    // un-ends a session for the same `id`, so there is no path that leaves a
    // stale value behind for this to clear. This reasons about `id` staying
    // fixed for the component instance's lifetime — true today (nothing
    // navigates from this screen to itself with a different `id`), but if a
    // future "next/previous session" control ever does, React Navigation
    // would reuse this instance across ids without unmounting it, and this
    // effect would need an explicit reset back to `null`/`false` before the
    // fetch for the new `id` starts.
    if (!id || !session?.ended_at) return;
    let cancelled = false;
    getSessionMetrics(getToken, id)
      .then((m) => {
        if (!cancelled) {
          setHrMetrics(m);
          setHrLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHrMetrics(null);
          setHrLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, session?.ended_at, getToken]);

  // N491/#852: the raw HR-over-time timeline (see lib/hrTimeline.ts's doc
  // comment for why this is a plain time series rather than a drill/roll
  // classifier). A second, independent fetch rather than piggybacking on
  // `hrMetrics` above — `GET /v1/biometric/samples` is a different endpoint
  // (raw readings, not the derived SessionMetrics row) and can fail or be
  // slow on its own without holding up the report's other numbers. Best-
  // effort and non-blocking, same posture as the fetch above: a failure here
  // just means no timeline renders, never an error surfaced to the athlete.
  const [hrTimeline, setHrTimeline] = useState<HRTimelinePoint[]>([]);
  useEffect(() => {
    const startedAt = session?.started_at;
    const endedAt = session?.ended_at;
    if (!id || !startedAt || !endedAt) return;
    let cancelled = false;
    listBiometricSamples(getToken, 'heart_rate', startedAt, endedAt)
      .then((samples) => {
        if (!cancelled) setHrTimeline(buildHRTimeline(samples, startedAt, endedAt));
      })
      .catch(() => {
        if (!cancelled) setHrTimeline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id, session?.started_at, session?.ended_at, getToken]);

  /**
   * Delete and Finish, which live here because nothing else offers them.
   *
   * Both had exactly one call site in the app — the strength session screen —
   * and routing BJJ away from it silently removed them. A double-logged class
   * would have been permanent on the phone, still feeding mat time and the
   * consistency grid, with no way to remove it.
   */
  function confirmDelete() {
    if (!userId || !id) return;
    Alert.alert('Delete this session?', 'It will be removed everywhere, not just on this phone.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await deleteLocalSession(userId, id);
            requestSync('bjj-session-deleted');
            router.back();
          })();
        },
      },
    ]);
  }

  async function finishNow() {
    if (!userId || !id) return;
    // Caught here rather than left to the caller: `HoldToConfirm` calls
    // `onConfirm` without awaiting, so a SQLite failure escaping this became
    // an unhandled rejection and, to the athlete, a button that silently did
    // nothing. The screen has an error state; it should use it.
    try {
      // N492 follow-up to N487: when the athlete never opened the correction
      // sheet, this used to always pass `undefined` — real "now", regardless
      // of what day the session is dated to. That is the N434 bug back
      // again, on this screen only: a session rescheduled to a past day (the
      // month-grid sheet above, `commitReschedule`) and then finished today
      // got `ended_at` stamped with today's real timestamp, a multi-day
      // "duration" the elapsed Stat and history both read literally.
      // `finishTimestampFor` is the same mapping the strength screen
      // (`app/session/[id].tsx`) already applies — it returns `undefined`
      // (real "now") when the session's day IS today, so the ordinary path
      // is unchanged; it only maps onto the session's own day when it isn't.
      // `session!` — same non-null assertion the strength screen's own
      // finish handler uses for the same reason: `finishNow` is only ever
      // reachable from `HoldToConfirm`, which this screen renders solely
      // inside the `!session.ended_at` branch below, so `session` is always
      // populated by the time a press can fire it. TS cannot see that across
      // the closure boundary.
      const endedAt = finishEndOverride
        ? finishEndOverride.toISOString()
        : finishTimestampFor(new Date(session!.started_at), new Date());
      await finishLocalSession(userId, id, endedAt);
      await load();
      requestSync('bjj-session-finished');
      /*
        BJJ gets the same card, with its own vocabulary — rounds and mat time
        rather than sets and tonnage — and no PR row, because `lib/records.ts`
        is strength-only.

        It DOES now get a badge. This comment used to end "it stays honest
        until the accomplishments work lands"; that work landed, and the badge
        is a server-derived FIRST rather than the "you showed up" wallpaper the
        old text was refusing. The distinction it was protecting is intact:
        these fire once each in an athlete's life, so the common case here is
        still no badge at all. See `lib/accomplishments.ts`.
      */
      /*
        Read back rather than taken from `session`.

        `await load()` cannot refresh the `session` in this closure — those are
        render-time captures, and `setSession` has no way to reach an already-
        running function. The pre-finish value has `ended_at: null` by
        definition (the button only renders when it is null), so the duration
        was coming from a `?? Date.now()` fallback that happened to be about
        right. Correct by accident is not correct.
      */
      const finished = await readLocalSession(userId, id);
      const base = finished ?? session;
      if (!base) return;
      const bjjSummary = bjjSummaryFor(base, detail);
      if (worthCelebrating(bjjSummary)) {
        // All three together — see the strength screen's note. A stale
        // milestone surviving into a second celebration would chime a rung
        // this session did not cross.
        setCelebrationStreak(null);
        setCelebrationMilestone(null);
        setStreakSettled(false);
        setCelebrating(bjjSummary);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function commitRename() {
    if (!userId || !id) return;
    const ok = await renameLocalSession(userId, id, draftName);
    setRenaming(false);
    if (ok) {
      await load();
      requestSync('bjj-session-renamed');
    }
  }

  /**
   * N436: the one field the "Edit detail" wizard can't touch, because it
   * lives on the session record rather than in the reflection blob that
   * wizard edits.
   *
   * Errors surface rather than being swallowed — unlike the rename above,
   * this changes what the app has already been TOLD happened (mat time
   * counts toward this day's training, this day's streak), so a silent
   * failure here would leave the sheet claiming a move that never landed on
   * this device, let alone the server.
   */
  async function commitReschedule(day: Date) {
    if (!userId || !id) return;
    try {
      const ok = await rescheduleLocalSession(userId, id, day);
      if (!ok) {
        setReschedulingError("Couldn't find this session on this device.");
        return;
      }
      setReschedulingAnchor(null);
      setReschedulingError(null);
      await load();
      requestSync('bjj-session-rescheduled');
    } catch (err) {
      setReschedulingError(err instanceof Error ? err.message : String(err));
    }
  }

  // ABOVE the early returns below, and it has to stay there.
  //
  // This was the only hook after them, so the first render (loading) called one
  // fewer hook than every render after it — "Rendered more hooks than during the
  // previous render", a black screen on every BJJ session opened from Today.
  // The rule is positional: React matches hooks by call order, so a hook after a
  // conditional return is a hook that sometimes does not run.
  //
  // Every technique with evidence, drilled or not — the same union the wizard's
  // live step takes, and for the same reason. Keyed off the drilled list alone,
  // a technique tried live but not drilled today showed NOWHERE: saved, synced,
  // and invisible. Reachable without a focus list even existing — remove a
  // drilled chip and its attempted/scored rows deliberately survive.
  const techniqueRows = useMemo(() => {
    const ids: string[] = [];
    for (const t of detail?.tags ?? []) {
      if (!t.technique_id) continue;
      if (t.event === 'conceded') continue;
      if (!ids.includes(t.technique_id)) ids.push(t.technique_id);
    }
    return ids;
  }, [detail?.tags]);

  /*
    The class as a shareable card — and, like the memo above, a HOOK, so it
    belongs above the early returns and must stay there.

    A BJJ class could only be shared in the seconds the completion modal was
    open. That is the wrong window for a card built out of rounds, rolling
    minutes and how the session felt: those are the parts of a class worth
    posting, and they are the parts you look at again later. The summary is
    the same one finishing builds, so the two cards cannot drift.

    No streak is passed. "Carried the streak" is a claim about the week the
    class happened in, and recomputing it against the current week would put a
    badge on a class that did not earn it — or drop one that did.
  */
  const share = useSessionShare({
    sessionID: session?.ended_at ? id : undefined,
    summary: session?.ended_at ? bjjSummaryFor(session, detail) : null,
    // BJJ never shows a tonnage tile, so this is never called — passed because
    // the card takes one formatter, not one per sport.
    formatTonnage: (v) => `${Math.round(v)}`,
    // BJJ hard-codes `records: []` (see `bjjSummaryFor`), so `prBadgeFor`
    // never gets a record to caption and this is never called either — same
    // reasoning as `formatTonnage` above.
    formatWeight: (v) => `${Math.round(v)}`,
    // The night of the class, not the night you got round to sharing it.
    date: session?.ended_at ? new Date(session.ended_at) : undefined,
  });

  if (loading) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Session' }} />
        <ActivityIndicator accessibilityLabel="Loading your session" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centre} testID="bjj-session-missing">
        <Stack.Screen options={{ title: 'Session' }} />
        <Text style={styles.centreTitle}>This session isn’t on this device</Text>
        <Text style={styles.centreMuted}>
          It may have been logged elsewhere and not synced here yet.
        </Text>
      </View>
    );
  }

  const minutes = minutesBetween(session.started_at, session.ended_at);
  const rolling = detail ? rollingMinutes(detail) : 0;
  const kindLabel = detail ? (KINDS.find((k) => k.key === detail.kind)?.label ?? detail.kind) : '';

  const drilled = (detail?.tags ?? []).filter((t) => t.event === 'drilled');
  // `scored` here is untagged only, mirroring the wizard's tagCount. The
  // category grid is fed by the wizard's live step, which writes untagged
  // rows; counting the drilled step's per-technique outcomes as well would
  // make this screen report a bigger number than the wizard shows for the
  // same session, with nothing to explain the gap.
  //
  // `conceded` is NOT filtered that way, and the asymmetry is deliberate. No
  // screen in this app can author a technique-tagged conceded row — the API
  // accepts one and removeDrilledTechnique goes out of its way to preserve
  // one — so filtering it here would leave it with no display surface
  // anywhere: saved, synced, and invisible. There is no editor for it to
  // disagree with, so the grid is the honest place for it.
  // `!t.label` moves this in step with the wizard's own grid (`tagCount` /
  // `bump` in `lib/bjjSession.ts` and `app/bjj/reflect/[id].tsx`) — a
  // labelled ("kept unmatched") tag is never part of that anonymous total
  // there, so it must not silently reappear in this screen's version of
  // the same total. It has its own section below (`unmatched`) instead.
  const live = (detail?.tags ?? []).filter(
    (t) => (t.event === 'conceded' || (!t.technique_id && t.event === 'scored')) && !t.label,
  );
  // N119/#508: every tag the athlete named but the library never matched —
  // across every event a tag can carry, not just the two `live` happens to
  // cover above, because "kept as said" (`apps/mobile/app/bjj/dictate.tsx`)
  // can produce any of them. Without a section of its own, a kept-but-
  // unmatched `attempted`/`defended` tag would be saved, synced, and
  // invisible on this screen — the exact defect this ticket exists to fix,
  // recreated one screen along, the same way N31's comment above describes
  // for a technique tried live but never drilled.
  const unmatched = (detail?.tags ?? []).filter((t) => !t.technique_id && !!t.label);
  const summary = detail
    ? [kindLabel, detail.gi === null ? null : detail.gi ? 'Gi' : 'No-gi', detail.academy || null]
        .filter(Boolean)
        .join(' · ')
    : '';
  const hasAnyDetail =
    drilled.length + live.length + techniqueRows.length + unmatched.length > 0 ||
    !!detail?.note ||
    !!detail?.body_note ||
    !!detail?.academy ||
    detail?.session_rpe != null ||
    detail?.gi != null;

  return (
    <>
    <KeyboardAwareScrollView style={styles.container} contentContainerStyle={styles.body} testID="bjj-session-screen">
      <Stack.Screen options={{ title: 'Session' }} />

      {/* Name, and the ability to change it. The default comes from the kind,
          which is right until the session was a seminar or a comp class. */}
      {renaming ? (
        <RNView style={styles.renameRow}>
          <SelectAllTextInput
            value={draftName}
            onChangeText={setDraftName}
            autoFocus
            style={styles.renameInput}
            placeholder="Session name"
            placeholderTextColor={vola.textMuted}
            // Matches the server's maxNameLen. A longer name is a permanent
            // 400, and a permanent rejection on the push path strands the row.
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={commitRename}
            accessibilityLabel="Session name"
            testID="bjj-session-name-input"
          />
          <Pressable onPress={commitRename} hitSlop={10} accessibilityRole="button" testID="bjj-session-name-save">
            <Text style={[styles.renameAction, { color: accent.ink }]}>Save</Text>
          </Pressable>
        </RNView>
      ) : (
        <Pressable
          onPress={() => {
            setDraftName(session.name);
            setRenaming(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${session.name}. Rename this session`}
          testID="bjj-session-rename"
        >
          <Text style={styles.title}>{session.name}</Text>
          <Text style={styles.renameHint}>Tap to rename</Text>
        </Pressable>
      )}

      {/* N436: the date is the one field the "Edit detail" wizard below can't
          touch — it lives on the session record, not the reflection blob
          that wizard edits. Tap-to-edit, mirroring the name above it. */}
      <Pressable
        style={styles.whenPress}
        onPress={() => {
          setReschedulingError(null);
          const d = new Date(session.started_at);
          setReschedulingAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
        }}
        accessibilityRole="button"
        accessibilityLabel={`${new Date(session.started_at).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}. Tap to change the date.`}
        testID="bjj-session-date"
      >
        <Text style={styles.when}>
          {new Date(session.started_at).toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </Text>
        <Text style={styles.renameHint}>Tap to change date</Text>
      </Pressable>

      {/* The numbers a mat session actually has. Deliberately not a volume
          tile — see the file header.

          Effort is NOT in this row, and that is the point. Mat time and rolling
          time are measured; effort is what the athlete reckoned afterwards.
          Three identical tiles said all three were the same kind of fact, and
          the one that isn't sat on the end reading as a third measurement. See
          `backend/internal/modules/session/basis.go`. */}
      <RNView style={styles.stats}>
        <Stat value={minutes > 0 ? `${minutes}` : '—'} unit="min on the mat" />
        <Stat value={rolling > 0 ? `${rolling}` : '—'} unit="min rolling" />
      </RNView>

      {/* Below the measurements, labelled as the athlete's own account.
          Rendered even when absent, because "didn't say" is a real answer for a
          field the three-tap floor never asks for — and a missing rating must
          not read as an effort of zero. */}
      <RNView style={styles.reported} testID="bjj-session-reported">
        <Text style={styles.reportedLabel}>HOW IT FELT</Text>
        <Text style={styles.reportedValue}>
          {detail?.session_rpe
            ? `${detail.session_rpe}/${MAX_RPE} · ${describeRPE(detail.session_rpe)}`
            : 'Not recorded'}
        </Text>
      </RNView>

      {/* N480/#825 introduced a two-line HR corroboration here — value
          smaller and dimmer than `reported` above, secondary to the
          athlete's own RPE. N488/#849 replaces it with the fuller
          cross-sport report (TRIMP, zone breakdown, the effectiveness
          verdict) rather than keeping both on screen at once. `session_rpe`
          still feeds `sessionEffectivenessSummary`'s calibration the same
          way it always has — see `lib/hrSessionReport.ts`. */}
      {session.ended_at && hrLoaded && (
        <HRSessionReport
          metrics={hrMetrics}
          sessionRPE={detail?.session_rpe ?? null}
          hrTimeline={hrTimeline}
          testID="bjj-session-hr"
        />
      )}

      {/* Only when it says something the title doesn't. The name defaults to
          the kind, so an un-renamed session with no gi answer and no academy
          would otherwise render "Class" directly under "Class". */}
      {summary !== '' && summary !== session.name && (
        <Text style={styles.summary}>{summary}</Text>
      )}

      {techniqueRows.length > 0 && (
        <Section title="Techniques">
          <RNView style={styles.chips}>
            {techniqueRows.map((techniqueID) => {
              // The funnel, read back. Without these numbers `attempted` would
              // be written by the wizard and displayed nowhere — the exact
              // defect this feature exists to fix, recreated one screen along.
              const wasDrilled = drilled.some((d) => d.technique_id === techniqueID);
              const name = techniques.find((x) => x.id === techniqueID)?.name ?? techniqueID;
              const count = (e: 'attempted' | 'scored' | 'defended') =>
                techniqueOutcomeCount(detail?.tags ?? [], techniqueID, e);

              // Built as a list and joined, rather than as a chain of
              // conditional separators. The chain was already awkward at two
              // values and silently wrong at three: adding `defended` to it
              // meant a technique whose only evidence was defensive rendered
              // a chip with a completely blank funnel line — written by the
              // wizard, displayed nowhere, which is the exact defect the
              // comment above says this feature exists to fix.
              const parts: React.ReactNode[] = [];
              // "Drilled" is one fact among several rather than the thing that
              // puts a technique on this screen at all.
              if (wasDrilled) parts.push('drilled');
              // "missed", not "tried": these are the attempts that did not
              // land, and "3 tried, 1 landed" reads as 3 total of which 1 worked
              // -- a hit rate of 1/3 where the record says 1/4. Harmless as a
              // tally, wrong now that a roadmap's mastery criterion divides by
              // exactly this number.
              if (count('attempted') > 0) parts.push(`${count('attempted')} missed`);
              if (count('scored') > 0) {
                parts.push(<Text style={styles.scored}>{count('scored')} landed</Text>);
              }
              if (count('defended') > 0) {
                parts.push(<Text style={styles.scored}>{count('defended')} stopped</Text>);
              }

              return (
                <RNView key={techniqueID} style={styles.chip}>
                  <Text style={styles.chipText}>{name}</Text>
                  <Text style={styles.chipFunnel}>
                    {parts.map((part, i) => (
                      <Text key={i}>
                        {i > 0 ? ' · ' : ''}
                        {part}
                      </Text>
                    ))}
                  </Text>
                </RNView>
              );
            })}
          </RNView>
        </Section>
      )}

      {/* N119/#508: something the athlete named that the library never
          matched. Distinguishable on purpose — quoted, and labelled "not
          matched" — from `techniqueRows` above, whose chips name a real
          catalog entry. Read-only here; "Edit detail" below is where the
          athlete corrects it, either by matching it to a real technique now
          that one exists, or leaving it exactly as said. */}
      {unmatched.length > 0 && (
        <Section title="Said, not matched to the library">
          <RNView style={styles.chips}>
            {unmatched.map((t, i) => (
              <RNView key={i} style={styles.chip} testID="bjj-session-unmatched-chip">
                <Text style={styles.chipText}>
                  “{t.label}”{t.count > 1 ? ` ×${t.count}` : ''}
                </Text>
              </RNView>
            ))}
          </RNView>
        </Section>
      )}

      {live.length > 0 && (
        <Section title="What happened live">
          <RNView style={styles.liveRow}>
            <Text style={styles.liveLabel} />
            <Text style={styles.liveHead}>you</Text>
            <Text style={styles.liveHead}>them</Text>
          </RNView>
          {LIVE_ROWS.map((row) => {
            const scored = live
              .filter((t) => t.category === row.category && t.event === 'scored')
              .reduce((n, t) => n + t.count, 0);
            const conceded = live
              .filter((t) => t.category === row.category && t.event === 'conceded')
              .reduce((n, t) => n + t.count, 0);
            if (scored === 0 && conceded === 0) return null;
            return (
              <RNView key={row.category} style={styles.liveRow}>
                <Text style={styles.liveLabel}>{row.label}</Text>
                <Text style={[styles.liveNum, styles.scored]}>{scored || '—'}</Text>
                <Text style={[styles.liveNum, styles.conceded]}>{conceded || '—'}</Text>
              </RNView>
            );
          })}
        </Section>
      )}

      {!!detail?.note && (
        <Section title="Note">
          <Text style={styles.note}>{detail.note}</Text>
        </Section>
      )}
      {!!detail?.body_note && (
        <Section title="Body">
          <Text style={styles.note}>{detail.body_note}</Text>
        </Section>
      )}

      {/* The way back in. Without this the wizard is a one-way door: it is
          reached by `replace` from the log screen and nothing else links to
          it, so a session logged with "Log it" could never gain detail and a
          mis-tapped counter could never be corrected. */}
      <Pressable
        onPress={() => router.push({ pathname: '/bjj/reflect/[id]', params: { id: session.id } })}
        style={styles.cta}
        accessibilityRole="button"
        testID="bjj-session-edit-detail"
      >
        <Text style={[styles.ctaText, { color: accent.ink }]}>
          {drilled.length + live.length > 0 ? 'Edit detail' : 'Add detail'}
        </Text>
      </Pressable>

      {/* Only for a session with no end time. A BJJ session is normally
          logged complete, so this is the recovery path for one that was not —
          without it, Today's "in progress" card opens a screen with no way to
          close the session. */}
      {!session.ended_at && (
        <>
          {/* N487/#848: optional, above the hold-to-confirm rather than
              inside it — correcting the end time and confirming Finish stay
              two separate gestures, so a mis-tap on the sheet can never also
              close the session. Defaults to real "now"; only worth touching
              when this app-tracked session is being closed out well after
              training actually stopped.

              `notBefore={session.started_at}` — review finding (N487):
              without a floor, a mis-tapped "4h ago" on a session that
              started 40 minutes ago produces a negative duration that
              `minutesBetween` below silently reads as zero, and that bad
              `ended_at` still reaches the backend and feeds the exact HR
              join this ticket exists to fix. `log.tsx` needs no equivalent
              — its `started_at` is DERIVED from the chosen end time, so
              ordering there is structurally safe. */}
          <EndTimeCorrection
            value={finishEndOverride ?? new Date()}
            now={() => new Date()}
            notBefore={new Date(session.started_at)}
            onChange={setFinishEndOverride}
            testID="bjj-session-finish-end-time"
          />
          <HoldToConfirm
            label="Finish this session"
            holdingLabel="Keep holding to finish…"
            confirmTitle="Finish this session?"
            confirmBody="You won't be able to add to it afterwards."
            style={styles.cta}
            textStyle={[styles.ctaText, { color: accent.ink }]}
            testID="bjj-session-finish"
            onConfirm={finishNow}
          />
        </>
      )}

      {/*
        Share, for a class that is over.

        Above Delete and below Finish, which is the order these read in: the
        one thing left to do with a finished class is show somebody, and the
        destructive action stays last. Absent while the session is still open
        — there is no card to make of a class that has not ended.
      */}
      {!!share.error && (
        <Text style={styles.footnote} accessibilityLiveRegion="polite">
          {share.error}
        </Text>
      )}
      <ShareSessionButton
        share={share}
        label="Share this class"
        accessibilityLabel="Share this class"
        style={styles.share}
        testID="bjj-session-share"
      />

      <Pressable
        onPress={confirmDelete}
        style={styles.destructive}
        accessibilityRole="button"
        testID="bjj-session-delete"
      >
        <Text style={styles.destructiveText}>Delete session</Text>
      </Pressable>

      {/* Counts EVERY field the wizard writes, not just the tags: skipping
          both tag steps and typing a body note used to render the note above
          and "no detail recorded" beneath it, on the screen built to answer
          "I can't see any logs I've entered". */}
      {!hasAnyDetail && (
        <Text style={styles.footnote}>
          {remoteMissing
            ? 'No detail recorded — the session still counts. Add it any time; there’s no window that closes.'
            : 'Detail hasn’t reached this device yet. It’s safe on the server; pull to refresh once you have signal.'}
        </Text>
      )}
      {!!error && <Text style={styles.footnote}>Couldn’t load everything: {error}</Text>}

      {celebrating && (
        <SessionCelebration
          summary={celebrating}
          sessionID={id}
          // BJJ never shows a tonnage tile, so this is never called — passed
          // because the card takes one formatter, not one per sport.
          formatTonnage={(v) => `${Math.round(v)}`}
          // Same reasoning: BJJ hard-codes `records: []`, so the PR badge
          // formatter is never invoked either.
          formatWeight={(v) => `${Math.round(v)}`}
          onDismiss={() => setCelebrating(null)}
          streak={celebrationStreak}
          accomplishment={celebrationBadge}
          milestone={celebrationMilestone}
          // NO LONGER settled by construction, and the comment that used to sit
          // here said it was — correctly, until this session gained a badge to
          // look up. BJJ still hard-codes `records: []`, but the accomplishment
          // fetch is a real lookup that can answer late, so the streak chime has
          // to wait for it exactly as the strength card waits for its records.
          recordsSettled={badgeSettled}
          // And the reciprocal, which #284 made load-bearing here rather than
          // merely defensive: the badge lookup and the history lookup are now
          // two real races on this screen, so the badge chime has to wait for
          // the milestone exactly as the streak chime waits for the badge.
          // Without it a BJJ first would silence the rung it coincided with.
          streakSettled={streakSettled}
        />
      )}
    </KeyboardAwareScrollView>

    {/* OUTSIDE the scroll view, deliberately — a `ScrollView` clips its
        content, and the capture reads the real native view, so a host parked
        in there can hand the athlete a blank PNG. See
        `components/SessionShare.tsx`. */}
    <ShareCardHost share={share} />

    {/* N436's date-correction sheet — a plain month grid over
        `rescheduleLocalSession`, deliberately not a native date-picker
        dependency: this app has none today, and "correct the day" needs
        nothing a JS-only calendar can't already do (see `lib/calendar.ts`,
        already shared with the training calendar). No past/future
        restriction on the grid — the backend does not police it either, see
        `Reschedule`'s own comment, and an athlete logging the morning after
        or entering a class a day ahead of a scheduled seminar are both real. */}
    <Modal
      visible={reschedulingAnchor !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setReschedulingAnchor(null)}
    >
      <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg} testID="bjj-reschedule-sheet">
        <RNView style={styles.sheetHead}>
          <Pressable
            onPress={() =>
              setReschedulingAnchor((a) => (a ? new Date(a.getFullYear(), a.getMonth() - 1, 1) : a))
            }
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            testID="bjj-reschedule-prev-month"
          >
            <RNView style={{ transform: [{ rotate: '180deg' }] }}>
              <Icon name="chevron" size={16} color={vola.text} />
            </RNView>
          </Pressable>
          <Text style={styles.sheetTitle}>
            {(reschedulingAnchor ?? new Date()).toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric',
            })}
          </Text>
          <Pressable
            onPress={() =>
              setReschedulingAnchor((a) => (a ? new Date(a.getFullYear(), a.getMonth() + 1, 1) : a))
            }
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Next month"
            testID="bjj-reschedule-next-month"
          >
            <Icon name="chevron" size={16} color={vola.text} />
          </Pressable>
          <Pressable
            onPress={() => setReschedulingAnchor(null)}
            hitSlop={12}
            style={styles.sheetClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="bjj-reschedule-cancel"
          >
            <Text style={[styles.close, { color: accent.ink }]}>Cancel</Text>
          </Pressable>
        </RNView>

        {/* `KeyboardAwareScrollView`, not a bare `ScrollView` — this sheet has
            no text field of its own, but `keyboardCoverage.test.ts` checks
            per FILE, not per container, and this file already takes typing
            elsewhere (the rename input above). Degrades to a plain scroll
            view here: `KeyboardAwareScrollView` reads `FooterCtx` with a
            default value when there is no `KeyboardAwareScreen` ancestor —
            this Modal has none, and none of its three problems (a hidden
            field, unreachable content, a buried footer) apply to a sheet with
            no input and no footer — so this is exactly a `ScrollView` with
            nothing extra engaged. */}
        <KeyboardAwareScrollView contentContainerStyle={styles.sheetBody}>
          <RNView style={styles.quickRow}>
            <Pressable
              onPress={() => void commitReschedule(new Date())}
              style={styles.quickChip}
              accessibilityRole="button"
              testID="bjj-reschedule-today"
            >
              <Text style={styles.quickChipText}>Today</Text>
            </Pressable>
            <Pressable
              onPress={() => void commitReschedule(addDays(new Date(), -1))}
              style={styles.quickChip}
              accessibilityRole="button"
              testID="bjj-reschedule-yesterday"
            >
              <Text style={styles.quickChipText}>Yesterday</Text>
            </Pressable>
          </RNView>

          {!!reschedulingError && (
            <Text style={styles.reschedulingError} accessibilityLiveRegion="polite">
              {reschedulingError}
            </Text>
          )}

          <RNView style={styles.gridHead}>
            {calendarWeekDays(new Date()).map((d) => (
              <Text key={d.toISOString()} style={styles.gridHeadCell}>
                {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
              </Text>
            ))}
          </RNView>

          {monthGrid(reschedulingAnchor ?? new Date()).map((row) => (
            <RNView key={row[0].key} style={styles.gridRow}>
              {row.map((cell) => {
                const isToday = cell.key === dayString(new Date());
                const isCurrent = cell.key === dayString(new Date(session.started_at));
                return (
                  <Pressable
                    key={cell.key}
                    style={styles.gridCell}
                    onPress={() => void commitReschedule(cell.date)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isCurrent }}
                    accessibilityLabel={[
                      cell.date.toLocaleDateString(undefined, {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                      }),
                      isToday ? 'today' : null,
                      isCurrent ? "this session's current date" : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    testID={`bjj-reschedule-day-${cell.key}`}
                  >
                    <RNView
                      style={[
                        styles.gridDate,
                        isCurrent && styles.gridDateSelected,
                        isToday && [styles.gridDateToday, { backgroundColor: accent.accent }],
                      ]}
                    >
                      <Text
                        style={[
                          styles.gridDateText,
                          !cell.inMonth && styles.gridDateDim,
                          isCurrent && styles.gridDateTextSelected,
                          isToday && [styles.gridDateTextToday, { color: accent.on }],
                        ]}
                      >
                        {cell.date.getDate()}
                      </Text>
                    </RNView>
                  </Pressable>
                );
              })}
            </RNView>
          ))}
        </KeyboardAwareScrollView>
      </View>
    </Modal>
    </>
  );
}

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <RNView style={styles.stat}>
      {/* N508 — the glass wash, first so the figure paints over it. See
          `CardGlass`'s own doc comment for the material. */}
      <CardGlass />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statUnit}>{unit}</Text>
    </RNView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: vola.bg },
  body: { padding: Spacing.gutter, paddingBottom: Spacing.xxxl, gap: Spacing.xs },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xxl,
    gap: Spacing.sm,
  },
  centreTitle: { fontSize: 18, fontWeight: '700', color: vola.text, textAlign: 'center' },
  centreMuted: { ...Typography.body, color: vola.textMuted, textAlign: 'center' },

  title: { ...Typography.display, color: vola.text },
  renameHint: { ...Typography.caption, color: vola.textMuted, marginTop: Spacing.xxs },
  when: { ...Typography.body, color: vola.textMuted },
  whenPress: { marginBottom: Spacing.lg },

  renameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  renameInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: vola.text,
    borderBottomWidth: 2,
    borderBottomColor: vola.accent,
    paddingVertical: Spacing.xsPlus,
    minHeight: 44,
  },
  renameAction: { fontSize: 16, fontWeight: '700' },

  stats: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.md },
  // Deliberately NOT a `stat` tile. The measurements above are boxed and
  // centred; this is a labelled line, so the difference is visible before any
  // of the words are read.
  reported: { marginBottom: Spacing.md, gap: Spacing.xxs },
  reportedLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, color: vola.textDim },
  reportedValue: { ...Typography.body, color: vola.textMuted, fontStyle: 'italic' },
  // N480/#825's dedicated `hr`/`hrLabel`/`hrValue`/`hrCaption` styles lived
  // here — removed by N488/#849, which replaced the two-line corroboration
  // they drew with `<HRSessionReport>` (its own component, its own styles).
  //
  // N508 — this is the primary card on this screen, so it now takes
  // `Card.base` (the settled border colour included, where before this box
  // had no border at all) plus the glass wash (`<CardGlass />` at its JSX
  // call site).
  stat: {
    flex: 1,
    ...Card.base,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    gap: Spacing.xxs,
    overflow: 'hidden',
  },
  // 26 converges to `Typography.display` (28) — the nearest hero-figure role,
  // and the only fontSize-28 site this ticket's audit found outside a role.
  statValue: { ...Typography.display, color: vola.text },
  statUnit: { ...Typography.caption, color: vola.textMuted },

  summary: { fontSize: Typography.emphasis.fontSize, color: vola.text, marginBottom: Spacing.sm },

  section: { marginTop: Spacing.gutter, gap: Spacing.smPlus },
  sectionTitle: {
    fontSize: Typography.caption.fontSize,
    fontWeight: '700',
    letterSpacing: 1,
    color: vola.textMuted,
    textTransform: 'uppercase',
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    backgroundColor: vola.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.cardPadding,
    paddingVertical: Spacing.sm,
  },
  chipText: { ...Typography.body, color: vola.text },
  // The funnel numbers under the technique name. Muted by default because
  // the technique is what the eye is scanning for; `landed` picks up the
  // scored accent so the good half is findable at a glance.
  chipFunnel: { ...Typography.caption, color: vola.textMuted, marginTop: Spacing.xxs },

  liveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.xsPlus },
  liveLabel: { flex: 1, fontSize: Typography.emphasis.fontSize, color: vola.text },
  liveNum: { width: 56, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  liveHead: {
    width: 56,
    textAlign: 'center',
    fontSize: Typography.eyebrow.fontSize,
    letterSpacing: 1,
    color: vola.textMuted,
    textTransform: 'uppercase',
  },
  scored: { color: vola.lime },
  conceded: { color: vola.warn },

  note: { fontSize: Typography.emphasis.fontSize, lineHeight: 22, color: vola.text },

  cta: {
    marginTop: 28,
    backgroundColor: vola.surface,
    borderRadius: Radius.card,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  ctaText: { fontSize: 16, fontWeight: '700' },
  // `marginTop` matched to `cta`'s, because on a finished class Share is the
  // button that stands where Finish stood.
  share: { marginTop: 28 },
  destructive: {
    marginTop: Spacing.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  destructiveText: { ...Typography.emphasis, color: vola.danger },
  footnote: { ...Typography.meta, color: vola.textMuted, marginTop: Spacing.md, lineHeight: 19 },

  // The reschedule sheet — same shape as `TrainingCalendar`'s own month
  // sheet (`components/TrainingCalendar.tsx`), deliberately: an athlete who
  // has already used that calendar should recognise this grid rather than
  // learn a second one.
  sheet: { flex: 1 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.cardPadding,
    paddingHorizontal: Spacing.gutter,
    paddingTop: 18,
    paddingBottom: Spacing.cardPadding,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: vola.text },
  sheetClose: { marginLeft: 'auto' },
  close: { ...Typography.emphasis, fontWeight: '700' },
  sheetBody: { paddingHorizontal: Spacing.lg, paddingBottom: 44, gap: Spacing.xs },

  quickRow: { flexDirection: 'row', gap: Spacing.smPlus, marginBottom: Spacing.lg },
  quickChip: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  quickChipText: { ...Typography.emphasis, fontWeight: '700', color: vola.text },

  reschedulingError: { ...Typography.meta, color: vola.danger, marginBottom: Spacing.md },

  gridHead: { flexDirection: 'row', marginBottom: Spacing.xsPlus },
  gridHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: vola.textDim,
  },
  gridRow: { flexDirection: 'row', marginBottom: Spacing.xs },
  gridCell: { flex: 1, alignItems: 'center', paddingVertical: Spacing.xs },
  gridDate: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  gridDateSelected: { borderWidth: 1, borderColor: vola.line, backgroundColor: vola.surface },
  gridDateToday: { borderWidth: 0 },
  gridDateText: { ...Typography.emphasis, fontVariant: ['tabular-nums'], color: vola.text },
  gridDateDim: { color: vola.textDim, opacity: 0.5 },
  gridDateTextSelected: { fontWeight: '800' },
  // Colour comes from the same `accent.on` the background is set against —
  // set inline where the style is applied, not here, matching
  // `TrainingCalendar`'s own `dateTextToday`.
  gridDateTextToday: {},
});
