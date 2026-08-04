import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { request as requestSync, useSyncState } from '@/lib/sync';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { PickSessionSheet } from '@/components/ui/PickSessionSheet';
import { vola } from '@/constants/Colors';
import {
  addDays,
  addMonths,
  dayString,
  monthGrid,
  refreshedAnchor,
  startOfMonth,
  weekDays,
} from '@/lib/calendar';
import { labelFor, type Module } from '@/lib/modules';
import {
  listPlannedBetween,
  planSession,
  unplanSession,
  type PlannedSession,
} from '@/lib/plan';
import { cachedWorkouts } from '@/lib/sessionStore';

/**
 * The training week, as something you fill in.
 *
 * This is the authoring half of the Today screen's lead card: plan a day here,
 * and Today opens on it with a Start button. Before this existed, Today's only
 * offer was a stack of "Start <discipline>" buttons — the app could log a
 * session but had no idea what you *intended*, so it could never lead with
 * anything but a menu.
 *
 * **A day holds a list, not a single entry.** Two-a-days are normal in this
 * sport — lift in the morning, mat in the evening — and a one-plan-per-day
 * model would make the second one overwrite the first silently.
 *
 * **Rows, not a 7-across grid.** The grid shape reads beautifully with nothing
 * in it and falls apart the moment a day holds "Maestro Push Day": there is no
 * room for a template name in a 45pt column, so every planned day degrades to
 * a coloured dot and the calendar stops telling you what you planned. Rows
 * give the name the width it needs, and the Today screen's `TrainingCalendar`
 * already covers the at-a-glance shape.
 *
 * **The month grid is a jump target, not a second way to read the plan.** This
 * screen was pinned to the current week and had no navigation at all, so you
 * could not plan next week — the one thing a planner is for. The fix is a week
 * you can move: the arrows step a week, and the month grid picks a distant one
 * in a single tap and then hands it back to the rows. Its cells carry a dot and
 * nothing else, which is exactly why it cannot replace them.
 *
 * Plans are local-only for now — see `lib/plan.ts`.
 */
