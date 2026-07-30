import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  buildGrid,
  byWeek,
  delta,
  fetchHistory,
  formatDayLong,
  formatDuration,
  loadMetric,
  localZone,
  spanRange,
  SPANS,
  streakRange,
  weekStreak,
  type History,
  type SpanKey,
} from '@/lib/history';
import { formatVolume, type UnitSystem } from '@/lib/units';

/**
 * Training history on a phone — the small version, on purpose.
 *
 * The platform split puts analysis on the web: filtering, a year of calendar,
 * drilling into a session. None of that is here. What a phone is genuinely
 * better at is the glance — you open it on the sofa on a Sunday and want one
 * answer, **am I showing up**, before deciding what this week looks like.
 *
 * So: three numbers, a grid of days, and a bar per week. No filters, no
 * drill-down, no year view. If you want to interrogate the data, that's what
 * the wide screen is for.
 */
export function TrainingSummary({
  getToken,
  units,
}: {
  getToken: () => Promise<string | null>;
  units: UnitSystem;
}) {
  const [span, setSpan] = useState<SpanKey>('12w');
  // Tagged with the span it was fetched for. Without that, a failed refetch
  // after switching leaves the previous span's numbers on screen wearing the
  // new span's label — the same bug that shipped on web, where the empty
  // state could say "nothing in the last 4 weeks" over 12 weeks of data.
  const [data, setData] = useState<{ span: SpanKey; history: History } | null>(null);
  const [failed, setFailed] = useState(false);
  const [streak, setStreak] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      const { from, to } = spanRange(span);
      fetchHistory(getToken, { from, to, tz: localZone() }, controller.signal)
        .then((h) => {
          if (controller.signal.aborted) return;
          setData({ span, history: h });
          setFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
      return () => controller.abort();
    }, [getToken, span]),
  );

  // The streak is fetched over its own fixed window, not the selected span,
  // and this is the whole point: computed from the span's days it is a
  // function of the segmented control rather than of the training. For anyone
  // training consistently it reports *exactly* the span length — 4 weeks on
  // the 4-week view, 12 on the 12-week — which looks entirely plausible and
  // is a lie about someone's training. Deliberately not keyed on `span`.
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      const { from, to } = streakRange();
      fetchHistory(getToken, { from, to, tz: localZone() }, controller.signal)
        .then((h) => {
          if (!controller.signal.aborted) setStreak(weekStreak(h.days));
        })
        .catch(() => {
          // A missing streak is a missing line, not an error worth a banner.
          if (!controller.signal.aborted) setStreak(null);
        });
      return () => controller.abort();
    }, [getToken]),
  );

  return (
    <SummaryBody
      span={span}
      onSpan={setSpan}
      history={data?.span === span ? data.history : null}
      streak={streak}
      failed={failed}
      units={units}
    />
  );
}

function SummaryBody({
  span,
  onSpan,
  history,
  streak,
  failed,
  units,
}: {
  span: SpanKey;
  onSpan: (s: SpanKey) => void;
  history: History | null;
  streak: number | null;
  failed: boolean;
  units: UnitSystem;
}) {
  const t = history?.totals;
  const p = history?.previous;

  return (
    <>
      <RNView style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>Training</Text>
        <RNView style={styles.segmented}>
          {SPANS.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => onSpan(s.key)}
              hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
              accessibilityRole="button"
              accessibilityState={{ selected: span === s.key }}
              accessibilityLabel={`Show ${s.label}`}
              style={[styles.segment, span === s.key && styles.segmentOn]}
              testID={`training-span-${s.key}`}
            >
              <Text style={[styles.segmentText, span === s.key && styles.segmentTextOn]}>
                {s.label}
              </Text>
            </Pressable>
          ))}
        </RNView>
      </RNView>

      {!history ? (
        <View style={styles.card}>
          {failed ? (
            <Text style={styles.muted}>Couldn&apos;t load your training just now.</Text>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading your training" />
          )}
        </View>
      ) : t!.sessions === 0 ? (
        <View style={styles.card}>
          <Text style={styles.muted}>
            Nothing logged in the last {SPANS.find((s) => s.key === span)!.label}.
          </Text>
        </View>
      ) : (
        <>
          <RNView style={styles.tiles}>
            <Tile label="Sessions" value={String(t!.sessions)} change={delta(t!.sessions, p!.sessions)} />
            <Tile label="Days" value={String(t!.active_days)} change={delta(t!.active_days, p!.active_days)} />
            <Tile
              label="Time"
              value={t!.duration_seconds > 0 ? formatDuration(t!.duration_seconds) : '—'}
              change={delta(t!.duration_seconds, p!.duration_seconds)}
            />
          </RNView>

          {failed && (
            <Text style={styles.stale} accessibilityLiveRegion="polite">
              Showing the last figures loaded — couldn&apos;t refresh just now.
            </Text>
          )}
          <Grid history={history} streak={streak} />
          <Weeks history={history} units={units} />
        </>
      )}
    </>
  );
}

/**
 * One number and its direction.
 *
 * The arrow is colour-neutral deliberately. Up isn't automatically good — more
 * volume in a build block is progress, more in a deload week means the deload
 * didn't happen — so this states the change and leaves the reading to whoever
 * knows what the block was for.
 */
function Tile({ label, value, change }: { label: string; value: string; change: number | null }) {
  const rounded = change === null ? null : Math.round(change);
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileDelta}>
        {value === '—' || rounded === null
          ? ' '
          : rounded === 0
            ? 'no change'
            : `${rounded > 0 ? '↑' : '↓'} ${Math.abs(rounded)}%`}
      </Text>
    </View>
  );
}

