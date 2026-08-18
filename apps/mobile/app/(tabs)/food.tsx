/**
 * The day's food.
 *
 * Reads SQLite first and the network second, so the screen is complete with no
 * signal — which is the whole reason `foodLog.ts` is an outbox rather than a
 * thin client.
 *
 * ## The order, and why
 *
 * One remaining block, then the meal slots, then what training cost. There is
 * NO per-meal calorie allocation: "536 calories now available for breakfast"
 * requires knowing a day the app cannot see, it is wrong the moment you eat a
 * big lunch, and it manufactures four budgets to fail against instead of one
 * honest total. The slots group the day — that is all they do.
 *
 * ## Training is stated, not spent
 *
 * The row at the bottom reports what a session cost and changes nothing above
 * it. Adding it back to the target double-counts (the target already includes a
 * 28-day training average) and makes the observed weekly rate unreadable — you
 * could no longer tell a bad week of eating from a moved goalpost.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { RemainingBlock } from '@/components/food/RemainingBlock';
import { Icon } from '@/components/ui/Icon';
import { PeriodSwitcher } from '@/components/ui/PeriodSwitcher';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { addDays, dayString } from '@/lib/calendar';
import { localEntries, removeEntry } from '@/lib/foodLog';
import { bySlot, dayTotals, remaining, type Entry, type Meal, type Target } from '@/lib/nutrition';
import { listTargets, targetOn } from '@/lib/nutritionApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { useSyncState } from '@/lib/sync';

const MEAL_LABELS: Record<Meal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

export default function FoodScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { lastSyncAt } = useSyncState();

  // An OFFSET rather than a Date, so the screen cannot drift out of sync with
  // the wall clock while it sits mounted — the same shape Today uses.
  const [dayOffset, setDayOffset] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { userId } = useAuth();

  const on = dayString(addDays(new Date(), dayOffset));
  const isToday = dayOffset === 0;

  const refresh = useCallback(() => {
    let live = true;
    // Local first, and it alone is enough to render the day.
    //
    // The signed-out case resolves an empty list rather than returning early
    // with a `setLoaded(true)`. That early return was a synchronous setState
    // inside an effect, which is a cascading render — and the warning that
    // catches it is one of the 54 this app holds by ratchet, so adding one
    // fails the gate.
    (userId ? localEntries(userId, on) : Promise.resolve<Entry[]>([]))
      .then((rows) => {
        if (live) setEntries(rows);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoaded(true);
      });

    // The target is server-side and is the one thing this screen cannot
    // compute. A failure leaves it null, which renders as "set a target"
    // rather than as a wrong number.
    listTargets(getToken, { from: on, to: on })
      .then((ts) => {
        if (live) setTarget(targetOn(ts, on));
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [getToken, on, userId]);

  // Refreshed on FOCUS, not mount: this is a tab screen and stays mounted for
  // the life of the process.
  useFocusEffect(
    useCallback(() => {
      const stop = refresh();
      return stop;
    }, [refresh]),
  );

  // And again after a sync lands, so a push that completed in the background is
  // reflected without a manual pull-to-refresh. A separate effect rather than a
  // dependency on the focus callback: `refresh` does not read `lastSyncAt`, so
  // listing it there is a dependency the linter correctly calls unnecessary.
  useEffect(() => {
    if (!lastSyncAt) return;
    const stop = refresh();
    return stop;
  }, [lastSyncAt, refresh]);

  const totals = dayTotals(entries);
  const left = remaining(totals, target);
  const slots = bySlot(entries);

  async function onDelete(id: string) {
    if (!userId) return;
    await removeEntry(userId, id);
    setEntries(await localEntries(userId, on));
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: TAB_BAR_CLEARANCE + 40 }]}
        contentInsetAdjustmentBehavior="never"
      >
        <ScreenHeader title="Food" />

        <View style={styles.body}>
          <PeriodSwitcher
            label={isToday ? 'Today' : on}
            onPrev={() => setDayOffset((d) => d - 1)}
            onNext={() => setDayOffset((d) => d + 1)}
            onPress={isToday ? undefined : () => setDayOffset(0)}
            icon="calendar"
            prevLabel="Previous day"
            nextLabel="Next day"
            pressLabel="Back to today"
            testID="food-day"
          />

          <View style={styles.summary}>
            <RemainingBlock
              totals={totals}
              target={target}
              remaining={left}
              loaded={loaded}
              testID="food-remaining"
            />
          </View>

          {slots.map((slot) => (
            <View key={slot.meal} style={styles.slot}>
              <SectionHeader
                label={`${MEAL_LABELS[slot.meal]}${slot.kcal > 0 ? ` · ${Math.round(slot.kcal)} kcal` : ''}`}
              />
              {slot.entries.map((e) => (
                <SwipeToDelete
                  key={e.id}
                  onDelete={() => void onDelete(e.id)}
                  accessibilityLabel={e.name}
                  closeOn={entries.length}
                  testID={`food-entry-${e.id}`}
                >
                  <Pressable
                    style={styles.row}
                    onPress={() => router.push(`/food/entry/${e.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`${e.name}, ${Math.round(e.kcal)} calories`}
                  >
                    <View style={styles.rowMain}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {e.name}
                      </Text>
                      <Text style={styles.rowServing}>
                        {trimZero(e.servings)} × {e.serving_label}
                      </Text>
                    </View>
                    <View style={styles.rowRight}>
                      <Text style={styles.rowKcal}>{Math.round(e.kcal)}</Text>
                      <Text style={styles.rowProtein}>{Math.round(e.protein_g)} g P</Text>
                    </View>
                  </Pressable>
                </SwipeToDelete>
              ))}
              <Pressable
                style={styles.add}
                onPress={() => router.push(`/food/add?meal=${slot.meal}&date=${on}`)}
                accessibilityRole="button"
                accessibilityLabel={`Add to ${MEAL_LABELS[slot.meal]}`}
                testID={`food-add-${slot.meal}`}
              >
                <Icon name="plus" size={13} color={accent.ink} />
                <Text style={[styles.addText, { color: accent.ink }]}>Add</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/** 1.5 stays 1.5; 1.0 becomes 1. Nobody writes "1.0 × 100 g". */
function trimZero(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { gap: 12 },
  body: { paddingHorizontal: 20, gap: 16 },
  summary: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  slot: { gap: 6 },
  // Matches SwipeToDelete's own backing exactly — surface at radius 12 — or the
  // revealed action shows a seam behind the row.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 14, fontWeight: '600' },
  rowServing: { fontSize: 12, color: vola.textDim },
  rowRight: { alignItems: 'flex-end' },
  rowKcal: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowProtein: { fontSize: 11, color: vola.textMuted },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  addText: { fontSize: 13, fontWeight: '600' },
});