export function WeekPlanner({
  userId,
  modules,
}: {
  userId: string | null;
  modules: Module[];
}) {
  const [now, setNow] = useState(() => new Date());
  const [plans, setPlans] = useState<PlannedSession[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  // The day being planned, or null when the sheet is closed. Holding the day
  // here rather than a boolean is what lets one sheet serve all seven rows.
  const [planning, setPlanning] = useState<string | null>(null);
  // Any day inside the week the rows are showing. Separate from `now`, which
  // stays the real today — `isPast` and the today marker are claims about the
  // actual date and must not move when you navigate away from this week.
  const [anchor, setAnchor] = useState(() => new Date());
  const [monthOpen, setMonthOpen] = useState(false);
  // The month the grid is showing, which is not the anchor's month once you
  // page through it looking for a week without picking one yet.
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [monthDays, setMonthDays] = useState<Set<string>>(new Set());

  const days = useMemo(() => weekDays(anchor), [anchor]);
  const todayKey = dayString(now);
  const isCurrentWeek = days.some((d) => dayString(d) === todayKey);

  const refresh = useCallback(async () => {
    if (!userId) return;
    // The week on screen, NOT `new Date()`. This read was pinned to today, so
    // it was already the reason navigation could not work: every arrow would
    // have moved the rows and re-fetched this week's plans into them.
    const week = weekDays(anchor);
    try {
      const [rows, cached] = await Promise.all([
        listPlannedBetween(userId, dayString(week[0]), dayString(week[6])),
        cachedWorkouts(userId),
      ]);
      setPlans(rows);
      // Resolved from the cache each read rather than stored on the plan, so a
      // renamed template shows its new name instead of a stale copy.
      setNames(Object.fromEntries(cached.map((w) => [w.id, w.name])));
    } catch {
      // An unreadable plan is an empty week here, not an error banner — the
      // templates below it are the screen's main content and still work.
    }
  }, [userId, anchor]);

  /**
   * Which days of the open month hold a plan — the grid's only content.
   *
   * A separate read from `refresh`, over a different range, because the grid
   * spans weeks the rows are not showing. It is loaded when the grid opens and
   * whenever its month changes, rather than kept live: a jump target does not
   * need to react to a sync, and the rows behind it already do.
   */
  const loadMonth = useCallback(
    async (month: Date) => {
      if (!userId) return;
      const cells = monthGrid(month).flat();
      try {
        const rows = await listPlannedBetween(
          userId,
          cells[0].key,
          cells[cells.length - 1].key,
        );
        setMonthDays(new Set(rows.map((r) => r.day)));
      } catch {
        setMonthDays(new Set());
      }
    },
    [userId],
  );

  // `now` is refreshed on focus, or a tab left open overnight keeps planning
  // into last week — the same staleness the Today screen guards against.
  //
  // The anchor is snapped forward only when it has fallen into a *past* week,
  // which can only happen by time passing. A week you navigated to yourself is
  // left alone: if it is still ahead, you chose it, and resetting every time
  // the tab loses focus would make planning two weeks out a fight.
  //
  // **This must not depend on `refresh`, which changes with the anchor.** With
  // `[refresh]` here the effect re-runs on every navigation and the snap fires
  // against the week you just chose — so picking a past day in the month grid
  // bounced instantly back to today, and the grid's whole left half was dead.
  // The read is a separate effect below for exactly that reason.
  const [reloadAt, setReloadAt] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const today = new Date();
      setNow(today);
      setAnchor((a) => refreshedAnchor(a, today));
      setReloadAt((n) => n + 1);
    }, []),
  );

  // Re-read when the week on screen changes, when the screen is focused, and
  // whenever a sync finishes. Without that last one the week is only as fresh
  // as the last focus, so a plan made on the web lands in SQLite and stays
  // invisible until the tab is left and returned to — which is precisely the
  // "it synced but nothing changed" the sessions list already fixed.
  const { lastSyncAt } = useSyncState();
  useEffect(() => {
    refresh();
  }, [refresh, reloadAt, lastSyncAt]);

  async function add(day: string, sport: string, workoutId: string | null) {
    if (!userId) return;
    try {
      await planSession(userId, day, sport, workoutId);
      await refresh();
      // Local write first, then ask the orchestrator — it decides whether now
      // is a moment worth a run. The row is already on screen either way, so
      // this never blocks the interaction.
      requestSync('plan-added');
    } catch (err) {
      Alert.alert("Couldn't plan that", err instanceof Error ? err.message : String(err));
    }
  }

  function confirmRemove(p: PlannedSession) {
    if (!userId) return;
    Alert.alert('Remove from plan?', 'This only clears the plan — nothing you logged changes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await unplanSession(userId, p.id);
            await refresh();
            requestSync('plan-removed');
          } catch (err) {
            Alert.alert("Couldn't remove that", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
  }

  /**
   * The month a week belongs to, when it straddles two.
   *
   * ISO 8601's rule: the month holding the Thursday owns the week. Labelling by
   * the Monday instead calls 29 September – 5 October "September" when six of
   * its seven days are October.
   */
  const weekLabel = days[3].toLocaleDateString(undefined, {
    month: 'long',
    // The year only when it is not the current one — "AUGUST 2026" on every
    // screen all year is noise, but a silent jump to next January is a trap.
    ...(days[3].getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });

  function openMonth() {
    setMonthAnchor(startOfMonth(anchor));
    loadMonth(startOfMonth(anchor));
    setMonthOpen(true);
  }

  function stepMonth(n: number) {
    const next = addMonths(monthAnchor, n);
    setMonthAnchor(next);
    loadMonth(next);
  }

  return (
    <RNView style={styles.wrap} testID="week-planner">
      {/*
        Two controls, kept apart: the title opens the month, the pair on the
        right steps a week. They were interleaved as `‹ AUGUST › ›` in the first
        cut, which put two identical right-chevrons side by side with entirely
        different jobs — the disclosure on the title and the next-week arrow.
        Grouping the stepper and turning the title's chevron down is what makes
        the two readable at a glance.
      */}
      <RNView style={styles.head}>
        <Pressable
          onPress={openMonth}
          hitSlop={10}
          style={styles.monthButton}
          accessibilityRole="button"
          accessibilityLabel={`${weekLabel}, week of ${days[0].toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
          })}. Open the month to jump to another week.`}
          testID="plan-open-month"
        >
          <Text style={styles.month}>{weekLabel.toUpperCase()}</Text>
          <RNView style={styles.down}>
            <Icon name="chevron" size={11} color={vola.textDim} />
          </RNView>
        </Pressable>

        {/* Only when you are away from it — a "Today" that is always there is
            a control that does nothing six days out of seven, and it is also
            the only thing telling you that you have navigated at all. */}
        {!isCurrentWeek && (
          <Pressable
            onPress={() => setAnchor(new Date())}
            hitSlop={10}
            style={styles.today}
            accessibilityRole="button"
            accessibilityLabel="Back to this week"
            testID="plan-this-week"
          >
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        )}

        <RNView style={[styles.stepper, isCurrentWeek && styles.stepperAlone]}>
          <Pressable
            onPress={() => setAnchor(addDays(anchor, -7))}
            hitSlop={12}
            style={styles.step}
            accessibilityRole="button"
            accessibilityLabel="Previous week"
            testID="plan-prev-week"
          >
            <RNView style={styles.flip}>
              <Icon name="chevron" size={14} color={vola.text} />
            </RNView>
          </Pressable>
          <Pressable
            onPress={() => setAnchor(addDays(anchor, 7))}
            hitSlop={12}
            style={styles.step}
            accessibilityRole="button"
            accessibilityLabel="Next week"
            testID="plan-next-week"
          >
            <Icon name="chevron" size={14} color={vola.text} />
          </Pressable>
        </RNView>
      </RNView>

      <View style={styles.card}>
        {days.map((d, i) => {
          const key = dayString(d);
          const mine = plans.filter((p) => p.day === key);
          const isToday = key === todayKey;
          // Yesterday is not a planning target — it is history, and offering
          // to fill it in invites a plan that can never be started.
          const isPast = key < todayKey;

          return (
            <RNView key={key} style={[styles.day, i > 0 && styles.dayDivided]}>
              <RNView style={styles.dayHead}>
                <RNView style={styles.dayName}>
                  <Text style={[styles.weekday, isToday && styles.weekdayToday]}>
                    {d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                  </Text>
                  <Text style={[styles.date, isPast && styles.dimmed]}>
                    {String(d.getDate()).padStart(2, '0')}
                  </Text>
                </RNView>

                {!isPast && (
                  <Pressable
                    onPress={() => setPlanning(key)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Plan ${d.toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}`}
                    testID={`plan-add-${key}`}
                  >
                    <Text style={styles.add}>+ Add</Text>
                  </Pressable>
                )}
              </RNView>

              {mine.length === 0 ? (
                <Text style={[styles.rest, isPast && styles.dimmed]}>
                  {isPast ? '—' : 'Rest'}
                </Text>
              ) : (
                mine.map((p) => (
                  <Pressable
                    key={p.id}
                    style={({ pressed }) => [styles.entry, pressed && styles.entryPressed]}
                    onLongPress={() => confirmRemove(p)}
                    accessibilityRole="button"
                    accessibilityLabel={`${
                      (p.workoutId && names[p.workoutId]) || labelFor(modules, p.sport)
                    }, planned. Long press to remove.`}
                    testID={`plan-entry-${p.id}`}
                  >
                    <RNView style={styles.entryRule} />
                    <RNView style={styles.entryMain}>
                      <Text style={styles.entrySport}>
                        {labelFor(modules, p.sport).toUpperCase()}
                      </Text>
                      <Text style={styles.entryTitle} numberOfLines={1}>
                        {/* Falls back to the discipline when the plan names a
                            template the cache no longer holds — see lib/plan.ts
                            on why there is no foreign key. */}
                        {(p.workoutId && names[p.workoutId]) ||
                          `${labelFor(modules, p.sport)} session`}
                      </Text>
                    </RNView>
                    <Icon name="chevron" size={13} color={vola.textDim} />
                  </Pressable>
                ))
              )}
            </RNView>
          );
        })}
      </View>

      <Text style={styles.hint}>Long-press a planned session to remove it.</Text>

      <PickSessionSheet
        visible={planning !== null}
        modules={modules}
        userId={userId}
        title={
          planning
            ? `Plan ${new Date(`${planning}T00:00:00`).toLocaleDateString(undefined, {
                weekday: 'long',
              })}`
            : 'Plan'
        }
        onClose={() => setPlanning(null)}
        onPick={(pick) => {
          const day = planning;
          setPlanning(null);
          if (day) add(day, pick.sport, pick.workoutId);
        }}
      />

      <Modal
        visible={monthOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setMonthOpen(false)}
      >
        <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
          <RNView style={styles.sheetHead}>
            <Pressable
              onPress={() => stepMonth(-1)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              testID="plan-month-prev"
            >
              <RNView style={styles.flip}>
                <Icon name="chevron" size={16} color={vola.text} />
              </RNView>
            </Pressable>
            <Text style={styles.sheetTitle}>
              {monthAnchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </Text>
            <Pressable
              onPress={() => stepMonth(1)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Next month"
              testID="plan-month-next"
            >
              <Icon name="chevron" size={16} color={vola.text} />
            </Pressable>
            <Pressable
              onPress={() => setMonthOpen(false)}
              hitSlop={12}
              style={styles.sheetClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="plan-month-close"
            >
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </RNView>

          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetHint}>Pick a day to plan that week.</Text>

            <RNView style={styles.gridHead}>
              {days.map((d) => (
                <Text key={d.toISOString()} style={styles.gridHeadCell}>
                  {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
                </Text>
              ))}
            </RNView>

            {monthGrid(monthAnchor).map((row) => (
              <RNView key={row[0].key} style={styles.gridRow}>
                {row.map((cell) => {
                  const isToday = cell.key === todayKey;
                  const planned = monthDays.has(cell.key);
                  // The week the rows are already showing, so the grid says
                  // where you are rather than only where you could go.
                  const inShownWeek = days.some((d) => dayString(d) === cell.key);
                  return (
                    <Pressable
                      key={cell.key}
                      style={[styles.gridCell, inShownWeek && styles.gridCellShown]}
                      onPress={() => {
                        setAnchor(cell.date);
                        setMonthOpen(false);
                      }}
                      accessibilityRole="button"
                      // Every state is named rather than left to the dot,
                      // matching `TrainingCalendar` — a cell that reads out as
                      // a bare number tells a screen reader nothing about the
                      // plan, which is the whole content of this grid.
                      accessibilityLabel={[
                        cell.date.toLocaleDateString(undefined, {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                        }),
                        isToday ? 'today' : null,
                        planned ? 'planned' : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      testID={`plan-month-day-${cell.key}`}
                    >
                      <Text
                        style={[
                          styles.gridDate,
                          !cell.inMonth && styles.gridSpill,
                          isToday && styles.gridToday,
                        ]}
                      >
                        {cell.date.getDate()}
                      </Text>
                      {/* Always rendered, so a dot appearing never shifts the
                          row's height — the same placeholder trick the Today
                          calendar's markers use. */}
                      <RNView style={[styles.gridDot, planned && styles.gridDotOn]} />
                    </Pressable>
                  );
                })}
              </RNView>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },

  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 2 },
  // The icon set has one chevron, pointing right. Rotating is what gives the
  // pair a guaranteed-identical silhouette; a second asset would not.
  flip: { transform: [{ rotate: '180deg' }] },
  down: { transform: [{ rotate: '90deg' }] },
  monthButton: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  month: { fontSize: 13, fontWeight: '800', letterSpacing: 1.4 },
  today: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  todayText: { fontSize: 11, fontWeight: '700', color: vola.lime },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 999,
    overflow: 'hidden',
  },
  // The Today pill takes the `marginLeft: auto` when it is there; without it
  // the stepper needs its own, or it sits against the title.
  stepperAlone: { marginLeft: 'auto' },
  step: { paddingHorizontal: 12, paddingVertical: 5 },

  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  day: { paddingVertical: 11, gap: 7 },
  dayDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vola.line },
  dayHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dayName: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  weekday: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: vola.textDim },
  weekdayToday: { color: vola.lime },
  date: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dimmed: { color: vola.textDim, opacity: 0.55 },
  add: { fontSize: 13, fontWeight: '700', color: vola.lime },
  rest: { fontSize: 13, color: vola.textDim },

  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    paddingRight: 10,
    overflow: 'hidden',
  },
  entryPressed: { backgroundColor: vola.surfaceHover },
  // Lime, unlike the session cards' green: this is an intention, not a result.
  entryRule: { width: 3, alignSelf: 'stretch', backgroundColor: vola.lime },
  entryMain: { flex: 1, paddingVertical: 9, paddingLeft: 8, gap: 1 },
  entrySport: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textDim },
  entryTitle: { fontSize: 14, fontWeight: '700' },

  hint: { fontSize: 11, color: vola.textDim },

  sheet: { flex: 1 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  sheetTitle: { fontSize: 16, fontWeight: '800' },
  sheetClose: { marginLeft: 'auto' },
  close: { fontSize: 14, fontWeight: '700', color: vola.lime },
  sheetBody: { padding: 14, gap: 2 },
  sheetHint: { fontSize: 12, color: vola.textDim, paddingBottom: 10 },

  gridHead: { flexDirection: 'row', paddingBottom: 6 },
  gridHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: vola.textDim,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
  },
  gridCellShown: { backgroundColor: vola.surface },
  gridDate: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  gridSpill: { color: vola.textDim, opacity: 0.4 },
  gridToday: { color: vola.lime, fontWeight: '800' },
  gridDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'transparent' },
  gridDotOn: { backgroundColor: vola.lime },
});
