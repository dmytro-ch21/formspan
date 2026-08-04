import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Alert, Pressable, StyleSheet, View as RNView } from 'react-native';

import { request as requestSync, useSyncState } from '@/lib/sync';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { PickSessionSheet } from '@/components/ui/PickSessionSheet';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { labelFor, type Module } from '@/lib/modules';
import {
  dayString,
  listPlannedBetween,
  planSession,
  unplanSession,
  weekDays,
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

  const days = weekDays(now);
  const todayKey = dayString(now);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const week = weekDays(new Date());
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
  }, [userId]);

  // `now` is refreshed alongside, or a tab left open overnight keeps planning
  // into last week — the same staleness the Today screen guards against.
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      refresh();
    }, [refresh]),
  );

  // Re-read whenever a sync finishes. Without this the week is only as fresh
  // as the last focus, so a plan made on the web lands in SQLite and stays
  // invisible until the tab is left and returned to — which is precisely the
  // "it synced but nothing changed" the sessions list already fixed.
  const { lastSyncAt } = useSyncState();
  useEffect(() => {
    if (lastSyncAt === null) return;
    refresh();
  }, [lastSyncAt, refresh]);

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

  return (
    <RNView style={styles.wrap} testID="week-planner">
      <SectionHeader label="This week" />

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
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
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
});
