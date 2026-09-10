import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrendChart } from '@/components/TrendChart';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isHealthConnectSupported } from '@/lib/healthConnect';
import { readHealthConnectImportEnabled } from '@/lib/healthConnectSync';
import { isHealthKitSupported } from '@/lib/healthkit';
import {
  VO2MAX_FETCH_DAYS,
  healthSourceFor,
  vo2MaxEmptyCopy,
  vo2MaxRanges,
  vo2MaxScreenState,
  vo2MaxStateCopy,
} from '@/lib/vo2MaxSource';
import { readHealthKitImportEnabled } from '@/lib/healthkitSync';
import { type TrendRangeKey, type TrendSeries } from '@/lib/trendSeries';
import { useAuthToken } from '@/lib/useAuthToken';
import { useVo2MaxTrend } from '@/lib/useVo2MaxTrend';
import { PressableScale } from '@/components/ui/PressableScale';

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
 * one series (VO₂max), no picker, and the fixed windows that fit inside
 * what this screen actually fetches (`vo2MaxRanges`) — `Plan` presupposes a
 * nutrition/weight phase this metric has nothing to do with, and `All`
 * promised more than the samples endpoint's cap can deliver (F34), so
 * neither is shown and left meaningless.
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

// W16/#945 — was `365 * 3`, which is more than the server allows and is why
// every fetch this screen made was refused; the helper owns the cap now.
const FETCH_DAYS = VO2MAX_FETCH_DAYS;
/** Smallest y-axis span, in mL/kg/min. A flat run of readings would
 *  otherwise divide by zero — see `TrendChart`'s own `minSpan` doc. */
const MIN_SPAN = 2;

/**
 * F34/#955 — was `RANGES.filter((r) => r.key !== 'Plan')`, which left `All`
 * on a screen that fetches at most `VO2MAX_FETCH_DAYS` + slack: `All` showed
 * roughly the last thirteen months under a label promising everything. The
 * offered set is now DERIVED from the fetch window in `lib/vo2MaxSource.ts`,
 * so a preset the hook does not fetch cannot appear here — see that
 * function's doc comment for why relabelling was chosen over paging or a
 * per-metric cap raise.
 */
const VO2MAX_RANGES = vo2MaxRanges();

/** The widest preset on offer — read off the derived list rather than written
 *  down, so the "try a wider one" invitation in `vo2MaxEmptyCopy` cannot
 *  outlive the range that used to satisfy it. */
const WIDEST_RANGE = VO2MAX_RANGES[VO2MAX_RANGES.length - 1]?.key;

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
        read(userId)
          .then((on) => {
            if (live) setSyncOn(on);
          })
          .catch(() => {
            // A failed preference read must not hold the spinner forever now
            // that an unanswered read means "still loading" (review). Same
            // answer as the signed-out branch above: treat as off.
            if (live) setSyncOn(false);
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
            // The server's answer over the whole fetch window (the most the
            // server allows, ~13 months — see `vo2MaxFetchWindow`) —
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
                  <PressableScale
                    key={r.key}
                    onPress={() => setRange(r.key)}
                    hitSlop={8}
                    style={[styles.range, on && { backgroundColor: accent.accent }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    testID={`vo2max-range-${r.key}`}
                  >
                    <Text style={[styles.rangeText, on && { color: accent.on }]}>{r.label}</Text>
                  </PressableScale>
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
                {vo2MaxEmptyCopy(series.empty, source, range !== WIDEST_RANGE)}
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
