import { useCallback, useMemo, useState } from 'react';
import type { TokenGetter } from '@/lib/useAuthToken';
import { ActivityIndicator, Dimensions, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { StatValue } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import {
  buildGrid,
  delta,
  fetchHistory,
  formatDayLong,
  formatDuration,
  loadMetric,
  localZone,
  spanRange,
  thisWeek,
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
  getToken: TokenGetter;
  units: UnitSystem;
}) {
  const [span, setSpan] = useState<SpanKey>('1m');
  // Tagged with the span it was fetched for. Without that, a failed refetch
  // after switching leaves the previous span's numbers on screen wearing the
  // new span's label — the same bug that shipped on web, where the empty
  // state could say "nothing in the last 4 weeks" over 12 weeks of data.
  const [data, setData] = useState<{ span: SpanKey; history: History } | null>(null);
  // Tagged with its span for the same reason `data` is. Untagged, a failure on
  // the year masked the *loading* state of the month you switched to, and the
  // "couldn't refresh" banner stayed over figures that were perfectly current.
  const [failed, setFailed] = useState<SpanKey | null>(null);
  const [streak, setStreak] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      const { from, to } = spanRange(span);
      fetchHistory(getToken, { from, to, tz: localZone() }, controller.signal)
        .then((h) => {
          if (controller.signal.aborted) return;
          setData({ span, history: h });
          setFailed((f) => (f === span ? null : f));
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(span);
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
      failed={failed === span}
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
              // Four options in one row leaves each segment ~42pt wide, just
              // under the 44pt target minimum; the slop makes up the rest.
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityState={{ selected: span === s.key }}
              accessibilityLabel={`Show ${s.pick}`}
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
      ) : (
        <>
          {t!.sessions === 0 ? (
            <View style={styles.card}>
              <Text style={styles.muted}>
                Nothing logged {SPANS.find((s) => s.key === span)!.blurb}.
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
            </>
          )}

          {/* Outside the empty branch on purpose. This card answers "how is
              this week going, how much of it is left" — a question that has an
              answer on a Monday morning with nothing logged, which is exactly
              when the empty branch used to remove it. */}
          <ThisWeek history={history} units={units} />
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
      {/* Same numeral treatment as the Today screen's week row — units set
          smaller than the figures. Two screens showing "1h 41m" in two
          different ways is the sort of drift that makes an app feel assembled
          rather than designed. */}
      <StatValue value={value} size={21} fit />
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

/**
 * The consistency grid, in two layouts.
 *
 * **Both the shape and the cell size are derived from the span, not fixed.**
 * A single 13pt-cell, weeks-as-columns grid was built when there were two
 * spans, and neither end of the new four survives it: a year is 52 columns ×
 * 16pt = 832pt inside a ~315pt card, so three quarters of it ran off the right
 * edge silently, with no scroll and nothing to say so — while a month is four
 * columns × 16pt = 61pt of grid marooned in the same card, a postage stamp
 * with 250pt of empty space beside it.
 *
 * So a short span lays out as a **calendar** — seven days across, weeks
 * stacked, which is how anyone reads a month — and a long one as a **heatmap**,
 * weeks across and days down, which is the only shape that fits 26 or 52 of
 * them. Both fill the width, which is what makes either look deliberate.
 *
 * The gap tightens as the columns multiply, because at 52 columns a 3pt gap is
 * 153pt — half the card spent on the space between things.
 */
function Grid({ history, streak }: { history: History; streak: number | null }) {
  const weeks = useMemo(
    () => buildGrid(history.from, history.to, history.days),
    [history],
  );
  const calendar = weeks.length <= CALENDAR_WEEKS;
  const columns = calendar ? 7 : weeks.length;
  const gap = columns <= 10 ? 3 : columns <= 30 ? 2 : 1;
  // Measured rather than assumed: the card's inner width depends on the
  // screen, and a hardcoded 315 is wrong on every device but one.
  //
  // Seeded from the window rather than 0, because the seed is what renders on
  // the frame before `onLayout` fires — and that is every mount *and* every
  // span change, since `history` goes null while the new span loads and
  // unmounts this. At 0 the card came up at 4pt cells and jumped to full size
  // a frame later, shoving the whole page. The seed is the real layout
  // arithmetic, so on almost every device it is already the answer.
  const [width, setWidth] = useState(estimatedGridWidth);
  const cell = useMemo(() => {
    if (width <= 0 || columns === 0) return CELL_MIN;
    const raw = (width - gap * (columns - 1)) / columns;
    return Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(raw)));
  }, [width, columns, gap]);
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

      {/* Only the calendar layout gets weekday letters: there they head a
          column that really is one weekday all the way down, which is a
          question people ask of their own training ("I never train Fridays").
          Over the heatmap the same letters would head a *week*, and mean
          nothing. */}
      {calendar && (
        <RNView style={[styles.weekdayRow, { gap }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {WEEKDAY_INITIALS.map((d, i) => (
            <Text key={i} style={[styles.weekday, { width: cell }]}>
              {d}
            </Text>
          ))}
        </RNView>
      )}

      <RNView
        style={[styles.grid, { gap }, calendar && styles.gridStacked]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        accessible={!calendar}
        accessibilityRole={calendar ? undefined : 'image'}
        // `active_days` rather than a count off `weeks`: the grid draws whole
        // weeks, so its cell count runs past `to` into days that have not
        // happened, and a denominator that includes them is a made-up number.
        accessibilityLabel={
          calendar ? undefined : `${history.totals.active_days} days trained in this period.`
        }
      >
        {weeks.map((week) => (
          <RNView
            key={week[0].date}
            style={[styles.gridCol, { gap }, calendar && styles.gridRow]}
          >
            {week.map((c) => {
              const lv = level(c.day);
              return (
                <RNView
                  key={c.date}
                  // Only the calendar's cells are individually focusable. A
                  // year of training is ~180 trained days, and 180 stops on
                  // 5pt squares is not navigation — the heatmap is summarised
                  // as one element instead (see the wrapper below).
                  accessible={calendar && !!c.day}
                  accessibilityLabel={
                    c.day
                      ? `${formatDayLong(c.date)}: ${c.day.sessions} ${
                          c.day.sessions === 1 ? 'session' : 'sessions'
                        }`
                      : undefined
                  }
                  style={[
                    styles.cell,
                    // Size is per-span, so it cannot live in the StyleSheet.
                    { width: cell, height: cell, borderRadius: Math.max(1, Math.floor(cell / 4)) },
                    !c.inRange && styles.cellOut,
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

/**
 * Volume across the current week — seven bars, always, one per day.
 *
 * **This was a bar per week across the whole span, and that stopped working
 * the moment the span could be a year.** 52 bars in ~315pt is six points
 * each with a three-point gap: the chart became a texture, and the one
 * question it answers — how much did I move — was unreadable at exactly the
 * range someone picks to answer it.
 *
 * Seven fixed columns say something the smear could not: *which days* of this
 * week carried the load, and how much of the week is still ahead. It is
 * deliberately NOT tied to the span control above it. The grid answers "am I
 * showing up, over months"; this answers "how is this week going", and a chart
 * that silently redefined its own x-axis from days to weeks depending on a
 * segmented control three cards up would be unreadable in a different way.
 *
 * Days that have not happened yet draw **nothing**, where a rest day draws a
 * stub — a Thursday shown as a bar of any height on Tuesday reads as a session
 * you missed. Dimming the future bar instead was tried first and measured
 * worse than it looked: see the comment on the bars themselves.
 */
function ThisWeek({ history, units }: { history: History; units: UnitSystem }) {
  // `history.to` rather than `thisWeek`'s default, so the memo has no hidden
  // dependency on the clock — and so the chart and the fetch agree on which
  // day "today" is even if one straddles midnight.
  const days = useMemo(() => thisWeek(history.days, history.to), [history]);
  // Chosen from the seven days drawn, not the fetched period: a BJJ-only week
  // inside a year that contains lifting would otherwise get a volume axis and
  // flatten to nothing, purely because of the span control above.
  const metric = loadMetric(days.map((d) => ({ tonnage_kg: d.tonnageKg })));
  const value = (d: (typeof days)[number]) => (metric === 'volume' ? d.tonnageKg : d.minutes);
  const peak = Math.max(1, ...days.map(value));
  const total = days.reduce((n, d) => n + value(d), 0);
  const elapsed = days.filter((d) => d.elapsed).length;
  const trained = days.filter((d) => d.sessions > 0).length;

  const fmt = (v: number) =>
    metric === 'volume' ? formatVolume(v, units) : formatDuration(v * 60);

  return (
    <View style={styles.card}>
      <RNView style={styles.weeksHead}>
        <Text style={styles.weeksTitle}>This week</Text>
        {/* The week's progress, in the two terms that matter: how much has
            been done, and how far through the week that is. "4 of 7 days"
            rather than a percentage — a percentage of a week is a number
            nobody thinks in. */}
        <Text style={styles.footText}>
          {total > 0 ? fmt(total) : 'nothing yet'} · day {Math.max(1, elapsed)} of 7
        </Text>
      </RNView>

      <RNView
        style={styles.bars}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${metric === 'volume' ? 'Volume' : 'Time'} this week: ${
          total > 0 ? fmt(total) : 'nothing yet'
        }. Trained ${trained} of the ${elapsed} days so far.`}
      >
        {/* A day still to come draws NO bar, where a rest day draws a stub.
            The first attempt at this dimmed the future bar instead — 1.7pt of
            #1A2230 beside 1.7pt of #2A3446, two colours 1.28:1 apart on a
            ground neither clears 1.5:1 against. Both read as blank, which is
            exactly the "you missed Thursday" the distinction exists to
            prevent. Presence-versus-absence of a mark is the channel now:
            a stub means a measured zero, nothing means no data yet. */}
        {days.map((d) => {
          const v = value(d);
          return (
            <RNView key={d.date} style={styles.barSlot}>
              {d.elapsed && (
                <RNView
                  style={[
                    styles.bar,
                    {
                      // A trained day never rounds to invisible, and a day the
                      // axis cannot measure — mat time under a volume axis —
                      // still gets a visible mark rather than a rest stub.
                      // The rest stub is 7%, not the 4% it started at: at 4%
                      // it is 2.2pt of a colour 1.46:1 against the card, and
                      // `bar`'s 3pt top radius turns something that short into
                      // a lens rather than a bar. It is the mark that carries
                      // "measured zero" against a future day's nothing, so it
                      // has to survive being glanced at.
                      height: `${v > 0 ? Math.max(9, (v / peak) * 100) : d.sessions > 0 ? 9 : 7}%`,
                      backgroundColor:
                        v > 0 ? vola.lime : d.sessions > 0 ? vola.gridLevels[0] : vola.gridRest,
                    },
                  ]}
                />
              )}
            </RNView>
          );
        })}
      </RNView>

      {/* Weekday initials under the bars. Seven columns of unlabelled bars is
          a shape; labelled, it is a week you can point at. */}
      <RNView
        style={styles.barLabels}
        // Read on their own, seven bare letters with no values attached are
        // noise; the chart above is already summarised as one element.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {days.map((d, i) => (
          <Text
            key={d.date}
            style={[styles.barLabel, !d.elapsed && styles.barLabelAhead]}
          >
            {WEEKDAY_INITIALS[i]}
          </Text>
        ))}
      </RNView>
    </View>
  );
}

/**
 * Indexed by position, because `thisWeek` always returns seven days starting
 * Monday. Re-deriving the weekday from each date string would mean parsing a
 * plain YYYY-MM-DD back into a `Date` — the one thing this module's date maths
 * exists to avoid, and the reason a bare date reads as the previous day west of
 * Greenwich.
 */
const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * The grid's width before `onLayout` measures it for real.
 *
 * Not a guess: the screen's own gutters (20pt each side) and the card's padding
 * (14pt each side) are the entire difference between the window and the grid,
 * so on a phone this IS the measurement — `onLayout` corrects it only where a
 * safe-area inset or a wider container makes it wrong.
 */
const estimatedGridWidth = Math.max(120, Dimensions.get('window').width - 40 - 28);

/**
 * Where the grid stops being a calendar and becomes a heatmap.
 *
 * Five weeks is the most that lays out as seven-across without the card
 * becoming the whole screen — at a width-filling ~42pt cell, five stacked rows
 * is already 220pt of squares. It covers the 1W and 1M spans; 6M and 1Y are
 * both far past it.
 */
const CALENDAR_WEEKS = 5;

// The cell is computed per span (see `Grid`); these bound it.
//
// The ceiling is *below* the width-filling size of a seven-across grid, and the
// grid centres itself in the slack. Filling looked right in the abstract and
// wrong on the device: at 42pt a month is twenty-eight chips the size of the
// Today screen's date buttons, so twenty-seven grey ones shout over the single
// lime one that is the entire point of the card. Smaller squares put the weight
// back on the days that were trained.
//
// The floor is where a year lands — small deliberately, because 52 columns of
// anything larger cannot fit, and a grid that overflows silently is worse than
// a dense one that does not.
const CELL_MAX = 30;
const CELL_MIN = 4;

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
  // Four options share this row now, so the padding is tighter than the two
  // it was built for. The labels are abbreviated for the same reason.
  segment: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
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
  tileDelta: { fontSize: 11, color: vola.textMuted },

  // Gaps are set inline, per span. Both layouts are the same two nested rows
  // with their directions swapped: weeks across and days down, or the reverse.
  grid: { flexDirection: 'row', justifyContent: 'center' },
  gridStacked: { flexDirection: 'column', alignItems: 'center' },
  gridCol: {},
  gridRow: { flexDirection: 'row' },
  weekdayRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: -4 },
  weekday: { fontSize: 10, color: vola.textDim, textAlign: 'center' },
  cell: { backgroundColor: vola.gridRest },
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
  barLabels: { flexDirection: 'row', gap: 3, marginTop: 6 },
  // The elapsed days step UP rather than the ahead days stepping down: the old
  // 0.4 opacity took `textDim` to 1.59:1, below anything readable. Both are now
  // real palette steps — 6.26:1 and 3.67:1 against the card.
  barLabel: { flex: 1, textAlign: 'center', fontSize: 10, color: vola.textMuted },
  barLabelAhead: { color: vola.textDim },

  muted: { color: vola.textMuted, fontSize: 13 },
  stale: { color: vola.warn, fontSize: 12 },
});
