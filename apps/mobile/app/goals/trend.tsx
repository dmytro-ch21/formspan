import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { emptyCopy } from '@/components/TrendCard';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { shiftDate } from '@/lib/anthropometry';
import { type Checkin } from '@/lib/body';
import { dayString, shortDate } from '@/lib/calendar';
import { suggestedTarget, type Projection as PlanProjectionWire } from '@/lib/nutritionApi';
import { plotWindow } from '@/lib/trendChartLayout';
import { RANGES, type Projection, type TrendRangeKey, type TrendSeries } from '@/lib/trendSeries';
import { useWeightTrend } from '@/lib/useWeightTrend';
import { toDisplayWeight, weightUnit, type UnitSystem } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * The weight trend, in full.
 *
 * ## Why it lives under Goals rather than under check-in
 *
 * It used to be `app/checkin/trend.tsx`, and it was there because check-in was
 * the only place it could go. What it draws now — a projection toward a goal
 * line labelled with the target, a delta against a stated period, the entries
 * behind it — is goal-tracking rendered, and targets live in Goals as of N70.
 * Settled with N70's owner, who verified the route-group question by measuring
 * it: `app/goals/trend.tsx` and the `/goals` tab coexist, PROVIDED this
 * directory never gains an `index.tsx` — one here would fight the tab for
 * `/goals`.
 *
 * `checkin/trend.tsx` stays as a redirect. Logging your weight and then seeing
 * the line is the natural gesture, the mobile-first rule makes "harder to reach
 * than it was" a defect, and a redirect also protects installed builds whose
 * bundled JS predates the move.
 *
 * ## Two dates that sound identical, and only one of them belongs here
 *
 * The projection sentence says "based on your current plan", which is a claim
 * about the rate the PLAN prescribes — computed server-side by N69 and served
 * on the derivation basis. It is NOT the rate the athlete is observably
 * trending at, which this screen could compute locally and which routinely
 * disagrees. Rendering the local one under that sentence would put a date on
 * this screen that contradicts the same sentence in Goals, under copy asserting
 * they are the same thing (the N16 `offered_grips` drift). So this reads
 * `basis.projection` and `lib/trendSeries.ts` carries a `source` discriminator
 * that makes the alternative unrenderable.
 *
 * ## It fetches wide and slices locally
 *
 * The range row is instant because the data is already here. A year of daily
 * check-ins is ~365 small rows, and re-requesting on every chip would make a
 * control that exists to be tapped repeatedly feel like navigation.
 *
 * The trailing slack matters: the seven-day mean at the LEFT edge of a window
 * is computed from readings BEFORE it, so the fetch reaches further back than
 * any chart draws. Fetching exactly a year would make the oldest week of every
 * chart climb out of nothing.
 */

/**
 * The widest window a chip can ask for.
 *
 * **`All` therefore means "all of the last three years"**, and `windowStart`
 * anchors on the first FETCHED reading as though it were the first ever. True
 * enough today — the feature is younger than that — and it will quietly stop
 * being true. Raise this, or page the fetch, before anybody has four years of
 * weigh-ins. Flagged in review rather than discovered later.
 */
const FETCH_DAYS = 365 * 3;
/** Smallest y-axis span in kg. A stable fortnight would otherwise divide by zero. */
const MIN_SPAN_KG = 1;

