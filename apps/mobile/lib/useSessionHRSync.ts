import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { SessionMetrics } from './biometric';
import { enrichSessionNow } from './biometricSync';
import { enrichHealthConnectSessionNow, readHealthConnectImportEnabled } from './healthConnectSync';
import { isHealthKitSupported } from './healthkit';
import { readHealthKitImportEnabled } from './healthkitSync';
import { autoSyncNowDue, hrAbsenceState, sessionHasHeartRate, type HRAbsenceState, type SyncNowOutcome } from './hrAbsence';
import { readRememberedMonitor } from './hrMonitor/hrMonitorStore';
import type { TokenGetter } from './useAuthToken';
import { healthSourceFor, healthSourceLabel } from './vo2MaxSource';

/**
 * W18/#957 — what a session screen needs to render the no-HR card
 * honestly and to offer "Sync heart rate": which absence this is, what to
 * call the platform's Health store, and the one-session on-demand attempt
 * dispatched to the right platform module. Shared by the strength and BJJ
 * session screens so the platform switch lives in exactly one place.
 *
 * `absence` is set from an effect, not computed in render — it needs the
 * clock, and a `new Date()` in render is the impurity the hooks lint
 * rightly refuses. It resolves once the toggle read answers and again
 * whenever the session's end changes; the 3-day boundary it reads is not
 * something a screen has to track to the minute.
 */
export function useSessionHRSync(input: {
  userId: string | null | undefined;
  getToken: TokenGetter;
  sessionID: string | undefined;
  startedAt: string | undefined;
  endedAt: string | null | undefined;
  /**
   * N552/#1021 — the screen's own metrics read, so the automatic attempt
   * below can skip a session that already has heart rate. `metrics` is the
   * row (or `null`), `metricsLoaded` says whether the read has answered at
   * all — the two are separate on all three screens for exactly the reason
   * they are separate here: `null` means both "not asked yet" and "asked,
   * and there is genuinely nothing".
   */
  metrics: Pick<SessionMetrics, 'hr_source' | 'sample_count'> | null;
  metricsLoaded: boolean;
  /** Called after a `found` outcome — the screen re-reads its metrics so the
   *  report replaces the card. */
  onFound: () => void;
}): {
  absence: HRAbsenceState;
  sourceLabel: string;
  syncNow: () => Promise<SyncNowOutcome>;
  /** The remembered heart-rate monitor's name on this phone, or null. */
  monitorName: string | null;
} {
  const { userId, getToken, sessionID, startedAt, endedAt, metrics, metricsLoaded, onFound } = input;
  // Same platform resolution as `app/vo2max/trend.tsx` (W16/#945) — iOS
  // without the HealthKit module (a Simulator build) resolves to Health
  // Connect's *label* there too; harmless, `enrichSessionNow` answers
  // `sync_off` for it either way.
  const source = healthSourceFor(Platform.OS, isHealthKitSupported());
  // No Health store on this platform at all (web): nothing to read and
  // nothing the button could do — `sync_off` from the start, which also
  // hides the button. Decided in the initialiser rather than the effect
  // below so the effect never sets state synchronously.
  const [absence, setAbsence] = useState<HRAbsenceState>(() => (source === null ? 'sync_off' : 'loading'));

  useEffect(() => {
    if (!userId || source === null) return;
    let live = true;
    const read = source === 'healthkit' ? readHealthKitImportEnabled : readHealthConnectImportEnabled;
    read(userId)
      .then((on) => {
        if (live) setAbsence(hrAbsenceState({ syncOn: on, endedAt, now: new Date() }));
      })
      .catch(() => {
        // An unreadable pref reads as "off" — the card then points at
        // Settings, which is also where the athlete would fix it.
        if (live) setAbsence(hrAbsenceState({ syncOn: false, endedAt, now: new Date() }));
      });
    return () => {
      live = false;
    };
    // Not `sessionID`: this effect reads only the toggle and the session's
    // END, and a screen instance is one session for its lifetime (route per
    // session — the same reasoning both screens' own metrics effects give).
    // Two sessions with an identical RFC3339 end would be the one case this
    // could go stale, and the screen never navigates to itself with a new id.
  }, [userId, source, endedAt]);

  const syncNow = useCallback(async (): Promise<SyncNowOutcome> => {
    if (source === null) return { status: 'sync_off' };
    if (!userId || !sessionID || !startedAt) return { status: 'error' };
    const session = { id: sessionID, started_at: startedAt, ended_at: endedAt ?? null };
    const outcome =
      source === 'healthkit'
        ? await enrichSessionNow(userId, getToken, session)
        : await enrichHealthConnectSessionNow(userId, getToken, session);
    if (outcome.status === 'found') onFound();
    return outcome;
  }, [userId, getToken, sessionID, startedAt, endedAt, source, onFound]);

  /**
   * N552/#1021 — ONE automatic attempt, so an athlete whose wearable only
   * reaches VOLA through the health store never has to press anything to see
   * their own session. See `autoSyncNowDue` for every guard and why each one
   * is there; the ref is the "once per screen instance" half of it, kept in a
   * ref rather than state because flipping it must not itself re-render.
   *
   * Fire-and-forget: `syncNow` never throws (every failure is a
   * `SyncNowOutcome`), and a `found` outcome already calls `onFound`, which
   * is what replaces the card with the report. Nothing here needs the result.
   */
  const autoAttempted = useRef(false);
  useEffect(() => {
    if (!autoSyncNowDue({ absence, metricsLoaded, hasHeartRate: sessionHasHeartRate(metrics), alreadyAttempted: autoAttempted.current })) {
      return;
    }
    autoAttempted.current = true;
    void syncNow();
  }, [absence, metricsLoaded, metrics, syncNow]);

  // N528/#958: the remembered monitor's name, for the report's source line
  // ("From your Amazfit GTR 4"). Local to this phone by design.
  const [monitorName, setMonitorName] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    readRememberedMonitor(userId)
      .then((m) => {
        if (live) setMonitorName(m?.name ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId]);

  return { absence, sourceLabel: source === null ? 'Health' : healthSourceLabel(source), syncNow, monitorName };
}
