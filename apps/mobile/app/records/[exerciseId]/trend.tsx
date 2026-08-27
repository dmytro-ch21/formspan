import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { emptyCopy } from '@/components/TrendCard';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { dayString, shortDate } from '@/lib/calendar';
import { LOAD_METRIC_LABEL, buildLoadTrend } from '@/lib/loadTrend';
import { fetchLoadHistory, type LoadHistory, type LoadPoint } from '@/lib/records';
import { RANGES, type TrendRangeKey } from '@/lib/trendSeries';
import { toDisplayWeight, weightUnit } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * One lift's top set, over time — N84, row 11 of the phone-impossible audit.
 *
 * The full carve-out argument (why this is now allowed, why there is no line
 * connecting the dots, why there is no goal) lives in `lib/loadTrend.ts` —
 * read that before changing anything about what this draws. This file is
 * deliberately the SAME shape as `app/goals/trend.tsx`: range chips, a delta,
 * the chart, and an entries list, in that order.
 */

const MAX_ENTRIES = 200;

export default function LoadTrendScreen() {
  const { exerciseId, name: nameParam } = useLocalSearchParams<{ exerciseId: string; name?: string }>();
  const getToken = useAuthToken();
  const { units } = useUnits();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('3M');
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<LoadHistory | null>(null);
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!exerciseId) return;
      let live = true;
      setLoading(true);
      fetchLoadHistory(getToken, exerciseId)
        .then((h) => {
          if (!live) return;
          setHistory(h);
          setFailed(false);
        })
        .catch(() => {
          if (live) setFailed(true);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
      return () => {
        live = false;
      };
    }, [getToken, exerciseId]),
  );

  const today = dayString(new Date());
  const { series, carriesLoad } = useMemo(
    () => buildLoadTrend(failed ? null : history, range, today),
    [failed, history, range, today],
  );

  const fmt = (kg: number) => Math.round(toDisplayWeight(kg, units)).toString();
  const unit = weightUnit(units);
  const name = nameParam || 'Exercise';

  return (
    <>
      <Stack.Screen options={{ title: name }} />
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
                    testID={`load-trend-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="load-trend-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} {unit}
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="load-trend-evidence">
                  {series.delta.n} {series.delta.n === 1 ? 'session' : 'sessions'} with a top set in
                  this range
                </Text>
              </RNView>
            ) : null}

            {!carriesLoad && !failed && history ? (
              <Text style={styles.empty} testID="load-trend-no-weight">
                {LOAD_METRIC_LABEL} needs a logged weight, and this exercise is measured a different
                way. Its record is on the exercise page.
              </Text>
            ) : series.empty ? (
              <Text style={styles.empty} testID="load-trend-empty">
                {failed
                  ? emptyCopy({ kind: 'unavailable' }, 'top set')
                  : emptyCopy(series.empty, 'top set')}
              </Text>
            ) : (
              <TrendChart
                series={series}
                format={fmt}
                minSpan={2.5}
                height={200}
                formatDate={shortDate}
                accessibilityLabel={`${LOAD_METRIC_LABEL} over ${rangeLabel(range)}, ${series.readings.length} sessions`}
                testID="load-trend-chart"
              />
            )}

            <Text style={styles.note}>
              Each dot is one session&apos;s top set. There is no line between them — sessions are not
              daily, so a gap between two real numbers means nothing on its own.
            </Text>

            <Entries points={history?.points ?? []} from={series.from} to={series.to} format={fmt} unit={unit} />
          </>
        )}
      </ScrollView>
    </>
  );
}

/**
 * The sessions behind the chart — scoped to the window on screen, matching
 * `app/goals/trend.tsx`'s own `Entries`: "the entries behind THIS chart" is
 * both the honest reading and what stops a lifetime of sessions being
 * re-sorted on every range tap.
 */
function Entries({
  points,
  from,
  to,
  format,
  unit,
}: {
  points: LoadPoint[];
  from: string;
  to: string;
  format: (kg: number) => string;
  unit: string;
}) {
  const rows = useMemo(
    () =>
      points
        .filter((p) => p.top_weight_kg != null && dayString(new Date(p.started_at)) >= from && dayString(new Date(p.started_at)) <= to)
        .slice()
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)),
    [points, from, to],
  );
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>SESSIONS</Text>
      {rows.slice(0, MAX_ENTRIES).map((p) => (
        <RNView key={p.session_id} style={styles.entry} testID={`load-trend-entry-${p.session_id}`}>
          <Text style={styles.entryDate}>{longDate(p.started_at)}</Text>
          <Text style={styles.entryValue}>
            {format(p.top_weight_kg as number)} {unit}
          </Text>
        </RNView>
      ))}
      {rows.length > MAX_ENTRIES ? (
        <Text style={styles.entriesMore}>
          Showing the most recent {MAX_ENTRIES} of {rows.length}.
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
    default:
      return 'all of it';
  }
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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