/** The consistency grid. Ramp and rest colour live in the palette. */
function Grid({ history, streak }: { history: History; streak: number | null }) {
  const weeks = useMemo(
    () => buildGrid(history.from, history.to, history.days),
    [history],
  );
  const hasSets = history.days.some((d) => d.working_sets > 0);
  const peak = Math.max(1, ...history.days.map((d) => (hasSets ? d.working_sets : d.sessions)));

  const level = (d: (typeof history.days)[number] | null) => {
    if (!d) return -1;
    const v = hasSets ? d.working_sets : d.sessions;
    // Floored at the first step for any day with training. The measure is
    // chosen for the period but read per day, so in a block that mixes
    // lifting with BJJ a mat day scores zero working sets — and would render
    // identically to a rest day on the view whose only job is which days you
    // trained.
    return Math.min(2, Math.max(0, Math.ceil((v / peak) * 3) - 1));
  };

  return (
    <View style={styles.card}>
      <Text style={styles.weeksTitle}>Days trained</Text>
      <RNView style={styles.grid}>
        {weeks.map((week) => (
          <RNView key={week[0].date} style={styles.gridCol}>
            {week.map((cell) => {
              const lv = level(cell.day);
              return (
                <RNView
                  key={cell.date}
                  accessible={!!cell.day}
                  accessibilityLabel={
                    cell.day
                      ? `${formatDayLong(cell.date)}: ${cell.day.sessions} ${
                          cell.day.sessions === 1 ? 'session' : 'sessions'
                        }`
                      : undefined
                  }
                  style={[
                    styles.cell,
                    !cell.inRange && styles.cellOut,
                    lv >= 0 && { backgroundColor: vola.gridLevels[lv] },
                  ]}
                />
              );
            })}
          </RNView>
        ))}
      </RNView>

      <RNView style={styles.gridFoot}>
        <Text style={styles.footText}>
          {streak === null
            ? ' '
            : streak > 0
              ? `${streak} week${streak === 1 ? '' : 's'} in a row`
              : 'No streak yet — one session starts it'}
        </Text>
        <RNView style={styles.legend}>
          <Text style={styles.footText}>Less</Text>
          <RNView style={[styles.legendCell, { backgroundColor: vola.gridRest }]} />
          {vola.gridLevels.map((c) => (
            <RNView key={c} style={[styles.legendCell, { backgroundColor: c }]} />
          ))}
          <Text style={styles.footText}>More</Text>
        </RNView>
      </RNView>
    </View>
  );
}

/** A bar per week. One measure, one axis, no legend — the heading names it. */
function Weeks({ history, units }: { history: History; units: UnitSystem }) {
  const metric = loadMetric(history.days);
  const weeks = useMemo(
    () => byWeek(history.from, history.to, history.days),
    [history],
  );
  const value = (w: (typeof weeks)[number]) => (metric === 'volume' ? w.tonnageKg : w.minutes);
  const peak = Math.max(1, ...weeks.map(value));
  const total = weeks.reduce((n, w) => n + value(w), 0);

  return (
    <View style={styles.card}>
      <RNView style={styles.weeksHead}>
        <Text style={styles.weeksTitle}>
          Weekly {metric === 'volume' ? 'volume' : 'time'}
        </Text>
        <Text style={styles.footText}>
          {metric === 'volume' ? formatVolume(total, units) : formatDuration(total * 60)} total
        </Text>
      </RNView>

      <RNView style={styles.bars} accessible accessibilityRole="image"
        accessibilityLabel={`Weekly ${metric === 'volume' ? 'volume' : 'time'} over ${weeks.length} weeks. ${
          weeks.filter((w) => w.sessions > 0).length
        } of ${weeks.length} weeks trained.`}
      >
        {weeks.map((w) => {
          const v = value(w);
          return (
            <RNView key={w.start} style={styles.barSlot}>
              <RNView
                style={[
                  styles.bar,
                  // Capped, not stretched. With four weeks on screen an
                  // uncapped bar is an 85pt slab — the mark stops reading as
                  // a measurement and starts reading as a block of colour.
                  {
                    // A trained week never rounds to invisible, and a week the
                    // axis can't measure — mat time under a volume axis — is
                    // dimmed rather than drawn as nothing.
                    height: `${v > 0 ? Math.max(4, (v / peak) * 100) : w.sessions > 0 ? 6 : 2}%`,
                    backgroundColor:
                      v > 0 ? vola.lime : w.sessions > 0 ? vola.gridLevels[0] : vola.gridRest,
                  },
                ]}
              />
            </RNView>
          );
        })}
      </RNView>
    </View>
  );
}

const CELL = 13;
const GAP = 3;

const styles = StyleSheet.create({
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: vola.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 2,
  },
  segment: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  segmentOn: { backgroundColor: vola.lime },
  segmentText: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
  segmentTextOn: { color: vola.bg },

  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 12,
  },

  tiles: { flexDirection: 'row', gap: 8 },
  tile: {
    flex: 1,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 1,
  },
  tileLabel: {
    fontSize: 10,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  tileValue: { fontSize: 21, fontWeight: '800' },
  tileDelta: { fontSize: 11, color: vola.textMuted },

  grid: { flexDirection: 'row', gap: GAP },
  gridCol: { gap: GAP },
  cell: { width: CELL, height: CELL, borderRadius: 3, backgroundColor: vola.gridRest },
  cellOut: { backgroundColor: 'transparent' },
  gridFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  footText: { fontSize: 11, color: vola.textDim },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  legendCell: { width: 10, height: 10, borderRadius: 2 },

  weeksHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  weeksTitle: { fontSize: 13, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 56 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '100%', maxWidth: 26, borderTopLeftRadius: 3, borderTopRightRadius: 3 },

  muted: { color: vola.textMuted, fontSize: 13 },
  stale: { color: vola.warn, fontSize: 12 },
});
