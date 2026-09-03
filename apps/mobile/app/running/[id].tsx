import { useAuth } from '@clerk/clerk-expo';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import {
  averagePaceSecPerKm,
  elevationGainMeters,
  emptyDetail,
  RUN_EXERCISE_ID,
  splitsFromTrack,
  trackDistanceMeters,
  trackDurationSeconds,
  type RoutePoint,
  type SessionDetail as RunningDetail,
} from '@/lib/running';
import { emptySet } from '@/lib/sessions';
import {
  finishLocalSession,
  readLocalRunningDetail,
  readLocalSession,
  saveLocalRunningDetail,
  saveLocalSets,
} from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { formatElapsed } from '@/lib/rest';
import { formatDistance, formatPace } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';
import { announce } from '@/lib/voice';
import { newSplitIndices, spokenSplitAnnouncement } from '@/lib/runningVoice';

/**
 * Live GPS run tracking (N460/#771).
 *
 * The running-specific counterpart to `app/session/[id].tsx` — same
 * offline-first shape (local write first, the ordinary outbox carries the
 * rest), a completely different screen, because a run has a map and a clock
 * where a lift has a bar and a rep count. Reached only via `sessionHref` in
 * `lib/startSession.ts`, which is the one place `sport === 'running'` is
 * decided to route here rather than to the strength-shaped live logger — see
 * that file's comment for why this is a direct sport check rather than a
 * module-registry capability.
 *
 * ## Why GPS points are safe in a dead zone
 *
 * Every accepted point is appended to `running_json` on `local_sessions`
 * via `saveLocalRunningDetail` — the same column, the same `dirty` flag and
 * the same push loop `bjj_json` already uses (see `lib/sessionStore.ts`'s
 * `pushRow`). That write is pure SQLite: it does not wait on, or care about,
 * the network. A killed app or a fully dead radio loses at most the points
 * recorded since the last save, never the ones already written — and this
 * screen re-reads that same column on mount (`readLocalRunningDetail`), so
 * reopening a run picks up exactly where it left off.
 *
 * ## Why the clock survives a pause correctly
 *
 * `elapsedMsRef` accumulates ACTIVE time only — wall-clock deltas between a
 * Resume and the next Pause/Finish — rather than deriving duration from the
 * GPS track's own first/last timestamps, which `lib/running.ts`'s
 * `trackDurationSeconds` explicitly documents as wrong the moment a pause
 * exists (it would count the paused interval as running). Because it is
 * computed from `Date.now()` at each transition rather than from a ticking
 * JS timer, it is also correct across the phone being backgrounded — a
 * suspended `setInterval` catches up the instant the app resumes, since the
 * arithmetic only ever asks "what is `Date.now()` right now".
 */

const MIN_ACCURACY_M = 50;
/** How stale the last fix has to be before the screen admits GPS is weak. */
const SIGNAL_STALE_MS = 15000;

type Status = 'loading' | 'permission-denied' | 'tracking' | 'paused' | 'finished' | 'error';

