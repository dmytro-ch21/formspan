import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { triggerBiometricSyncNow } from '../biometricSync';
import { triggerHealthConnectSyncNow } from '../healthConnectSync';
import { isHealthKitSupported } from '../healthkit';
import type { TokenGetter } from '../useAuthToken';
import { healthSourceFor } from '../vo2MaxSource';
import { MIN_SAMPLE_SPACING_MS, flushHRMonitorSamples, recordHRMonitorSample } from './hrRecorder';
import { subscribeLiveHRReadings } from './liveHR';

/**
 * N528/#958 — records the live stream into `hr_monitor_samples` for the
 * duration of one session, then uploads it. Mount it on a session screen
 * with `active` = "the session is in progress right now"; it does nothing
 * for a finished session, and nothing when no monitor is connected (there
 * are no readings to record).
 *
 * On the active→inactive edge (the athlete finished the session) it flushes
 * the rows and kicks the biometric enrichment pass, so the server computes
 * the report with the direct samples already in place rather than on the
 * next foreground. A failed flush is left for the next one — the rows are
 * on disk, that is the whole point of recording locally.
 */
export function useHRRecording(input: {
  userId: string | null | undefined;
  getToken: TokenGetter;
  sessionID: string | undefined;
  active: boolean;
}): void {
  const { userId, getToken, sessionID, active } = input;
  const lastAt = useRef(0);
  const wasActive = useRef(false);

  useEffect(() => {
    if (!userId || !sessionID || !active) return;
    wasActive.current = true;
    const unsubscribe = subscribeLiveHRReadings((bpm, at) => {
      if (at.getTime() - lastAt.current < MIN_SAMPLE_SPACING_MS) return;
      lastAt.current = at.getTime();
      void recordHRMonitorSample(userId, sessionID, bpm, at).catch(() => {
        // A failed local write is a lost reading, not a lost session — the
        // next one lands normally.
      });
    });
    return unsubscribe;
  }, [userId, sessionID, active]);

  useEffect(() => {
    if (active || !wasActive.current || !userId) return;
    wasActive.current = false;
    /**
     * N552/#1021 — the enrichment pass is kicked on EVERY finish, not only
     * when direct samples were flushed.
     *
     * The `n > 0` guard was right for the ticket that wrote it (N528: the
     * server should compute the report with the monitor's own samples in
     * place) and wrong for this one. A run finished with a non-broadcasting
     * wearable flushes zero rows, so the pass was not kicked, so the health
     * store was not asked until the next foreground return — and an athlete
     * who finishes a run and stays in the app has no foreground return. That
     * is the "supported path needs a poke" this ticket forbids.
     *
     * Kicking it unconditionally also picks up VO₂max (the same pass runs
     * both chains), which is the other half of #1021's third criterion and
     * is exactly what an Apple Watch writes shortly after an outdoor run.
     *
     * Platform-switched the same way `useSessionHRSync` switches: the
     * HealthKit pass returns immediately on Android and vice versa, so
     * calling the wrong one would silently do nothing.
     */
    const kickEnrichment = () => {
      const source = healthSourceFor(Platform.OS, isHealthKitSupported());
      if (source === 'healthkit') triggerBiometricSyncNow(userId, getToken);
      else if (source === 'health_connect') triggerHealthConnectSyncNow(userId, getToken);
    };
    void flushHRMonitorSamples(userId, getToken)
      .then(kickEnrichment)
      .catch(() => {
        // Offline — the rows stay pending; the orchestrator flushes later.
        // The pass is still kicked: a failed flush is about the MONITOR's
        // rows, and says nothing about whether the health store has
        // something to give this session.
        kickEnrichment();
      });
    // Deliberately not keyed on `sessionID`: this fires on the active-to-
    // finished EDGE, and `flushHRMonitorSamples` is user-scoped rather than
    // session-scoped -- it uploads everything this athlete still owes,
    // whichever session recorded it. Adding `sessionID` would re-run the
    // effect on a route-param change and flush twice for no benefit.
  }, [active, userId, getToken]);
}
