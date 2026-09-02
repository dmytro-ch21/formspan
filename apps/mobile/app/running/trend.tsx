import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { emptyCopy } from '@/components/TrendCard';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { dayString, shortDate } from '@/lib/calendar';
import { buildDistanceTrend, runPointsFromSessions, type RunSessionPoint } from '@/lib/runningTrend';
import { listSessionsPage } from '@/lib/sessions';
import { RANGES, type TrendRangeKey } from '@/lib/trendSeries';
import { distanceUnit, toDisplayDistanceLong } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * Distance over time, for every run — N463, the running counterpart to
 * `app/records/[exerciseId]/trend.tsx`.
 *
 * Deliberately the SAME shape as that screen and as `app/goals/trend.tsx`:
 * range chips, a delta, the chart, an entries list, in that order. The full
 * carve-out argument (why one metric, why no connecting line, why there is
 * no goal) lives in `lib/runningTrend.ts` — read that before changing what
 * this draws.
 */

/** The widest page the generic session list will hand back in one request —
 *  matches `session.maxLimit` on the backend. `All` reaches only this far
 *  back; a runner with more history than that sees the oldest trimmed, same
 *  as `lib/records.ts`'s `maxLoadHistoryPoints` trims per-exercise load. */
const MAX_SESSIONS = 200;
/** Smallest y-axis span, in metres. Stops an unusually consistent stretch of
 *  identical-distance runs dividing by zero. */
const MIN_SPAN_M = 500;
const MAX_ENTRIES = 200;

export default function RunningDistanceTrendScreen() {
  const getToken = useAuthToken();
  const { units } = useUnits();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('3M');
  const [loading, setLoading] = useState(true);
  const [points, setPoints] = useState<RunSessionPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      setLoading(true);
      listSessionsPage(getToken, { sport: 'running', limit: MAX_SESSIONS })
        .then((page) => {
          if (!live) return;
          setPoints(runPointsFromSessions(page.sessions));
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
    }, [getToken]),
  );

  const today = dayString(new Date());
  const series = useMemo(
    () => buildDistanceTrend(failed ? null : points, range, today),
    [failed, points, range, today],
  );

  const fmt = (m: number) => round2(toDisplayDistanceLong(m, units)).toString();
  const unit = distanceUnit(units);

  return (
    <>
      <Stack.Screen options={{ title: 'Distance' }} />
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
                    testID={`running-trend-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="running-trend-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} {unit}
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="running-trend-evidence">
                  {series.delta.n} {series.delta.n === 1 ? 'run' : 'runs'} in this range
                </Text>
              </RNView>
            ) : null}

            {series.empty ? (
              <Text style={styles.empty} testID="running-trend-empty">
                {emptyCopy(series.empty, 'runs')}
              </Text>
            ) : (
              <TrendChart
                series={series}
                format={fmt}
                minSpan={MIN_SPAN_M}
                height={200}
                formatDate={shortDate}
                accessibilityLabel={`Distance over ${rangeLabel(range)}, ${series.readings.length} runs`}
                testID="running-trend-chart"
              />
            )}

            <Text style={styles.note}>
              Each dot is one run&apos;s total distance. There is no line between them — runs are not
              daily, so a gap between two real ones means nothing on its own.
            </Text>

            <Entries points={points ?? []} from={series.from} to={series.to} format={fmt} unit={unit} />
          </>
        )}
      </ScrollView>
    </>
  );
}

/**
 * The runs behind the chart — scoped to the window on screen, matching
 * `app/records/[exerciseId]/trend.tsx`'s own `Entries`: "the entries behind
 * THIS chart" is both the honest reading and what stops years of runs being
 * re-sorted on every range tap. Capped at {@link MAX_ENTRIES}, and the cap is
 * STATED rather than silent — a list that quietly stops reads as "that is
 * all of them".
 */
function Entries({
  points,
  from,
  to,
  format,
  unit,
}: {
  points: RunSessionPoint[];
  from: string;
  to: string;
  format: (m: number) => string;
  unit: string;
}) {
  const rows = useMemo(
    () =>
      points
        .filter((p) => dayString(new Date(p.started_at)) >= from && dayString(new Date(p.started_at)) <= to)
        .slice()
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)),
    [points, from, to],
  );
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>RUNS</Text>
      {rows.slice(0, MAX_ENTRIES).map((p) => (
        <RNView key={p.session_id} style={styles.entry} testID={`running-trend-entry-${p.session_id}`}>
          <Text style={styles.entryDate}>{longDate(p.started_at)}</Text>
          <Text style={styles.entryValue}>
            {format(p.distance_m)} {unit}
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
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
