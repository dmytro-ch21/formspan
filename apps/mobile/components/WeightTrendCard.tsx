import { useRouter } from 'expo-router';

import { TrendCard } from '@/components/TrendCard';
import type { Projection as PlanProjectionWire } from '@/lib/nutritionApi';
import { toDisplayWeight, weightUnit } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';
import { useWeightTrend } from '@/lib/useWeightTrend';

/**
 * Weight, at the top of Goals.
 *
 * The fetch and the null/empty/failed discipline live in `useWeightTrend`,
 * shared with the full page. They were duplicated once and the copies diverged
 * in the way that mattered: only the page had a loading gate, so this card
 * rendered "Record your weight and the trend appears here" for the whole of the
 * first request. See the hook.
 *
 * It still fetches its own check-ins rather than taking them from Goals, on
 * purpose: `app/(tabs)/goals.tsx` is 1190 lines, several sessions edit it, and
 * it loads neither check-ins nor phases — so it gains two lines instead of
 * three requests and their failure states. The projection IS a prop, because
 * Goals already holds it and fetching it twice was a real duplicate request.
 */

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
  const { loading, series, goalKg, projection, today } = useWeightTrend(
    getToken,
    '1Y',
    WINDOW_DAYS,
    plan,
  );

  // Nothing rather than an absence. Every sentence the card could show right
  // now would be a claim about data we have not received yet, and the worst of
  // them blames the athlete for a request in flight.
  if (loading) return null;

  return (
    <TrendCard
      title="WEIGHT"
      series={series}
      goal={goalKg}
      projection={projection}
      format={(kg) => String(Math.round(toDisplayWeight(kg, units) * 10) / 10)}
      unit={weightUnit(units)}
      periodLabel="past year"
      minSpan={MIN_SPAN_KG}
      actionLabel="Record Weight"
      onAction={() => router.push(`/checkin/${today}`)}
      onOpen={() => router.push('/goals/trend')}
      openLabel="Open the full weight trend"
      testID="weight-trend-card"
    />
  );
}
