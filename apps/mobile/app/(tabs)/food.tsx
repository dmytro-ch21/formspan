/**
 * The day's food.
 *
 * Reads SQLite first and the network second, so the screen is complete with no
 * signal — which is the whole reason `foodLog.ts` is an outbox rather than a
 * thin client.
 *
 * ## The order, and why
 *
 * One remaining block, then the meal slots. There is
 * NO per-meal calorie allocation: "536 calories now available for breakfast"
 * requires knowing a day the app cannot see, it is wrong the moment you eat a
 * big lunch, and it manufactures four budgets to fail against instead of one
 * honest total. The slots group the day — that is all they do.
 *
 * ## Training is stated, not spent
 *
 * The training row is NOT BUILT YET — this note is about the rule it must obey
 * when it is, and it is here rather than in a task because the tempting version
 * is the wrong one. It reports what a session cost and changes nothing above
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
import { cacheTargets, localEntries, localTargetView, removeEntry } from '@/lib/foodLog';
import {
  bySlot,
  eatenFrom,
  type EatenView,
  type Entry,
  type Meal,
  type TargetView,
} from '@/lib/nutrition';
import { listTargets, targetOn } from '@/lib/nutritionApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { request as requestSync, useSyncState } from '@/lib/sync';

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
  // Keyed to the day, like `dated` below and for the same reason: unkeyed, a
  // day step leaves the PREVIOUS day's rows standing under the new date until
  // the read resolves, so the total on screen belongs to a day you are no
  // longer looking at. That is its own way for calories to "not add up".
  const [loaded, setLoaded] = useState<{ on: string; eaten: EatenView }>({
    on: '',
    eaten: { state: 'loading' },
  });
  // Keyed to the DAY it was computed for. Without the key, stepping to another
  // day leaves the previous day's target standing while the new day's entries
  // render against it — a wrong remaining figure, not merely a stale one — and
  // a failed fetch would leave it there indefinitely. Resetting in an effect
  // would be a synchronous setState the ratchet forbids; deriving is free.
  const [dated, setDated] = useState<{ on: string; view: TargetView }>({
    on: '',
    view: { state: 'checking' },
  });
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
        if (live) setLoaded({ on, eaten: eatenFrom(rows) });
      })
      .catch(() => {
        // **Was `.catch(() => {})`.** A failed local read left `entries` at
        // `[]`, which renders as "nothing logged" — a claim that the athlete
        // ate nothing, made from a read that never happened. Swallowing it is
        // right (nothing here may throw at the screen); reporting it as a zero
        // is not.
        if (live) setLoaded({ on, eaten: { state: 'unavailable' } });
      });

    // The target is the one thing this screen cannot compute — it needs
    // training history the phone does not hold. So: the CACHE first, then the
    // server, and a failed fetch simply leaves the cached answer standing. A
    // day with no cache and no successful fetch ever renders as `unknown`,
    // never as "set a target": telling an athlete who set one on web to go and
    // set it again is the app being wrong rather than uninformed.
    // SEQUENCED, not raced. Started in parallel, a slow cache read can resolve
    // after a fast network answer and overwrite it — a target just deleted on
    // web would reappear until the next focus. The cache read is local and
    // quick, so chaining costs nothing and removes the ordering question.
    let answered = false;
    (userId ? localTargetView(userId, on) : Promise.resolve<TargetView>({ state: 'unknown' }))
      .catch((): TargetView => ({ state: 'unknown' }))
      .then((v) => {
        if (live && !answered) setDated({ on, view: v });
        return listTargets(getToken, { from: on, to: on });
      })
      .then(async (ts) => {
        if (userId) await cacheTargets(userId, on, on, ts);
        if (!live) return;
        answered = true;
        const t = targetOn(ts, on);
        setDated({ on, view: t ? { state: 'set', target: t } : { state: 'none' } });
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

  const eaten: EatenView = loaded.on === on ? loaded.eaten : { state: 'loading' };
  const entries = eaten.state === 'ready' ? eaten.rows : [];
  const slots = bySlot(entries);
  const view: TargetView = dated.on === on ? dated.view : { state: 'checking' };

  async function onDelete(id: string) {
    if (!userId) return;
    // The day this delete belongs to, captured BEFORE any await. Without it,
    // deleting and then stepping days races: the delete's re-read resolves last
    // and writes `loaded` back to the old day, so the new day falls to
    // `loading` until the next focus or sync. It fails honest — never a number
    // from the wrong day — but it strands the screen. Found in review.
    const deletingOn = on;
    await removeEntry(userId, id);
    // Every other write in this feature asks for a push; without it the
    // tombstone sits until the next foreground or timer tick, and a row deleted
    // on the phone stays on web for minutes.
    requestSync('food deleted');
    const rows = await localEntries(userId, deletingOn);
    setLoaded((prev) =>
      prev.on === deletingOn || prev.on === '' ? { on: deletingOn, eaten: eatenFrom(rows) } : prev,
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: TAB_BAR_CLEARANCE + 40 }]}
        contentInsetAdjustmentBehavior="never"
      >
        <ScreenHeader
          title="Food"
          action={
            <Pressable
              onPress={() => router.push('/food/target')}
              accessibilityRole="button"
              accessibilityLabel={view.state === 'set' ? 'Why this target' : 'Set a target'}
              testID="food-target-link"
            >
              <Text style={[styles.headerLink, { color: accent.ink }]}>
                {view.state === 'set' ? 'Target' : 'Set target'}
              </Text>
            </Pressable>
          }
        />

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
            <RemainingBlock eaten={eaten} view={view} testID="food-remaining" />
          </View>

          {/* The meal sections render ONLY on a real answer.
              Rendered while loading, or after a failed read, they are four
              headers with no rows and an Add button each — visually
              indistinguishable from a genuinely empty day, sitting under a
              banner saying the read failed. No number lies (subtotals are
              suppressed at 0, the headline is a dash), but the dominant surface
              of the screen still asserts "your meals are empty" from a read
              that never happened. That is the N28 failure in miniature and the
              same one this task exists to fix. Found in review. */}
          {eaten.state !== 'ready' ? (
            <Text style={styles.slotsAbsent} testID="food-slots-absent">
              {eaten.state === 'loading'
                ? 'Loading your meals…'
                : 'Your meals could not be read from this device.'}
            </Text>
          ) : (
            slots.map((slot) => (
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
          )))}
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
  headerLink: { fontSize: 13, fontWeight: '700' },
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
  slotsAbsent: { fontSize: 13, color: vola.textMuted, marginTop: 18 },
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
