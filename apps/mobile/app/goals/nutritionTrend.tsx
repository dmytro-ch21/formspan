import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { emptyCopy } from '@/components/TrendCard';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { shiftDate } from '@/lib/anthropometry';
import { dayString, shortDate } from '@/lib/calendar';
import { MAX_DAY_WINDOW, MEAN_WINDOW_DAYS, buildNutritionTrend } from '@/lib/nutritionTrend';
import { listDays, listTargets, type DayTotals, type StoredTarget } from '@/lib/nutritionApi';
import { type TrendRangeKey, RANGES } from '@/lib/trendSeries';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * "Am I hitting my target lately?" — N84, row 6 of the phone-impossible audit.
 *
 * The reduced phone form of `/dashboard/nutrition`. The carve-out argument —
 * why this is ONE metric rather than web's three-way join, and why the target
 * line is a flat reference rather than a second series — is in
 * `lib/nutritionTrend.ts`. This file is the same shape every mobile trend
 * screen is: range chips ending today, a delta, the chart, and the entries
 * behind it.
 *
 * **It fetches wide and slices locally, matching `app/goals/trend.tsx`.** The
 * first version of this screen re-fetched on every range tap, which is both a
 * wasted request AND a correctness bug: fetching `RANGE_DAYS[range]` meant an
 * athlete on `All` with genuinely older data than the fetch window still got
 * `empty.kind: 'none'` — "record your eating and the trend appears here",
 * asserted about an athlete who has data, just outside the window it asked
 * for. `trendSeries.ts`'s own header comment calls that exact collapse ("none"
 * vs. "none-in-range") the most repeated bug in this codebase. Fetching the
 * widest allowed window ONCE and letting `buildNutritionTrend` (via
 * `buildTrend`) slice it per range, the same way weight's `useWeightTrend`
 * does, makes every range chip free to tap and makes "All" actually mean all
 * of what was fetched.
 */

const MAX_ENTRIES = 200;
/** A fortnight of slack so the mean at the window's left edge has its lookback. */
const LOOKBACK_SLACK_DAYS = 14;

export default function NutritionTrendScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('1M');
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<DayTotals[]>([]);
  const [targets, setTargets] = useState<StoredTarget[]>([]);
  const [failed, setFailed] = useState(false);

  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      setLoading(true);
      // Fixed and independent of `range` — see the file header. The lead-in
      // slack is clamped into the cap rather than added past it, the same
      // clamp web's own `NutritionTrendPage` applies for the same reason.
      const from = shiftDate(today, -(MAX_DAY_WINDOW - 1 - LOOKBACK_SLACK_DAYS));

      Promise.allSettled([listDays(getToken, { from, to: today }), listTargets(getToken, { from, to: today })]).then(
        ([d, t]) => {
          if (!live) return;
          setLoading(false);
          if (d.status === 'fulfilled') {
            setDays(d.value);
            setFailed(false);
          } else {
            setFailed(true);
          }
          // A target read that fails leaves the chart readable with no goal
          // line, a stated absence rather than a wrong number — same rule
          // `useWeightTrend.ts` applies to a missing phase.
          setTargets(t.status === 'fulfilled' ? t.value : []);
        },
      );

      return () => {
        live = false;
      };
      // `range` deliberately absent — the fetch is wide and constant; only the
      // slice below depends on which chip is selected.
    }, [getToken, today]),
  );

  const { series, goalKcal, adherence } = useMemo(
    () => buildNutritionTrend(failed ? [] : days, targets, range, today),
    [failed, days, targets, range, today],
  );

  const fmt = (kcal: number) => Math.round(kcal).toString();

  return (
    <>
      <Stack.Screen options={{ title: 'Eating vs. target' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {loading ? (
          <ActivityIndicator />
        ) : (
          <>
            <RNView style={styles.ranges}>
              {RANGES.filter((r) => r.key !== 'Plan').map((r) => {
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
                    testID={`nutrition-trend-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="nutrition-trend-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} kcal
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="nutrition-trend-evidence">
                  {MEAN_WINDOW_DAYS}-day mean, from {series.delta.n}{' '}
                  {series.delta.n === 1 ? 'logged day' : 'logged days'}
                </Text>
              </RNView>
            ) : null}

            {failed ? (
              <Text style={styles.empty} testID="nutrition-trend-unavailable">
                {emptyCopy({ kind: 'unavailable' }, 'eating')}
              </Text>
            ) : (
              <>
                {/* Only rendered once the load has genuinely succeeded — this
                    used to render unconditionally, including directly above
                    the "couldn't load" message on a failed one, asserting
                    "0 of 30 days logged" beside a sentence saying nothing was
                    read at all. */}
                <Text style={styles.adherence} testID="nutrition-trend-adherence">
                  {adherence.logged} of {adherence.considered} days logged in this range
                </Text>

                {series.empty ? (
                  <Text style={styles.empty} testID="nutrition-trend-empty">
                    {emptyCopy(series.empty, 'eating')}
                  </Text>
                ) : (
                  <TrendChart
                    series={series}
                    goal={goalKcal}
                    format={fmt}
                    minSpan={100}
                    height={200}
                    formatDate={shortDate}
                    accessibilityLabel={`Mean daily kcal over ${rangeLabel(range)}, ${series.readings.length} logged days`}
                    testID="nutrition-trend-chart"
                  />
                )}

                <Text style={styles.note}>
                  The line is a {MEAN_WINDOW_DAYS}-day mean of logged days — a day you did not log
                  is a gap, not a zero, so it does not drag the line down. The dashed line is your
                  target.
                </Text>

                <Entries days={days} from={series.from} to={series.to} />
              </>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

function Entries({ days, from, to }: { days: DayTotals[]; from: string; to: string }) {
  const rows = useMemo(
    () =>
      days
        .filter((d) => d.eaten_on >= from && d.eaten_on <= to)
        .slice()
        .sort((a, b) => (a.eaten_on < b.eaten_on ? 1 : -1)),
    [days, from, to],
  );
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>DAYS LOGGED</Text>
      {rows.slice(0, MAX_ENTRIES).map((d) => (
        <RNView key={d.eaten_on} style={styles.entry} testID={`nutrition-trend-entry-${d.eaten_on}`}>
          <Text style={styles.entryDate}>{longDate(d.eaten_on)}</Text>
          <Text style={styles.entryValue}>
            {Math.round(d.kcal)} kcal{d.target_kcal != null ? ` / ${Math.round(d.target_kcal)}` : ''}
          </Text>
        </RNView>
      ))}
      {rows.length > MAX_ENTRIES ? (
        <Text style={styles.entriesMore}>Showing the most recent {MAX_ENTRIES} of {rows.length}.</Text>
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
    default:
      return 'all of it';
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

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  ranges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  range: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: vola.line },
  rangeText: { fontSize: 12 },
  delta: { fontSize: 22, fontWeight: '700' },
  since: { fontSize: 13, fontWeight: '400', opacity: 0.6 },
  evidence: { fontSize: 12, opacity: 0.55, marginTop: 2 },
  adherence: { fontSize: 13, color: vola.textMuted },
  empty: { fontSize: 14, opacity: 0.7, paddingVertical: 32, textAlign: 'center', lineHeight: 20 },
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
