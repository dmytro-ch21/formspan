import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { TrendCard } from '@/components/TrendCard';
import { shiftDate, trendWeight, type Measured } from '@/lib/anthropometry';
import { listCheckins, listPhases, type Checkin, type Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';
import type { Projection as PlanProjectionWire } from '@/lib/nutritionApi';
import { buildTrend, fromPlanProjection, type Reading } from '@/lib/trendSeries';
import { toDisplayWeight, weightUnit } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * Weight, at the top of Goals.
 *
 * **It fetches its own data on purpose.** `app/(tabs)/goals.tsx` is 1190 lines,
 * several sessions edit it, and it loads neither check-ins nor phases — so
 * threading three more requests and their failure states through it would put a
 * large diff in the most contended file in the app to render one card. This way
 * that screen gains two lines and the card owns everything it needs.
 *
 * The cost is one extra round trip when Goals opens. Accepted: the requests are
 * small, they are independent, and the card degrades to a sentence rather than
 * to a spinner that blocks the screen behind it.
 *
 * **The plan projection is a PROP, not a fetch, and that is not a style
 * choice.** Goals already loads the derivation and holds `basis.projection`;
 * fetching it again here made two components on one screen request the same
 * thing on every focus. `goalsScreen.test.tsx` caught it immediately — six
 * assertions that pin "does not refetch the targets or the proposal" went red
 * on a call count of 3 where 2 was expected. The tempting fix was to update
 * the expected number, which would have legitimised the duplicate request and
 * disarmed the guard that found it.
 */

const LOOKBACK_SLACK_DAYS = 14;
const WINDOW_DAYS = 365;
const MIN_SPAN_KG = 1;

export function WeightTrendCard({
  /** From Goals' own derivation — `basis.projection`. Null when there is none. */
  projection: plan,
}: {
  projection: PlanProjectionWire | null;
}) {
  const getToken = useAuthToken();
  const { units } = useUnits();
  const router = useRouter();

  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [failed, setFailed] = useState(false);

  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(WINDOW_DAYS + LOOKBACK_SLACK_DAYS));

      // Only the check-ins are fatal to the card. A goal we could not load
      // means no goal line — a stated absence rather than a wrong number.
      Promise.allSettled([
        listCheckins(getToken, { from, to: today }),
        listPhases(getToken),
      ]).then(([c, p]) => {
        if (!live) return;
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
    }, [getToken, today]),
  );

  const measured: Measured[] = useMemo(() => checkins ?? [], [checkins]);

  // `null` is "we could not ask" and is NOT the same as `[]`. Collapsing them
  // would tell an athlete with two years of weigh-ins that they have none,
  // because their train went into a tunnel.
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
        range: '1Y',
        smooth: (on) => trendWeight(measured, on),
        planFrom: phase?.started_on ?? null,
      }),
    [readings, today, measured, phase],
  );

  const projection = useMemo(
    () => fromPlanProjection(plan, series.readings[series.readings.length - 1] ?? null),
    [plan, series.readings],
  );

  return (
    <TrendCard
      title="WEIGHT"
      series={series}
      goal={phase?.target_weight_kg ?? null}
      projection={projection}
      format={(kg) => String(Math.round(toDisplayWeight(kg, units) * 10) / 10)}
      unit={weightUnit(units)}
      periodLabel="past year"
      minSpan={MIN_SPAN_KG}
      actionLabel="Record Weight"
      onAction={() => router.push(`/checkin/${today}`)}
      onOpen={() => router.push('/goals/trend')}
      testID="weight-trend-card"
    />
  );
}
