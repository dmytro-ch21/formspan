import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isHealthKitSupported } from '@/lib/healthkit';
import { readHealthKitImportEnabled } from '@/lib/healthkitSync';
import { RANGES, type TrendEmpty, type TrendRangeKey, type TrendSeries } from '@/lib/trendSeries';
import { useAuthToken } from '@/lib/useAuthToken';
import { useVo2MaxTrend } from '@/lib/useVo2MaxTrend';

/**
 * VO₂max, in full — the profile-level trend the acceptance criteria ask
 * for, sitting next to `app/goals/trend.tsx` (weight) as the second instance
 * of the shared `TrendChart`/`trendSeries.ts` layer rather than a bespoke
 * drawing.
 *
 * ## Why this is legal on mobile at all
 *
 * The carve-out (CLAUDE.md "Which platform gets a feature") allows a small
 * read-only chart on the phone when it answers ONE question with no metric
 * picker and preset windows that all end today. This screen shows exactly
 * one series (VO₂max), no picker, and `RANGES` minus `Plan` — `Plan`
 * presupposes a nutrition/weight phase this metric has nothing to do with,
 * so it is filtered out rather than shown and left meaningless.
 *
 * ## Why there is no goal line and no projection
 *
 * Design doc §3: VO₂max is "read, never computed" and shown as a trend, full
 * stop — there is no target an athlete sets for it anywhere in this app, so
 * `TrendChart`'s `goal`/`projection` props are simply omitted rather than
 * threaded through as permanently-null.
 *
 * ## Why this reads the toggle rather than gating on a fetch failing
 *
 * A 401/empty result from `listBiometricSamples` looks IDENTICAL whether the
 * athlete has never turned Health sync on, has turned it on but has no
 * VO₂max-capable device, or is offline — see `lib/healthkit.ts`'s doc
 * comment on why HealthKit itself cannot tell an app "permission was
 * denied" (design doc §5.1). So the off-toggle state is read directly and
 * named plainly, rather than guessed at from an empty chart.
 */

const FETCH_DAYS = 365 * 3;
/** Smallest y-axis span, in mL/kg/min. A flat run of readings would
 *  otherwise divide by zero — see `TrendChart`'s own `minSpan` doc. */
const MIN_SPAN = 2;

const VO2MAX_RANGES = RANGES.filter((r) => r.key !== 'Plan');

export default function Vo2MaxTrendScreen() {
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const accent = useAccent();

  const [range, setRange] = useState<TrendRangeKey>('6M');
  const [syncOn, setSyncOn] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (userId) {
        readHealthKitImportEnabled(userId).then((on) => {
          if (live) setSyncOn(on);
        });
      } else {
        setSyncOn(false);
      }
      return () => {
        live = false;
      };
    }, [userId]),
  );

  const { loading, series } = useVo2MaxTrend(getToken, range, FETCH_DAYS);
  const fmt = (v: number) => v.toFixed(1);

  return (
    <>
      <Stack.Screen options={{ title: 'VO2max' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {!isHealthKitSupported() ? (
          <Text style={styles.empty} testID="vo2max-unsupported">
            VO2max reading isn&apos;t available on this device.
          </Text>
        ) : syncOn === false ? (
          <Text style={styles.empty} testID="vo2max-sync-off">
            Turn on &quot;Sync with Apple Health&quot; in Settings to read your VO2max trend from an
            Apple Watch or another device that estimates it.
          </Text>
        ) : loading ? (
          <ActivityIndicator />
        ) : (
          <>
            <RNView style={styles.ranges}>
              {VO2MAX_RANGES.map((r) => {
                const on = r.key === range;
                return (
                  <Pressable
                    key={r.key}
                    onPress={() => setRange(r.key)}
                    hitSlop={8}
                    style={[styles.range, on && { backgroundColor: accent.accent }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    testID={`vo2max-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </RNView>

            {series.delta ? (
              <RNView>
                <Text style={styles.delta} testID="vo2max-delta">
                  {series.delta.change > 0 ? '↑' : series.delta.change < 0 ? '↓' : '→'}{' '}
                  {fmt(Math.abs(series.delta.change))} mL/kg/min
                  <Text style={styles.since}> since {series.delta.from}</Text>
                </Text>
                <Text style={styles.evidence} testID="vo2max-evidence">
                  {series.delta.n} {series.delta.n === 1 ? 'reading' : 'readings'}
                </Text>
              </RNView>
            ) : null}

            {series.empty ? (
              <Text style={styles.empty} testID="vo2max-empty">
                {vo2MaxEmptyCopy(series.empty)}
              </Text>
            ) : (
              <TrendChart
                series={series}
                format={fmt}
                minSpan={MIN_SPAN}
                height={200}
                formatDate={(on) => on.slice(5)}
                accessibilityLabel={`VO2max over the selected range, ${series.readings.length} readings`}
                testID="vo2max-chart"
              />
            )}

            <Text style={styles.note}>
              VO2max is a device estimate — most watches update it every few days from steady runs
              or walks, not from BJJ or strength sessions.
            </Text>

            <Entries series={series} />
          </>
        )}
      </ScrollView>
    </>
  );
}

/**
 * The read-only sibling of `emptyCopy` in `components/TrendCard.tsx`.
 *
 * Not reused directly: that function's `none` case reads "Record your X and
 * the trend appears here", which presumes the athlete logs the metric by
 * hand. Nobody records a VO2max — it is read from a device — so the honest
 * sentence names WHAT to do about it (a capable device, HealthKit sync)
 * rather than an action this screen has no control to offer.
 */
function vo2MaxEmptyCopy(empty: TrendEmpty): string {
  switch (empty.kind) {
    case 'unavailable':
      return "Couldn't load your VO2max trend. It'll be here when the connection is back.";
    case 'none':
      return 'No VO2max reading yet. An Apple Watch (or another device that estimates it) needs to have written one to Health.';
    case 'none-in-range':
      return `Nothing in this range — you have ${empty.totalReadings} ${
        empty.totalReadings === 1 ? 'reading' : 'readings'
      } further back. Try a wider one.`;
    case 'too-few':
      return `${empty.have} of ${empty.need} readings needed for a trend line.`;
  }
}

/** The readings behind the chart, newest first — the identical pattern
 *  `app/goals/trend.tsx`'s `Entries` takes, reduced to one value column
 *  since VO2max has no unit system to convert. */
function Entries({ series }: { series: TrendSeries }) {
  const rows = [...series.readings].sort((a, b) => (a.on < b.on ? 1 : -1));
  if (rows.length === 0) return null;
  return (
    <View style={styles.entries}>
      <Text style={styles.entriesHead}>READINGS</Text>
      {rows.map((r) => (
        <RNView key={r.on} style={styles.entry} testID={`vo2max-entry-${r.on}`}>
          <Text style={styles.entryDate}>{r.on}</Text>
          <Text style={styles.entryValue}>{r.value.toFixed(1)} mL/kg/min</Text>
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