export default function RunningSessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { units } = useUnits();

  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [signalWeak, setSignalWeak] = useState(false);
  const [sessionName, setSessionName] = useState('Run');
  // N465: only ever set for a session this screen did NOT track live — a
  // freshly finished run is always 'phone_gps' from `emptyDetail`'s default
  // and this screen never changes it, so this only matters for the
  // already-finished branch below, where reopening a HealthKit import from
  // Training History reads back whatever source it was saved with.
  const [source, setSource] = useState<RunningDetail['source']>('phone_gps');

  const mapRef = useRef<MapView | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  // Active-time bookkeeping — see the file doc comment above.
  const elapsedMsRef = useRef(0);
  const resumedAtRef = useRef<number | null>(null);
  const lastPointAtRef = useRef<number | null>(null);
  const pointsRef = useRef<RoutePoint[]>([]);
  // Guards against a slow permission/load sequence outliving an unmount.
  const mountedRef = useRef(true);
  // How many splits have already been announced — see the effect below. Null
  // means "not yet baselined": the value `announce`d splits are compared
  // against, established the moment tracking (re)starts so a resumed run's
  // already-completed splits are never replayed.
  const announcedSplitsRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const distanceMeters = useMemo(() => trackDistanceMeters(points), [points]);
  const splits = useMemo(() => splitsFromTrack(points), [points]);
  // Memoized separately from the map's own render: the 1s clock tick below
  // re-renders this component every second regardless of whether a GPS fix
  // arrived, and recomputing this array on every one of those renders would
  // make `Polyline` re-diff and re-send its entire coordinate list across
  // the bridge once a second for no reason — this only changes when `points`
  // actually does.
  const polylineCoordinates = useMemo(
    () => points.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [points],
  );
  const paceSecPerKm = useMemo(
    () => averagePaceSecPerKm(distanceMeters, elapsedSeconds),
    [distanceMeters, elapsedSeconds],
  );

  /**
   * Active seconds elapsed right now — `elapsedMsRef`'s accumulated total
   * plus whatever has ticked since the current tracking segment resumed (0
   * while paused/finished, since `resumedAtRef` is only non-null while
   * tracking).
   */
  const currentActiveSeconds = useCallback(() => {
    const active = resumedAtRef.current == null ? 0 : Date.now() - resumedAtRef.current;
    return Math.round((elapsedMsRef.current + active) / 1000);
  }, []);

  const persistProgress = useCallback(
    (finalised?: Partial<RunningDetail>) => {
      if (!userId || !id) return;
      const detail: RunningDetail = {
        ...emptyDetail(id),
        route_points: pointsRef.current,
        splits: splitsFromTrack(pointsRef.current),
        distance_m: trackDistanceMeters(pointsRef.current) || null,
        elevation_gain_m: elevationGainMeters(pointsRef.current) || null,
        // Included on EVERY save, not only at Pause/Finish — a kill-and-
        // relaunch mid-run must restore the clock along with the track, and
        // reading a stale `duration_seconds` (0, or whatever the last pause
        // wrote) would silently reset it to the wrong value the moment a new
        // point arrives and overwrites this same row.
        duration_seconds: currentActiveSeconds(),
        ...finalised,
      };
      // Fire-and-forget from the caller's point of view — this is a local
      // SQLite write and does not need to be awaited to be durable; awaiting
      // it here would make every GPS callback block on disk I/O.
      void saveLocalRunningDetail(userId, id, detail);
    },
    [id, userId, currentActiveSeconds],
  );

  // --- load: resume an in-progress run, or start a fresh one ---------------
  useEffect(() => {
    if (!id || !userId) return;
    let cancelled = false;
    (async () => {
      const session = await readLocalSession(userId, id);
      if (cancelled) return;
      if (!session || session.sport !== 'running') {
        setError('This run could not be found on this device.');
        setStatus('error');
        return;
      }
      setSessionName(session.name);

      if (session.ended_at) {
        // Already finished — reopening this screen (a killed app, a stray
        // deep link) shows the summary rather than re-arming GPS tracking.
        const existing = await readLocalRunningDetail(userId, id);
        if (existing) {
          setPoints(existing.route_points);
          pointsRef.current = existing.route_points;
          if (existing.duration_seconds != null) setElapsedSeconds(existing.duration_seconds);
          setSource(existing.source);
        }
        setStatus('finished');
        return;
      }

      // Resuming a run this device already has SOME track for — the app was
      // killed and relaunched mid-run. Not a fresh start: the points already
      // on disk survive, and the active-time clock resumes from the wall
      // clock rather than from zero. There is no "how long were you actually
      // paused" answer from a killed process, so the honest choice is to
      // treat everything already recorded as active time and continue from
      // now — the alternative (discarding it) would throw away real GPS
      // evidence of a run in progress.
      const existing = await readLocalRunningDetail(userId, id);
      if (existing && existing.route_points.length > 0) {
        setPoints(existing.route_points);
        pointsRef.current = existing.route_points;
        // `duration_seconds` is written on every save now (see
        // `persistProgress`), so this is normally populated. The fallback to
        // `trackDurationSeconds` covers a row saved before that fix, or any
        // other reason the field is missing — the track's own wall-clock span
        // is the honest floor for "how long has this run been going" when
        // nothing better survived the kill, exactly the case
        // `trackDurationSeconds`'s own doc comment reserves it for.
        elapsedMsRef.current =
          (existing.duration_seconds ?? Math.round(trackDurationSeconds(existing.route_points))) *
          1000;
      }

      const perm = await Location.getForegroundPermissionsAsync();
      let granted = perm.granted;
      if (!granted && perm.canAskAgain) {
        const requested = await Location.requestForegroundPermissionsAsync();
        granted = requested.granted;
      }
      if (cancelled || !mountedRef.current) return;
      if (!granted) {
        setStatus('permission-denied');
        return;
      }
      await startWatch();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userId]);

  // Stop the GPS watch on unmount under any circumstances — leaving one
  // running past the screen that owns it drains the battery and keeps the
  // location indicator lit for a run nobody is looking at any more.
  useEffect(() => {
    return () => {
      watchRef.current?.remove();
      watchRef.current = null;
    };
  }, []);

  async function startWatch() {
    resumedAtRef.current = Date.now();
    setStatus('tracking');
    requestSync('run-started');
    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 3000,
        distanceInterval: 8,
      },
      (loc) => {
        if (!mountedRef.current) return;
        // A wildly inaccurate fix (a bad multipath reflection indoors, a
        // cold-start estimate) is worse than a gap — it draws a spike in the
        // route and a spike in the distance total that no amount of later
        // good fixes removes, because distance is a sum of segments and a
        // bad segment's length does not un-happen.
        if (loc.coords.accuracy != null && loc.coords.accuracy > MIN_ACCURACY_M) return;
        lastPointAtRef.current = Date.now();
        setSignalWeak(false);
        const point: RoutePoint = {
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          elevation_m: loc.coords.altitude,
          recorded_at: new Date(loc.timestamp).toISOString(),
        };
        const next = [...pointsRef.current, point];
        pointsRef.current = next;
        setPoints(next);
        persistProgress();
        mapRef.current?.animateCamera(
          { center: { latitude: point.lat, longitude: point.lng } },
          { duration: 300 },
        );
      },
    );
    // The screen can unmount while this `await` was in flight — assigning
    // unconditionally would leak the subscription: nothing left holding its
    // reference would ever call `.remove()`, so the GPS indicator and the
    // battery cost outlive the screen.
    if (!mountedRef.current) {
      sub.remove();
      return;
    }
    // And a second `startWatch()` (a fast double-tap of Resume before the
    // first call's promise settles) must not leak the ONE it replaces —
    // whichever this is, it is the subscription this screen means to have
    // going forward, so any stale one is removed first rather than merely
    // overwritten.
    watchRef.current?.remove();
    watchRef.current = sub;
  }

  // Elapsed clock + weak-signal banner, both driven by wall-clock reads
  // rather than by counting ticks — see the file doc comment.
  useEffect(() => {
    if (status !== 'tracking') return;
    const timer = setInterval(() => {
      const active = resumedAtRef.current == null ? 0 : Date.now() - resumedAtRef.current;
      setElapsedSeconds(Math.round((elapsedMsRef.current + active) / 1000));
      setSignalWeak(
        lastPointAtRef.current != null && Date.now() - lastPointAtRef.current > SIGNAL_STALE_MS,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  /**
   * Announce each kilometre split the moment it completes (L13/#779).
   *
   * Not tracking (loading, paused, finished, permission-denied) always resets
   * the baseline to null, so the FIRST tick after tracking (re)starts only
   * establishes where to count from and never announces anything itself —
   * that is what stops a resumed run (killed and relaunched mid-run, or
   * simply un-paused) from replaying every split already on the track in one
   * burst. Only while `status === 'tracking'` on a SECOND or later run of
   * this effect does a newly grown `splits` array get spoken, via the same
   * `announce()` the guided-workout timer uses — which already checks the
   * athlete's Sounds/Spoken-cues preferences, so there is nothing to gate
   * here beyond calling it.
   */
  useEffect(() => {
    if (status !== 'tracking') {
      announcedSplitsRef.current = null;
      return;
    }
    if (announcedSplitsRef.current === null) {
      announcedSplitsRef.current = splits.length;
      return;
    }
    for (const i of newSplitIndices(announcedSplitsRef.current, splits.length)) {
      announce(spokenSplitAnnouncement(i, splits[i]));
    }
    announcedSplitsRef.current = splits.length;
  }, [status, splits]);

  async function pause() {
    if (status !== 'tracking' || !resumedAtRef.current) return;
    elapsedMsRef.current += Date.now() - resumedAtRef.current;
    resumedAtRef.current = null;
    watchRef.current?.remove();
    watchRef.current = null;
    setStatus('paused');
    setSignalWeak(false);
    persistProgress({ duration_seconds: Math.round(elapsedMsRef.current / 1000) });
    requestSync('run-paused');
  }

  async function resume() {
    if (status !== 'paused') return;
    await startWatch();
  }

  async function finish() {
    if (!userId || !id) return;
    if (status === 'tracking' && resumedAtRef.current) {
      elapsedMsRef.current += Date.now() - resumedAtRef.current;
      resumedAtRef.current = null;
    }
    watchRef.current?.remove();
    watchRef.current = null;

    const finalPoints = pointsRef.current;
    const finalDistance = trackDistanceMeters(finalPoints);
    const finalDuration = Math.round(elapsedMsRef.current / 1000);
    const finalSplits = splitsFromTrack(finalPoints);
    const finalElevationGain = elevationGainMeters(finalPoints);
    const finalPace = averagePaceSecPerKm(finalDistance, finalDuration);

    const detail: RunningDetail = {
      ...emptyDetail(id),
      route_points: finalPoints,
      splits: finalSplits,
      distance_m: finalDistance || null,
      duration_seconds: finalDuration,
      elevation_gain_m: finalElevationGain || null,
      avg_pace_sec_per_km: finalPace,
    };
    // These are three local SQLite writes, not network calls — but a full
    // disk or a corrupted row is still a real, if rare, way for one to
    // throw, and an unhandled rejection here left the screen showing
    // "tracking" with no watch running and no way to retry. Surfaced as the
    // ordinary error state rather than a silent stall.
    try {
      await saveLocalRunningDetail(userId, id, detail);

      // A `session_sets` row against the seeded `run` exercise, so the
      // generic personal-record pipeline (`longest_time`/`furthest_distance`)
      // sees this run exactly as
      // `internal/modules/running/running.go`'s package doc describes — the
      // running detail above is a SEPARATE fact for THIS module's own
      // screen, not what that pipeline reads.
      await saveLocalSets(userId, id, [
        {
          ...emptySet(RUN_EXERCISE_ID, 0),
          distance_m: finalDistance || null,
          seconds: finalDuration || null,
          completed: true,
        },
      ]);
      await finishLocalSession(userId, id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      return;
    }
    requestSync('run-finished');

    setPoints(finalPoints);
    setElapsedSeconds(finalDuration);
    setStatus('finished');
  }

  if (status === 'loading') {
    return (
      <View style={styles.center} testID="running-loading">
        <Stack.Screen options={{ title: sessionName }} />
        <ActivityIndicator accessibilityLabel="Loading your run" />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.center} testID="running-error">
        <Stack.Screen options={{ title: 'Run' }} />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (status === 'permission-denied') {
    return (
      <View style={styles.center} testID="running-permission-denied">
        <Stack.Screen options={{ title: sessionName }} />
        <Icon name="workout" size={40} color={vola.textMuted} />
        <Text style={styles.emptyTitle}>Location access needed</Text>
        <Text style={styles.muted}>
          VOLA tracks your route, distance and pace from your phone&rsquo;s GPS while
          you&rsquo;re running. Turn on location access for VOLA to start.
        </Text>
        <Pressable
          style={styles.secondary}
          onPress={() => Linking.openSettings()}
          accessibilityRole="button"
          testID="running-open-settings"
        >
          <Text style={styles.secondaryText}>Open Settings</Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'finished') {
    return (
      <View style={styles.container} testID="running-finished">
        <Stack.Screen options={{ title: sessionName }} />
        {/* N465: the only place a run's source is shown — see the ticket's
            "visually distinguishable" criterion. Phone-GPS and manual runs
            show nothing here; a badge on every run would be noise for the
            common case this screen exists to serve. */}
        {source === 'healthkit' && (
          <View style={styles.sourceBadge} testID="running-source-healthkit">
            <Icon name="check" size={12} color={vola.textMuted} />
            <Text style={styles.sourceBadgeText}>Imported from Apple Health</Text>
          </View>
        )}
        <StatRow>
          <Stat label="distance" value={formatDistance(distanceMeters, units)} icon="running" />
          <Stat label="time" value={formatElapsed(elapsedSeconds)} />
          <Stat label="pace" value={formatPace(paceSecPerKm, units)} />
        </StatRow>
        {/* N463: "is my distance climbing over the last few weeks" — reachable
            from every run, not only the one just finished, since this same
            branch renders whenever a past run is reopened from Training
            History (`sessionHref` in `lib/startSession.ts`). See
            `lib/runningTrend.ts` for the full carve-out argument. */}
        <Pressable
          onPress={() => router.push('/running/trend')}
          style={({ pressed }) => [styles.trendRow, pressed && styles.trendRowPressed]}
          accessibilityRole="button"
          accessibilityLabel="Distance over time"
          accessibilityHint="Your run distance, charted over time"
          testID="running-trend-link"
        >
          <View style={styles.trendRowText}>
            <Text style={styles.trendRowTitle}>Distance over time</Text>
            <Text style={styles.trendRowNote}>Every run, session by session.</Text>
          </View>
          <Icon name="chevron" size={16} color={vola.textMuted} />
        </Pressable>
        <Pressable
          style={styles.primary}
          onPress={() => router.replace('/(tabs)')}
          accessibilityRole="button"
          testID="running-done"
        >
          <Text style={styles.primaryText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  const last = points[points.length - 1];

  return (
    <View style={styles.container} testID="running-live-screen">
      <Stack.Screen options={{ title: sessionName }} />

      <MapView
        ref={mapRef}
        style={styles.map}
        showsUserLocation
        initialRegion={
          last
            ? { latitude: last.lat, longitude: last.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }
            : undefined
        }
      >
        {points.length > 1 && (
          <Polyline
            coordinates={polylineCoordinates}
            strokeColor={vola.lime}
            strokeWidth={4}
          />
        )}
        {last && (
          <Marker coordinate={{ latitude: last.lat, longitude: last.lng }} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.marker} />
          </Marker>
        )}
      </MapView>

      {signalWeak && (
        <View style={styles.signalBanner} accessibilityLiveRegion="polite">
          <Text style={styles.signalBannerText}>Weak GPS signal — still recording</Text>
        </View>
      )}

      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <StatRow>
          <Stat label="distance" value={formatDistance(distanceMeters, units)} icon="running" />
          <Stat label="time" value={formatElapsed(elapsedSeconds)} />
          <Stat label="pace" value={formatPace(paceSecPerKm, units)} />
        </StatRow>

        {splits.length > 0 && (
          <View style={styles.splits} testID="running-splits">
            {splits.map((s, i) => (
              <View key={i} style={styles.splitRow}>
                <Text style={styles.splitLabel}>Km {i + 1}</Text>
                <Text style={styles.splitValue}>{formatElapsed(s.duration_seconds)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.controls}>
          {status === 'tracking' ? (
            <Pressable
              style={styles.control}
              onPress={pause}
              accessibilityRole="button"
              accessibilityLabel="Pause run"
              testID="running-pause"
            >
              <Icon name="pause" size={28} color={vola.text} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.control, styles.controlAccent]}
              onPress={resume}
              accessibilityRole="button"
              accessibilityLabel="Resume run"
              testID="running-resume"
            >
              <Icon name="play" size={28} color={vola.bg} />
            </Pressable>
          )}
          <HoldToConfirm
            label="Hold to finish"
            holdingLabel="Keep holding…"
            onConfirm={finish}
            confirmTitle="Finish run?"
            confirmBody="This ends the run and saves your route, distance and pace."
            style={styles.finish}
            textStyle={styles.finishText}
            testID="running-finish"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  map: { flex: 1 },
  marker: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: vola.lime,
    borderWidth: 2,
    borderColor: vola.bg,
  },
  signalBanner: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: vola.warn,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  signalBannerText: { color: vola.bg, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  sheet: {
    backgroundColor: vola.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingHorizontal: 16,
    gap: 12,
  },
  splits: { maxHeight: 120, gap: 2 },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: vola.line,
  },
  splitLabel: { color: vola.textMuted, fontSize: 13 },
  splitValue: { fontWeight: '600', fontSize: 13 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  // 64pt — well past the 44pt minimum touch target, on the assumption this is
  // tapped mid-stride with an unsteady hand, not carefully at a bench.
  control: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: vola.surfaceRaised,
    borderWidth: 1,
    borderColor: vola.line,
  },
  controlAccent: { backgroundColor: vola.lime, borderColor: vola.lime },
  finish: {
    flex: 1,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: vola.danger,
  },
  finishText: { color: vola.bg },
  emptyTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  errorText: { color: vola.danger, fontSize: 15, textAlign: 'center' },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  sourceBadgeText: { color: vola.textMuted, fontSize: 12, fontWeight: '600' },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  trendRowPressed: { opacity: 0.85 },
  trendRowText: { flex: 1, gap: 2 },
  trendRowTitle: { fontSize: 15, fontWeight: '700' },
  trendRowNote: { color: vola.textMuted, fontSize: 13 },
  secondary: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  secondaryText: { fontWeight: '700', fontSize: 15 },
  primary: {
    backgroundColor: vola.lime,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
    marginHorizontal: 16,
    marginBottom: 24,
  },
  primaryText: { fontWeight: '700', fontSize: 15, color: vola.bg },
});
