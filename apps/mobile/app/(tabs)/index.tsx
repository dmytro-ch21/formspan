import { useAuth } from '@clerk/clerk-expo';
import { request as requestSync, syncNow, useSyncState } from '@/lib/sync';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { formatElapsed } from '@/lib/rest';
import type { LoggedSet, Session } from '@/lib/sessions';
import { listLocalSessions } from '@/lib/sessionStore';
import { formatVolume } from '@/lib/units';
import { enabledSports, type Module } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/** Past this, an open session reads as abandoned rather than in progress. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * Completed, non-warm-up sets — the backend's own working-volume rule.
 *
 * The `completed` half was missed when progressive volume landed, so this row
 * said "5 working sets" and the session it linked to said "Sets 0". Two screens
 * disagreeing about the same session is worse than either number alone.
 */
function isWorkingSet(set: LoggedSet): boolean {
  return set.completed && set.set_type !== 'warmup';
}

function workingSets(s: Session): number {
  return s.sets.filter(isWorkingSet).length;
}

/**
 * Monday 00:00 in the device's own timezone.
 *
 * Monday because a training week is a training block and every programme
 * anyone writes starts one on a Monday. Local rather than UTC for the same
 * reason the history endpoint takes a `tz`: "this week" is a claim about the
 * athlete's calendar, not the server's.
 */
function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay() is 0 on Sunday, which is 6 days into the week, not -1.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

type WeekSummary = { sessions: number; volumeKg: number; days: number };

/**
 * This week's training, computed from the local store rather than fetched.
 *
 * Deliberately local. Today has to answer on a gym floor with no signal, and a
 * summary that blanks out offline would be worse than no summary at all. It
 * also cannot disagree with the session list directly beneath it, which a
 * separately-fetched rollup eventually would.
 */
function summariseWeek(sessions: Session[], now: Date): WeekSummary {
  const from = startOfWeek(now).getTime();
  const days = new Set<string>();
  let count = 0;
  let volumeKg = 0;

  for (const s of sessions) {
    const started = new Date(s.started_at);
    if (started.getTime() < from) continue;
    count++;
    days.add(started.toDateString());
    for (const set of s.sets) {
      // Weight × reps over working sets — the same rule the in-session header
      // uses, so the two can never report different numbers.
      if (isWorkingSet(set) && set.weight_kg != null && set.reps != null) {
        volumeKg += set.weight_kg * set.reps;
      }
    }
  }
  return { sessions: count, volumeKg, days: days.size };
}

