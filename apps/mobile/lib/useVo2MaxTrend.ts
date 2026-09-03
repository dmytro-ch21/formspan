import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { listBiometricSamples, type BiometricSample } from './biometric';
import { shiftDate } from './anthropometry';
import { dayString } from './calendar';
import { buildTrend, type Reading, type TrendRangeKey, type TrendSeries } from './trendSeries';
import type { TokenGetter } from './useAuthToken';

/**
 * VO₂max's wiring of the shared trend layer — the same shape
 * `useWeightTrend.ts` gives weight, reduced to what a device-estimated,
 * read-only metric with no goal actually needs.
 *
 * ## No smoothing, and that is a decision, not an omission
 *
 * `buildTrend`'s `smooth` is optional precisely for a metric like this one:
 * VO₂max is a sparse, daily-ish device ESTIMATE (design doc §3), not
 * something logged several times a day the way a weigh-in can be. Inventing
 * a rolling mean over data this sparse would manufacture the exact "confident
 * line through a hole" `trendSeries.ts`'s own doc comment warns against —
 * the chart draws the raw readings as dots and nothing else.
 *
 * ## No goal, no projection
 *
 * VO₂max has no target an athlete sets and no server-side plan to project
 * against (unlike weight's `phase.target_weight_kg`) — it is read-only
 * evidence, per design doc §3's "read, never computed... shown as a trend,"
 * so this hook returns neither.
 */
export type Vo2MaxTrend = {
  /** True until the first fetch settles. Render nothing rather than an absence. */
  loading: boolean;
  series: TrendSeries;
  /** The LOCAL calendar day — see `useWeightTrend.ts`'s identical note on
   *  why this is never a UTC date. */
  today: string;
  samples: BiometricSample[];
};

/** A fortnight of slack past the visible window, for parity with
 *  `useWeightTrend.ts`'s `LOOKBACK_SLACK_DAYS` — this metric draws no
 *  smoothed line, so nothing here actually needs the lookback today, but
 *  keeping the fetch window's shape identical means a future smoother has
 *  somewhere to read from without a second fetch-window change. */
const LOOKBACK_SLACK_DAYS = 14;

export function useVo2MaxTrend(
  getToken: TokenGetter,
  range: TrendRangeKey,
  windowDays: number,
): Vo2MaxTrend {
  const [samples, setSamples] = useState<BiometricSample[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(windowDays + LOOKBACK_SLACK_DAYS));

      listBiometricSamples(getToken, 'vo2_max', `${from}T00:00:00Z`, `${today}T23:59:59Z`)
        .then((rows) => {
          if (!live) return;
          setSamples(rows);
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
  const readings: Reading[] | null = useMemo(() => {
    if (failed) return null;
    if (samples == null) return [];
    return samples.map((s) => ({ on: dayString(new Date(s.measured_at)), value: s.value }));
  }, [samples, failed]);

  const series = useMemo(() => buildTrend({ readings, today, range }), [readings, today, range]);

  return { loading, series, today, samples: samples ?? [] };
}
