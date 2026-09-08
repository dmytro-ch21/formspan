import { useEffect, useRef } from 'react';

import { triggerBiometricSyncNow } from '../biometricSync';
import type { TokenGetter } from '../useAuthToken';
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
    void flushHRMonitorSamples(userId, getToken)
      .then((n) => {
        if (n > 0) triggerBiometricSyncNow(userId, getToken);
      })
      .catch(() => {
        // Offline — the rows stay pending; the orchestrator flushes later.
      });
    // Deliberately not keyed on `sessionID`: this fires on the active-to-
    // finished EDGE, and `flushHRMonitorSamples` is user-scoped rather than
    // session-scoped -- it uploads everything this athlete still owes,
    // whichever session recorded it. Adding `sessionID` would re-run the
    // effect on a route-param change and flush twice for no benefit.
  }, [active, userId, getToken]);
}