export default function WeightTrendScreen() {
  const getToken = useAuthToken();
  const { units } = useUnits();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('1Y');
  const [plan, setPlan] = useState<PlanProjectionWire | null>(null);

  // The derivation is fetched here rather than by the hook: this screen has no
  // parent holding it, unlike the card in Goals. It is deliberately NOT fatal —
  // a plan we could not load means no projection sentence, which is a stated
  // absence rather than a wrong date.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      suggestedTarget(getToken, dayString(new Date()))
        .then((s) => {
          if (live) setPlan(s.suggestion?.basis?.projection ?? null);
        })
        .catch(() => {
          if (live) setPlan(null);
        });
      return () => {
        live = false;
      };
    }, [getToken]),
  );

  const { loading, series, goalKg, projection, today, checkins } = useWeightTrend(
    getToken,
    range,
    FETCH_DAYS,
    plan,
  );

  const fmt = (kg: number) => round1(toDisplayWeight(kg, units)).toString();
  const unit = weightUnit(units);

  return (
    <>
      <Stack.Screen options={{ title: 'Weight' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {loading ? (
          <ActivityIndicator />
        ) : (
          <>
            <RNView style={styles.ranges}>
              {RANGES.map((r) => {
                const on = r.key === range;
                return (
                  <Pressable
                    key={r.key}
                    onPress={() => setRange(r.key)}
                    hitSlop={8}
                    style={[styles.range, on && { backgroundColor: accent.accent }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={rangeLabel(r.key)}
                    testID={`trend-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="trend-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} {unit}
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="trend-evidence">
                  {series.delta.n} {series.delta.n === 1 ? 'reading' : 'readings'}
                  {series.delta.basis === 'readings'
                    ? ', measured between two of them rather than off the trend line'
                    : ''}
                </Text>
              </RNView>
            ) : null}

            {series.empty ? (
              <Text style={styles.empty} testID="trend-empty">
                {emptyCopy(series.empty, 'weight')}
              </Text>
            ) : (
              <TrendChart
                series={series}
                goal={goalKg}
                projection={projection}
                format={fmt}
                minSpan={MIN_SPAN_KG}
                height={200}
                formatDate={shortDate}
                accessibilityLabel={`Weight over ${rangeLabel(range)}, ${series.readings.length} readings`}
                testID="trend-chart"
              />
            )}

            {/* The chart tightens its left edge onto the data when the window
                is mostly empty — twelve readings in a 3M window used to draw
                every mark inside the right-hand tenth of the width, which reads
                as broken (W12). Tightening it silently would be its own lie, so
                the axis dates say where it starts and this says why. */}
            <ClipNote series={series} />

            <Pressable
              // The check-in for TODAY. `/checkin` is not a route — the typed
              // routes caught that, which is the whole reason N45 keeps the
              // generator honest.
              onPress={() => router.push(`/checkin/${today}`)}
              style={[styles.primary, { backgroundColor: accent.accent }]}
              accessibilityRole="button"
              testID="trend-record"
            >
              <Text style={[styles.primaryText, { color: accent.on }]}>Record Weight</Text>
            </Pressable>

            <ProjectionLine projection={projection} goalKg={goalKg} fmt={fmt} unit={unit} />

            <Text style={styles.note}>
              The line is a seven-day average; the dots and the labels are what the scale said.
              Day-to-day swings are mostly water, so the line is the one to read.
            </Text>

            <Entries checkins={checkins} units={units} from={series.from} to={series.to} />
          </>
        )}
      </ScrollView>
    </>
  );
}

/**
 * Why the chart does not start where the chip says.
 *
 * Rendered from the SAME function the chart lays itself out with, so the
 * sentence cannot drift from the drawing. Computing "is it clipped" a second
 * time here is how a caption ends up describing a chart nobody is looking at.
 */
function ClipNote({ series }: { series: TrendSeries }) {
  const win = plotWindow(series);
  if (!win.clipped || win.firstDataDay == null) return null;
  return (
    <Text style={styles.note} testID="trend-clipped">
      No readings in this range before {shortDate(shiftDate(series.from, win.firstDataDay))}, so the
      chart starts where your data does.
    </Text>
  );
}

/**
 * The plain-language projection.
 *
 * **Renders a sentence for every outcome, including every refusal.** An absence
 * here is the thing an athlete most wants explained — "why is there no date" —
 * and blank space answers it with nothing. The one state that stays silent is
 * having no goal at all, where a sentence about a goal you never set would be
 * noise rather than information.
 *
 * A `reached_on` the server did not compute is NOT an all-clear. "We did not
 * check" and "it checks out" are different answers, and this is exactly the
 * surface that would flatten the first into a missing line reading as fine.
 */
function ProjectionLine({
  projection,
  goalKg,
  fmt,
  unit,
}: {
  projection: Projection;
  goalKg: number | null;
  fmt: (kg: number) => string;
  unit: string;
}) {
  // `source === 'plan'` is checked HERE, not merely upstream. The module's
  // claim is that the discriminator makes an observed date unrenderable under
  // this sentence, and that was only true because nothing currently feeds one
  // in — a claim about today's call graph, not an invariant. One rewire (an
  // observed fallback when the plan is missing, say) would have put the wrong
  // date under "based on your current plan" with no type error. Found by
  // review.
  if (projection.kind === 'projected' && projection.source === 'plan') {
    return (
      <Text style={styles.projection} testID="trend-projection-text">
        Based on your current plan, you&apos;ll reach {fmt(projection.basis.goal)} {unit} on{' '}
        {longDate(projection.onDate)}.
      </Text>
    );
  }
  // Projected, but from the OBSERVED trend rather than the plan. Not this
  // sentence's claim, so it says nothing rather than borrowing the copy — the
  // whole point of the discriminator.
  if (projection.kind === 'projected') return null;
  if (goalKg == null) return null; // nothing to say about a goal nobody set
  return (
    <Text style={styles.projection} testID="trend-projection-text">
      {refusalCopy(projection, fmt(goalKg), unit)}
    </Text>
  );
}

/**
 * The sentence for a refusal — the server's words where it sent any, ours
 * otherwise.
 *
 * **The server's prose wins, and that is the point of N101.** `project` in
 * `backend/internal/modules/nutrition/target.go` already decides WHICH kind of
 * unreachable a plan is and writes display-ready prose naming the setting at
 * fault. The phone used to throw that away and render one invented sentence
 * covering both cases — true of either, and vaguer than what had already been
 * computed, while `apps/web`'s `Feasibility` showed the real thing. Two
 * surfaces telling an athlete different amounts about the same plan.
 *
 * Phrased to match web's, deliberately — `Feasibility` in
 * `apps/web/.../nutrition/targets/Derivation.tsx` says *"This plan never
 * reaches X kg — «reason». Change the goal weight or the phase."* and this is
 * that sentence, so an athlete who reads it in both places is not left working
 * out whether the two surfaces disagree about their plan.
 *
 * **The fallbacks stay, and they are not dead code.** `serverReason` is only
 * ever set on the plan-sourced refusal; `reached`, `no-trend` and a locally
 * computed `stalled` reach here with nothing but the enum, and every one of
 * them still has to render a sentence. Blank space is the failure this whole
 * area exists to prevent.
 *
 * Exported for its own test. Expo Router reads only the default export from a
 * route file, so a named one alongside it is inert — and the alternative was
 * moving weight-and-plan copy into the metric-agnostic trend modules, which is
 * how `lib/trendSeries.ts` would start authoring sentences about bodies.
 */
export function refusalCopy(
  projection: Extract<Projection, { kind: 'none' }>,
  goal: string,
  unit: string,
): string {
  // Normalised to absent-or-non-empty by `fromPlanProjection`, so this is the
  // whole check — no dangling em dash is reachable from here.
  if (projection.serverReason) {
    return `This plan never reaches ${goal} ${unit} — ${projection.serverReason}. Change the goal weight or the phase.`;
  }
  switch (projection.reason) {
    case 'reached':
      return `You're at your ${goal} ${unit} goal.`;
    case 'moving-away':
      return `Your plan doesn't move toward ${goal} ${unit}, so there's no date to show yet.`;
    case 'stalled':
      return `At your current plan's rate you don't reach ${goal} ${unit} — there's no date to show.`;
    default:
      // `no-trend`, and anything the server declined to compute. Deliberately
      // NOT "you're on track": we did not check, which is not the same as fine.
      return `Not enough yet to say when you'll reach ${goal} ${unit}.`;
  }
}

/**
 * The readings behind the chart, newest first.
 *
 * **Scoped to the window on screen**, which is both the honest reading of
 * "the entries behind THIS chart" and the fix for a real cost: unscoped, a
 * daily logger's `1W` chart sat above three years of rows, re-sorted and
 * re-rendered on every chip tap, unvirtualized inside a ScrollView. Capped as
 * well, and the cap is STATED rather than silent — a list that quietly stops
 * is one an athlete would read as "that is all of them".
 */
const MAX_ENTRIES = 200;

function Entries({
  checkins,
  units,
  from,
  to,
}: {
  checkins: Checkin[];
  units: UnitSystem;
  from: string;
  to: string;
}) {
  const rows = useMemo(
    () =>
      checkins
        .filter(
          (c) =>
            c.weight_kg != null && c.weight_kg > 0 && c.measured_on >= from && c.measured_on <= to,
        )
        .slice()
        .sort((a, b) => (a.measured_on < b.measured_on ? 1 : -1)),
    [checkins, from, to],
  );
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>ENTRIES</Text>
      {rows.slice(0, MAX_ENTRIES).map((c) => (
        <RNView key={c.measured_on} style={styles.entry} testID={`trend-entry-${c.measured_on}`}>
          <Text style={styles.entryDate}>{longDate(c.measured_on)}</Text>
          <Text style={styles.entryValue}>
            {round1(toDisplayWeight(c.weight_kg as number, units))} {weightUnit(units)}
          </Text>
        </RNView>
      ))}
      {rows.length > MAX_ENTRIES ? (
        <Text style={styles.entriesMore}>
          Showing the most recent {MAX_ENTRIES} of {rows.length} in this range.
        </Text>
      ) : null}
    </View>
  );
}

function rangeLabel(key: TrendRangeKey): string {
  switch (key) {
    case '1W':
      return 'the last week';
    case '1M':
      return 'the last month';
    case '3M':
      return 'the last three months';
    case '6M':
      return 'the last six months';
    case '1Y':
      return 'the last year';
    case 'All':
      return 'all of it';
    case 'Plan':
      return 'this plan';
  }
}

function longDate(on: string): string {
  const d = new Date(`${on}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  ranges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  range: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: vola.line },
  rangeText: { fontSize: 12 },
  delta: { fontSize: 22, fontWeight: '700' },
  since: { fontSize: 13, fontWeight: '400', opacity: 0.6 },
  evidence: { fontSize: 12, opacity: 0.55, marginTop: 2 },
  empty: { fontSize: 14, opacity: 0.7, paddingVertical: 32, textAlign: 'center', lineHeight: 20 },
  primary: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  primaryText: { fontSize: 15, fontWeight: '700' },
  projection: { fontSize: 14, lineHeight: 20, opacity: 0.85 },
  note: { fontSize: 13, opacity: 0.65, lineHeight: 19 },
  entries: { gap: 2, marginTop: 6 },
  entriesHead: { fontSize: 11, letterSpacing: 1, opacity: 0.5, marginBottom: 4 },
  entriesMore: { fontSize: 12, opacity: 0.55, paddingTop: 8 },
  entry: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: vola.line,
  },
  entryDate: { fontSize: 14 },
  entryValue: { fontSize: 14, fontWeight: '600' },
});
