import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { listSessionLoad, type SessionLoad } from './biometric';
import { shiftDate } from './anthropometry';
import { dayString } from './calendar';
import { dailyLoads, weeklyTrainingLoad, type DailyLoad } from './trainingLoadTrend';
import { buildTrend, type Reading, type TrendRangeKey, type TrendSeries } from './trendSeries';
import type { TokenGetter } from './useAuthToken';

/**
 * Training load's wiring of the shared trend layer — N489/#850, the same
 * shape `useVo2MaxTrend.ts`/`useWeightTrend.ts` give their own metrics.
 *
 * No goal, no projection, same reasoning as VO2max: there is no target an
 * athlete sets for weekly TRIMP anywhere in this app, so those props are
 * simply omitted rather than threaded through as permanently-null.
 */
export type TrainingLoadTrend = {
  /** True until the first fetch settles. Render nothing rather than an absence. */
  loading: boolean;
  series: TrendSeries;
  /** The LOCAL calendar day — see `useWeightTrend.ts`'s identical note on
   *  why this is never a UTC date. */
  today: string;
  /** How many sessions with a computed load fall in the fetched window —
   *  distinct from `series.readings.length`, which counts DAYS, not
   *  sessions (two sessions on one day is one reading). Used by the empty
   *  copy to say "N sessions" rather than "N days" where that distinction
   *  matters. */
  sessionCount: number;
};

/**
 * A week of slack past the visible window, so the 7-day trailing sum at the
 * window's LEFT edge has its lookback available. Matches
 * `useWeightTrend.ts`'s `LOOKBACK_SLACK_DAYS` in spirit; smaller here because
 * the smoother only ever looks back `TRAINING_LOAD_WINDOW_DAYS` (7), not the
 * ~3-week window `trendWeight` needs.
 */
const LOOKBACK_SLACK_DAYS = 7;

export function useTrainingLoadTrend(
  getToken: TokenGetter,
  range: TrendRangeKey,
  windowDays: number,
): TrainingLoadTrend {
  const [sessions, setSessions] = useState<SessionLoad[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(windowDays + LOOKBACK_SLACK_DAYS));

      listSessionLoad(getToken, `${from}T00:00:00Z`, `${today}T23:59:59Z`)
        .then((rows) => {
          if (!live) return;
          setSessions(rows);
          setFailed(false);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
        })
        .finally(() => {
          if (live) setLoading(false);
        });

      return () => {
        live = false;
      };
    }, [getToken, today, windowDays]),
  );

  // `null` is "we could not ask" and is NOT `[]` — see `useWeightTrend.ts`'s
  // identical guard for why collapsing the two is a repeated defect here.
  const loads: DailyLoad[] | null = useMemo(() => {
    if (failed) return null;
    if (sessions == null) return [];
    return dailyLoads(sessions, (startedAt) => dayString(new Date(startedAt)));
  }, [sessions, failed]);

  const readings: Reading[] | null = useMemo(
    () => (loads == null ? null : loads.map((l) => ({ on: l.on, value: l.trimp }))),
    [loads],
  );

  const series = useMemo(
    () =>
      buildTrend({
        readings,
        today,
        range,
        smooth: (on) => (loads == null ? null : weeklyTrainingLoad(loads, on)),
        // A week of real training is one session, not three — see
        // `trainingLoadTrend.ts`'s own doc comment on why this gate is
        // "on/after the first session" rather than a minimum count. 1 is the
        // floor `buildTrend` accepts; the actual gating happens inside
        // `weeklyTrainingLoad` itself.
        minReadings: 1,
      }),
    [readings, today, range, loads],
  );

  return { loading, series, today, sessionCount: sessions?.length ?? 0 };
}