/** e.g. "Thursday, 31 July" — orientation, not decoration. */
function todayLabel(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Whether this discipline is logged after the fact rather than started and
 * logged into.
 *
 * Keyed on the catalog kind rather than on `key === 'bjj'`, so a future
 * discipline whose sessions are technique-shaped gets the right flow without
 * this file learning its name — the same reasoning that moved the sport list
 * itself into the registry.
 */
function logsAfterwards(sportKey: string, mods: Module[]): boolean {
  return mods.find((m) => m.key === sportKey)?.capabilities.catalog === 'techniques';
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

  // Re-read the local list whenever a sync finishes. Without this the list is
  // only as fresh as the last focus, so a session logged on the web appeared
  // one focus late — and the sync this screen triggers on focus never showed
  // its own results.
  useEffect(() => {
    if (!userId || lastSyncAt === null) return;
    let alive = true;
    listLocalSessions(userId, 30)
      .then((rows) => {
        if (alive) setSessions(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lastSyncAt, userId]);

  // On focus rather than on mount: coming back from a session should show its
  // new numbers, not the list as it was when the tab first rendered.
  //
  // `now` is refreshed here too, and that is not cosmetic. A tab screen stays
  // mounted for the life of the process, so without this the date is frozen at
  // whenever the app first launched — use it on Sunday evening, reopen it on
  // Monday, and the header still says Sunday while `startOfWeek` anchors to
  // *last* Monday, reporting last week's training as this week's.
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      refreshSessions();
    }, [refreshSessions]),
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
  const active = useMemo(() => sessions.find((s) => !s.ended_at) ?? null, [sessions]);

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

  const week = useMemo(() => summariseWeek(sessions, now), [sessions, now]);
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

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="never"
      testID="today-screen"
    >
      <ScreenHeader title="Today" />

      <View style={styles.body}>
        <Text style={styles.date}>{todayLabel(now)}</Text>

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
            style={[styles.resumeCard, activeIsStale && styles.resumeCardStale]}
            onPress={() => router.push(`/session/${active.id}`)}
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
            <Text style={[styles.resumeEyebrow, activeIsStale && styles.resumeEyebrowStale]}>
              {activeIsStale ? 'UNFINISHED' : 'IN PROGRESS'}
            </Text>
            <Text style={styles.resumeTitle}>{active.name || active.sport}</Text>
            <Text style={styles.resumeMeta}>
              {activeIsStale
                ? new Date(active.started_at).toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : formatElapsed((now.getTime() - new Date(active.started_at).getTime()) / 1000)}
              {' · '}
              {workingSets(active)} {workingSets(active) === 1 ? 'working set' : 'working sets'}
            </Text>
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
            {/* From the registry, filtered to what this athlete actually
                trains. This list used to be hardcoded to strength and running,
                with a comment explaining that BJJ had been removed by hand —
                three copies of the sport list existed elsewhere in this app,
                all disagreeing. */}
            {startable.map((s, i) => (
              <Pressable
                key={s.key}
                style={[styles.startButton, i > 0 && styles.startButtonSecondary]}
                // BJJ logs rather than starts, and goes somewhere else
                // entirely. On the mat you cannot touch a phone — sweaty
                // hands, a mouthguard, six-minute rounds — so BJJ inverts
                // the strength flow: zero interaction during the session,
                // everything recalled straight after. Sending it to
                // `/session/start` gave it a live set logger it can never
                // legally hold a set in (there are no BJJ exercises since
                // migration 000019), which is the shape this replaces.
                onPress={() =>
                  logsAfterwards(s.key, modules)
                    ? router.push('/bjj/log')
                    : router.push(`/session/start?sport=${s.key}`)
                }
                accessibilityRole="button"
                accessibilityLabel={
                  logsAfterwards(s.key, modules) ? `Log a ${s.label} session` : `Start a ${s.label} session`
                }
                testID={`start-session-${s.key}`}
              >
                <Text style={[styles.startText, i > 0 && styles.startTextSecondary]}>
                  {/* NOT lowercased: the registry carries the label precisely so BJJ
                      stays "BJJ". Lowercasing it renders "Start bjj". */}
                  {i === 0 ? `${logsAfterwards(s.key, modules) ? 'Log' : 'Start'} ${s.label}` : s.label}
                </Text>
              </Pressable>
            ))}
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
            this is the one number that changes how the next hour goes. */}
        {week.sessions > 0 && (
          <View style={styles.weekCard} testID="week-summary">
            <Text style={styles.eyebrow}>THIS WEEK</Text>
            <View style={styles.statRow}>
              <Stat
                value={String(week.sessions)}
                label={week.sessions === 1 ? 'session' : 'sessions'}
              />
              {/* Dash until the unit is known, rather than a number in the wrong
                  one: this used to render kilograms for a moment to an athlete
                  set to pounds, and on a finished-session mount that moment is
                  exactly when it is read. */}
              <Stat
                value={unitsReady ? formatVolume(week.volumeKg, units) : '—'}
                label="volume"
              />
              <Stat value={String(week.days)} label={week.days === 1 ? 'day' : 'days'} />
            </View>
          </View>
        )}

        {recent.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.eyebrow}>RECENT</Text>
            {recent.map((s) => (
              <Pressable
                key={s.id}
                style={styles.sessionRow}
                onPress={() => router.push(`/session/${s.id}`)}
                accessibilityRole="button"
                // Folds the meta line in, because the label replaces the
                // children rather than adding to them.
                accessibilityLabel={`${s.name || s.sport} session, ${describeSession(s, modules)}`}
                testID={`session-${s.id}`}
              >
                <View style={styles.sessionMain}>
                  <Text style={styles.sessionName}>{s.name || s.sport}</Text>
                  <Text style={styles.muted}>{describeSession(s, modules)}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
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
              {syncing ? <ActivityIndicator /> : <Text style={styles.retryText}>Retry</Text>}
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
    </ScrollView>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    // Grouped, or VoiceOver reads "3" and "sessions" as two disconnected
    // stops with no relationship between them.
    <View style={styles.stat} accessible accessibilityLabel={`${value} ${label} this week`}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // No horizontal padding here: the header manages its own, so it can sit
  // flush while the cards below stay inset.
  container: { gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  body: { paddingHorizontal: 20, gap: 16 },
  date: { color: vola.textMuted, fontSize: 13, marginTop: -4 },
  eyebrow: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '700' },

  resumeCard: {
    backgroundColor: vola.surfaceRaised,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: vola.lime,
    padding: 18,
    gap: 4,
  },
  // Stale sessions drop the lime entirely: lime is this app's "act on this
  // now", and a workout from last Tuesday is not that.
  resumeCardStale: { borderColor: vola.line, backgroundColor: vola.surface },
  resumeEyebrow: { color: vola.lime, fontSize: 11, letterSpacing: 1.2, fontWeight: '700' },
  resumeEyebrowStale: { color: vola.warn },
  resumeActionStale: { backgroundColor: 'transparent', borderWidth: 1, borderColor: vola.line },
  resumeActionTextStale: { color: vola.text },
  resumeTitle: { fontSize: 22, fontWeight: '700' },
  // Tabular figures so a ticking clock doesn't shuffle the text beside it.
  resumeMeta: { color: vola.textMuted, fontSize: 14, fontVariant: ['tabular-nums'] },
  resumeAction: {
    marginTop: 12,
    backgroundColor: vola.lime,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  resumeActionText: { color: vola.navy, fontWeight: '700', fontSize: 16 },

  startBlock: { gap: 8 },
  startButton: {
    backgroundColor: vola.lime,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  // Secondary sports are present but not competing: one primary action per
  // screen, or there is no primary action.
  startButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: vola.line,
    paddingVertical: 13,
  },
  startText: { color: vola.navy, fontWeight: '700', fontSize: 16 },
  startTextSecondary: { color: vola.text, fontWeight: '600', fontSize: 15 },

  weekCard: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    padding: 16,
    gap: 12,
  },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { flex: 1, gap: 2 },
  statValue: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { color: vola.textDim, fontSize: 12 },

  section: { gap: 2 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
    gap: 12,
  },
  sessionMain: { flex: 1, gap: 2 },
  sessionName: { fontWeight: '600', fontSize: 15 },
  chevron: { color: vola.textDim, fontSize: 20 },

  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pendingText: { color: vola.warn, fontSize: 13 },
  retryText: { color: vola.lime, fontWeight: '600', fontSize: 14 },
  syncError: { color: vola.danger, fontSize: 13, marginTop: -8 },

  errorText: { color: vola.danger, fontSize: 13 },
  muted: { color: vola.textMuted, fontSize: 13 },
  empty: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
});
