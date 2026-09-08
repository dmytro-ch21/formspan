import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isHealthConnectSupported } from '@/lib/healthConnect';
import { readHealthConnectImportEnabled } from '@/lib/healthConnectSync';
import { isHealthKitSupported } from '@/lib/healthkit';
import {
  type HealthSource,
  healthSourceFor,
  healthSourceLabel,
  vo2MaxScreenState,
  vo2MaxStateCopy,
} from '@/lib/vo2MaxSource';
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
  // W16/#945 — which source THIS device has, decided once and purely (see
  // `lib/vo2MaxSource.ts`). iOS: HealthKit if linked. Android: Health
  // Connect, whose provider may still be absent — `sourceAvailable` below
  // answers that in words rather than by hiding the screen.
  const source = healthSourceFor(Platform.OS, isHealthKitSupported());
  const [sourceAvailable, setSourceAvailable] = useState<boolean | null>(
    source === 'health_connect' ? null : source !== null,
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (userId && source) {
        // The toggle that governs THIS source — reading the iOS one on
        // Android was half of the bug: it is always off there, so the screen
        // told a Health Connect athlete to turn on Apple Health.
        const read =
          source === 'healthkit' ? readHealthKitImportEnabled : readHealthConnectImportEnabled;
        read(userId).then((on) => {
          if (live) setSyncOn(on);
        });
      } else {
        setSyncOn(false);
      }
      if (source === 'health_connect') {
        isHealthConnectSupported().then((ok) => {
          if (live) setSourceAvailable(ok);
        });
      }
      return () => {
        live = false;
      };
    }, [userId, source]),
  );

  const { loading, series, samples } = useVo2MaxTrend(getToken, range, FETCH_DAYS);
  const fmt = (v: number) => v.toFixed(1);

  return (
    <>
      <Stack.Screen options={{ title: 'VO2max' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {/* W16/#945 — readings the server holds are shown whatever the gates
            say; the gates only choose a sentence when there is nothing to
            show, and each names the source this device actually has. The
            old order checked an iOS-only SDK first and hid Health Connect
            data behind "isn't available on this device". */}
        {(() => {
          const state = vo2MaxScreenState({
            loading,
            // The server's answer over the whole three-year fetch window —
            // NOT `!series.empty`, which is also set when readings exist but
            // none fall in the selected range, and would let a gate hide the
            // chart and the range picker from an athlete who has data.
            // Caught in review; see `vo2MaxScreenState`'s own doc comment.
            hasReadings: samples.length > 0,
            fetchFailed: series.empty?.kind === 'unavailable',
            source,
            sourceAvailable,
            syncOn,
          });
          if (state === 'loading') return <ActivityIndicator />;
          if (state === 'no_source' || state === 'source_unavailable') {
            return (
              <Text style={styles.empty} testID="vo2max-unsupported">
                {vo2MaxStateCopy(state, source)}
              </Text>
            );
          }
          if (state === 'sync_off') {
            return (
              <Text style={styles.empty} testID="vo2max-sync-off">
                {vo2MaxStateCopy(state, source)}
              </Text>
            );
          }
          return null;
        })() ?? (
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
                {vo2MaxEmptyCopy(series.empty, source)}
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
function vo2MaxEmptyCopy(empty: TrendEmpty, source: HealthSource | null): string {
  switch (empty.kind) {
    case 'unavailable':
      return "Couldn't load your VO2max trend. It'll be here when the connection is back.";
    case 'none':
      // W16/#945 — names the source THIS device reads from; "Apple Watch …
      // Health" on an Android phone was a sentence about somebody else's device.
      return `No VO2max reading yet. A watch or another device that estimates it needs to have written one to ${source ? healthSourceLabel(source) : 'your health app'}.`;
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
