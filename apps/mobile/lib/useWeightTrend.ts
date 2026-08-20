import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { shiftDate, trendWeight, type Measured } from './anthropometry';
import { listCheckins, listPhases, type Checkin, type Phase } from './body';
import { dayString } from './calendar';
import type { Projection as PlanProjectionWire } from './nutritionApi';
import {
  buildTrend,
  fromPlanProjection,
  type Projection,
  type Reading,
  type TrendRangeKey,
  type TrendSeries,
} from './trendSeries';

/**
 * Weight's wiring of the trend layer, in one place.
 *
 * **It exists because the two consumers diverged and the divergence was a
 * bug.** The card and the full page each had their own copy of this fetch, and
 * only the page grew a loading gate — so the card rendered *"Record your weight
 * and the trend appears here"* for the whole of the first request, which is the
 * one sentence the empty-state union exists to make impossible. An athlete with
 * two years of weigh-ins saw it on every cold open of Goals. Found by review.
 *
 * ## Five states, not four
 *
 * `TrendEmpty` has four kinds and this hook has FIVE states, because
 * **"not answered yet" is not one of the four**. `loading` is returned
 * separately and both callers must gate on it; folding it into `none` is
 * exactly the collapse described above, and the type cannot stop you because
 * an unanswered fetch and an empty one both look like "no readings".
 */
export type WeightTrend = {
  /** True until the first fetch settles. Render nothing rather than an absence. */
  loading: boolean;
  series: TrendSeries;
  /** The live phase's target, or null — a maintenance phase has no number to hit. */
  goalKg: number | null;
  projection: Projection;
  /** The LOCAL calendar day. Never a UTC date — see below. */
  today: string;
  checkins: Checkin[];
};

/** A fortnight of slack, so the mean at the far edge has its lookback. */
const LOOKBACK_SLACK_DAYS = 14;

export function useWeightTrend(
  getToken: Parameters<typeof listCheckins>[0],
  range: TrendRangeKey,
  windowDays: number,
  /**
   * The plan projection, from the caller's own derivation. A PARAMETER rather
   * than a fetch: Goals already holds `basis.projection`, and fetching it here
   * made two components on one screen request the same derivation on every
   * focus — six assertions in `goalsScreen.test.tsx` caught it.
   */
  plan: PlanProjectionWire | null,
): WeightTrend {
  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // `dayString`, NOT `toISOString().slice(0,10)`. That is the UTC date, and
  // check-ins are dated by the LOCAL calendar day: west of Greenwich an evening
  // opens the chart on an empty "tomorrow", and east of it a morning weigh-in
  // lands past the window's right edge and is dropped as a future reading —
  // invisible, on the day it was logged. Banned once in review already.
  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(windowDays + LOOKBACK_SLACK_DAYS));

      // Only the check-ins are fatal. A goal we could not load means no goal
      // line — a stated absence rather than a wrong number.
      Promise.allSettled([
        listCheckins(getToken, { from, to: today }),
        listPhases(getToken),
      ]).then(([c, p]) => {
        if (!live) return;
        setLoading(false);
        if (c.status === 'fulfilled') {
          setCheckins(c.value);
          setFailed(false);
        } else {
          setFailed(true);
        }
        setPhase(p.status === 'fulfilled' ? (p.value.find((x) => x.ended_on == null) ?? null) : null);
      });

      return () => {
        live = false;
      };
    }, [getToken, today, windowDays]),
  );

  const measured: Measured[] = useMemo(() => checkins ?? [], [checkins]);

  // `null` is "we could not ask" and is NOT `[]`. Collapsing them would tell an
  // athlete with two years of weigh-ins that they have none, because their
  // train went into a tunnel.
  const readings: Reading[] | null = useMemo(() => {
    if (failed) return null;
    if (checkins == null) return [];
    return checkins
      .filter((c) => c.weight_kg != null && c.weight_kg > 0)
      .map((c) => ({ on: c.measured_on, value: c.weight_kg as number }));
  }, [checkins, failed]);

  const series = useMemo(
    () =>
      buildTrend({
        readings,
        today,
        range,
        // The smoothing is `lib/anthropometry.ts`'s and is not reimplemented —
        // a second mean would be a third number the app could report for the
        // same body.
        smooth: (on) => trendWeight(measured, on),
        planFrom: phase?.started_on ?? null,
      }),
    [readings, today, range, measured, phase],
  );

  const projection = useMemo(
    () => fromPlanProjection(plan, series.readings[series.readings.length - 1] ?? null),
    [plan, series.readings],
  );

  return {
    loading,
    series,
    goalKg: phase?.target_weight_kg ?? null,
    projection,
    today,
    checkins: checkins ?? [],
  };
}
