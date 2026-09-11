import { useEffect, useState } from 'react';

import { listBiometricSamples, type SessionMetrics } from './biometric';
import { buildHRTimeline, type HRTimelinePoint } from './hrTimeline';
import type { TokenGetter } from './useAuthToken';

/**
 * A finished session's heart-rate timeline, fetched and built over the window
 * its NUMBERS came from — the one implementation every session screen calls
 * (N563/#1068).
 *
 * It lived inline on the BJJ screen from N491/#852 until N545/#988. N563 wired
 * strength and running to the same chart, and the choice was three copies of
 * one effect or one hook — three copies of the one line that decides which
 * window the curve is drawn over is three chances to get it wrong.
 *
 * **It takes the metrics row, not two timestamps, and that is the point.**
 * W19/#985 moved a session's heart rate off the athlete's typed
 * `started_at`/`ended_at` and onto the watch's own workout window, because a
 * 90-minute class was being scored almost entirely from pre-class background
 * readings. A timeline drawn over the logged window puts a real curve — with
 * a real time axis and a marked peak since N545 — underneath an avg/max/TRIMP
 * measured from a different stretch of time: the bug W19 fixed, re-entered
 * through the chart. N545 had to correct exactly that on the BJJ screen. A
 * hook that accepted a start and an end would leave that decision at every
 * call site; one that accepts `SessionMetrics` reads
 * `hr_window_start`/`hr_window_end` itself, so no caller has a session time to
 * hand it. `hrReportWiring.test.ts` pins both halves at the source level —
 * this file reads no session time, and every screen passes its `hrMetrics`.
 *
 * **No metrics row, no fetch.** With nothing computed there is no window to be
 * right about, and `HRSessionReport` renders its `unavailable` card rather
 * than a timeline anyway — so an athlete with no heart rate gets no chart, no
 * empty frame and no axis, never a curve guessed over the logged window.
 *
 * Best-effort and non-blocking, the posture every HR read on these screens
 * shares: a separate endpoint from the metrics row (raw readings, not the
 * derived summary), so a failure or a slow response here costs the chart and
 * nothing else — `[]`, which the report draws as no timeline.
 *
 * No synchronous reset when the window changes, for the same
 * `react-hooks/set-state-in-effect` reason the BJJ screen gave: nothing on a
 * session screen moves a finished session's metrics from one window to
 * another for the same mounted `sessionID`.
 */
export function useSessionHRTimeline(
  getToken: TokenGetter,
  sessionID: string | undefined,
  metrics: Pick<SessionMetrics, 'hr_window_start' | 'hr_window_end'> | null,
): HRTimelinePoint[] {
  const [timeline, setTimeline] = useState<HRTimelinePoint[]>([]);
  const windowStart = metrics?.hr_window_start;
  const windowEnd = metrics?.hr_window_end;
  useEffect(() => {
    if (!sessionID || !windowStart || !windowEnd) return;
    let cancelled = false;
    listBiometricSamples(getToken, 'heart_rate', windowStart, windowEnd)
      .then((samples) => {
        if (!cancelled) setTimeline(buildHRTimeline(samples, windowStart, windowEnd));
      })
      .catch(() => {
        if (!cancelled) setTimeline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionID, windowStart, windowEnd, getToken]);
  return timeline;
}
