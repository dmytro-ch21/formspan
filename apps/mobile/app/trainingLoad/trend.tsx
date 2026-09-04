import { Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { RANGES, type TrendEmpty, type TrendRangeKey, type TrendSeries } from '@/lib/trendSeries';
import { useAuthToken } from '@/lib/useAuthToken';
import { useTrainingLoadTrend } from '@/lib/useTrainingLoadTrend';

/**
 * Training load, in full — the Progress-tab trend N489/#850's acceptance
 * criteria ask for, sitting next to `app/vo2max/trend.tsx` and
 * `app/goals/trend.tsx` as the third instance of the shared
 * `TrendChart`/`trendSeries.ts` layer.
 *
 * ## Why this belongs on Progress, not You (unlike VO2max — N477)
 *
 * VO2max deliberately did NOT go on Progress: it is "a fact about the
 * athlete," read from a device, not a verdict on what they did. A TRIMP
 * trend is the opposite kind of fact — it is entirely a function of the
 * sessions the athlete chose to do, and "is my training load climbing
 * sensibly or am I stacking hard weeks on hard weeks" is exactly the kind of
 * question the Progress tab exists to answer. See `progress.tsx`'s own doc
 * comment and this ticket's history entry for the fuller version of this
 * distinction.
 *
 * ## Why this is legal on mobile at all (the CLAUDE.md carve-out)
 *
 * One question ("is my training load rising or falling"), no metric picker,
 * preset windows that all end today — the same three bullets `vo2max/trend`
 * and `goals/trend` already satisfy. `RANGES` minus `Plan` — `Plan`
 * presupposes a nutrition/weight phase this metric has nothing to do with —
 * matches `vo2max/trend.tsx`'s own filter exactly.
 *
 * ## Why there is no goal and no projection
 *
 * There is no target an athlete sets for weekly TRIMP anywhere in this app
 * — like VO2max, this is read as a trend, full stop, so `TrendChart`'s
 * `goal`/`projection` props are simply omitted.
 *
 * ## Cross-sport by construction
 *
 * `useTrainingLoadTrend` reads `GET /v1/biometric/sessions/load`, which
 * spans BJJ, strength and running in one query — see that endpoint's own
 * doc comment. This screen never filters by sport; a hard week is a hard
 * week whether it was rolling, squatting or running.
 */

const TRAINING_LOAD_RANGES = RANGES.filter((r) => r.key !== 'Plan');

/**
 * Three years, matching `goals/trend.tsx`/`vo2max/trend.tsx`'s own
 * `FETCH_DAYS` — enough for the widest preset ('All') to have real history
 * to draw from.
 *
 * **The actual request is wider than this number**, and that gap already
 * shipped a bug once: `useTrainingLoadTrend` adds its own week of lookback
 * slack and requests a full calendar day at each end
 * (`T00:00:00Z`..`T23:59:59Z`), which comes to ~1103 days every time, not
 * 1095 — frontend-reviewer caught the backend's `maxSessionLoadRangeDays`
 * (1100 at the time) silently rejecting every single request this screen
 * ever made. It is 1200 now, with real headroom over the measured 1103, not
 * a number that merely sounds like enough — see that constant's own doc
 * comment on the backend for the exact arithmetic.
 */
const FETCH_DAYS = 365 * 3;

/** Smallest y-axis span, in TRIMP units. A flat run of weeks would
 *  otherwise divide by zero — see `TrendChart`'s own `minSpan` doc. */
const MIN_SPAN = 10;

export default function TrainingLoadTrendScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('3M');

  const { loading, series } = useTrainingLoadTrend(getToken, range, FETCH_DAYS);
  const fmt = (v: number) => Math.round(v).toString();

  return (
    <>
      <Stack.Screen options={{ title: 'Training load' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {loading ? (
          <ActivityIndicator />
        ) : (
          <>
            <RNView style={styles.ranges}>
              {TRAINING_LOAD_RANGES.map((r) => {
                const on = r.key === range;
                return (
                  <Pressable
                    key={r.key}
                    onPress={() => setRange(r.key)}
                    hitSlop={8}
                    style={[styles.range, on && { backgroundColor: accent.accent }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    testID={`training-load-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="training-load-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} TRIMP
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="training-load-evidence">
                  {series.delta.n} {series.delta.n === 1 ? 'training day' : 'training days'}
                </Text>
              </RNView>
            ) : null}

            {series.empty ? (
              <Text style={styles.empty} testID="training-load-empty">
                {trainingLoadEmptyCopy(series.empty)}
              </Text>
            ) : (
              <TrendChart
                series={series}
                format={fmt}
                minSpan={MIN_SPAN}
                height={200}
                formatDate={(on) => on.slice(5)}
                accessibilityLabel={`Weekly training load over the selected range, ${series.readings.length} training days with heart-rate data`}
                testID="training-load-chart"
              />
            )}

            <Text style={styles.note}>
              A 7-day rolling total of Edwards&apos; TRIMP across BJJ, strength and running sessions
              that have heart-rate data. Sessions with no heart-rate evidence are left out rather
              than counted as zero.
            </Text>

            <Entries series={series} />
          </>
        )}
      </ScrollView>
    </>
  );
}

/**
 * The read-only sibling of `emptyCopy`/`vo2MaxEmptyCopy` — copy for a
 * chart with nothing to draw, phrased for what THIS metric actually is:
 * derived from sessions plus heart-rate data, not something the athlete
 * records directly and not a bare device reading either.
 */
function trainingLoadEmptyCopy(empty: TrendEmpty): string {
  switch (empty.kind) {
    case 'unavailable':
      return "Couldn't load your training load trend. It'll be here when the connection is back.";
    case 'none':
      return 'No training load yet. Sessions need heart-rate data — synced from Apple Health or Health Connect — before a load figure can be computed.';
    case 'none-in-range':
      return `Nothing in this range — you have load data from ${empty.totalReadings} further back. Try a wider range.`;
    case 'too-few':
      return 'Not enough training logged in this window yet.';
  }
}

/** The daily loads behind the chart, newest first — one row per day that
 *  had at least one session, not one row per session (see
 *  `trainingLoadTrend.ts`'s own note on why same-day sessions are summed). */
function Entries({ series }: { series: TrendSeries }) {
  const rows = [...series.readings].sort((a, b) => (a.on < b.on ? 1 : -1));
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>TRAINING DAYS</Text>
      {rows.map((r) => (
        <RNView key={r.on} style={styles.entry} testID={`training-load-entry-${r.on}`}>
          <Text style={styles.entryDate}>{r.on}</Text>
          <Text style={styles.entryValue}>{Math.round(r.value)} TRIMP</Text>
        </RNView>
      ))}
    </View>
  );
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
