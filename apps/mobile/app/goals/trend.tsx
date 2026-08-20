import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { emptyCopy } from '@/components/TrendCard';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { shiftDate, trendWeight, type Measured } from '@/lib/anthropometry';
import { listCheckins, listPhases, type Checkin, type Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';
import { suggestedTarget, type Projection as PlanProjectionWire } from '@/lib/nutritionApi';
import {
  buildTrend,
  fromPlanProjection,
  RANGES,
  type Projection,
  type Reading,
  type TrendRangeKey,
} from '@/lib/trendSeries';
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

/** A fortnight of slack, so the mean at the far edge has its lookback. */
const LOOKBACK_SLACK_DAYS = 14;
/** The widest window a chip can ask for, plus the slack above. */
const FETCH_DAYS = 365 * 3;
/** Smallest y-axis span in kg. A stable fortnight would otherwise divide by zero. */
const MIN_SPAN_KG = 1;

export default function WeightTrendScreen() {
  const getToken = useAuthToken();
  const { units } = useUnits();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('1Y');
  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [plan, setPlan] = useState<PlanProjectionWire | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // `dayString`, NOT `toISOString().slice(0,10)`. That is the UTC date, and
  // check-ins are dated by the LOCAL calendar day: west of Greenwich an evening
  // opens the chart on an empty "tomorrow", and east of Greenwich a morning
  // weigh-in lands past the window's right edge and is dropped as a future
  // reading — invisible, on the day it was logged. Banned once in review
  // already.
  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(FETCH_DAYS + LOOKBACK_SLACK_DAYS));

      // The three are independent and only the check-ins are fatal. A goal we
      // could not load means no goal line; a plan we could not load means no
      // projection sentence. Neither is a reason to withhold the chart, and
      // both degrade to an ABSENCE that says so rather than to a wrong number.
      Promise.allSettled([
        listCheckins(getToken, { from, to: today }),
        listPhases(getToken),
        suggestedTarget(getToken, today),
      ]).then(([c, p, s]) => {
        if (!live) return;
        setLoading(false);
        if (c.status === 'fulfilled') {
          setCheckins(c.value);
          setFailed(false);
        } else {
          setFailed(true);
        }
        setPhase(p.status === 'fulfilled' ? (p.value.find((x) => x.ended_on == null) ?? null) : null);
        setPlan(s.status === 'fulfilled' ? (s.value.suggestion?.basis?.projection ?? null) : null);
      });

      return () => {
        live = false;
      };
    }, [getToken, today]),
  );

  const measured: Measured[] = useMemo(() => checkins ?? [], [checkins]);

  const readings: Reading[] | null = useMemo(() => {
    if (failed) return null; // "we could not ask" — never "you have none"
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
        // The smoothing is `lib/anthropometry.ts`'s and is not reimplemented
        // here — a second mean would be a third number the app could report for
        // the same body.
        smooth: (on) => trendWeight(measured, on),
        planFrom: phase?.started_on ?? null,
      }),
    [readings, today, range, measured, phase],
  );

  const goalKg = phase?.target_weight_kg ?? null;

  // The server's date, adapted — never one derived from the readings. See the
  // header note.
  const projection: Projection = useMemo(
    () => fromPlanProjection(plan, series.readings[series.readings.length - 1] ?? null),
    [plan, series.readings],
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
                axisLabels={[short(series.from), short(midpoint(series.from, series.to)), 'Today']}
                accessibilityLabel={`Weight over ${rangeLabel(range)}, ${series.readings.length} readings`}
                testID="trend-chart"
              />
            )}

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

            <Entries checkins={checkins ?? []} units={units} />
          </>
        )}
      </ScrollView>
    </>
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
  if (projection.kind === 'projected') {
    return (
      <Text style={styles.projection} testID="trend-projection-text">
        Based on your current plan, you&apos;ll reach {fmt(projection.basis.goal)} {unit} on{' '}
        {longDate(projection.onDate)}.
      </Text>
    );
  }
  if (goalKg == null) return null; // nothing to say about a goal nobody set
  return (
    <Text style={styles.projection} testID="trend-projection-text">
      {refusalCopy(projection.reason, fmt(goalKg), unit)}
    </Text>
  );
}

function refusalCopy(reason: string, goal: string, unit: string): string {
  switch (reason) {
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

/** The readings behind the chart, newest first. */
function Entries({ checkins, units }: { checkins: Checkin[]; units: UnitSystem }) {
  const rows = checkins
    .filter((c) => c.weight_kg != null && c.weight_kg > 0)
    .slice()
    .sort((a, b) => (a.measured_on < b.measured_on ? 1 : -1));
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>ENTRIES</Text>
      {rows.map((c) => (
        <RNView key={c.measured_on} style={styles.entry} testID={`trend-entry-${c.measured_on}`}>
          <Text style={styles.entryDate}>{longDate(c.measured_on)}</Text>
          <Text style={styles.entryValue}>
            {round1(toDisplayWeight(c.weight_kg as number, units))} {weightUnit(units)}
          </Text>
        </RNView>
      ))}
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

/** `2026-08-19` → `19 Aug`. Parsed as UTC, matching how the dates are stored. */
function short(on: string): string {
  const d = new Date(`${on}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
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

function midpoint(from: string, to: string): string {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return new Date(a + (b - a) / 2).toISOString().slice(0, 10);
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
