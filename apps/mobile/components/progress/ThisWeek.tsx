import { StyleSheet, View as RNView } from 'react-native';

import { ReadingState, StaleNote } from '@/components/progress/Reading';
import { Text, View } from '@/components/Themed';
import { WeekReview } from '@/components/WeekReview';
import { vola } from '@/constants/Colors';
import type { Module } from '@/lib/modules';
import type { NutritionWeek, Reading } from '@/lib/progress';
import type { UnitSystem } from '@/lib/units';
import type { WeekReview as Review } from '@/lib/weekReview';

/**
 * Recent context — the week, per discipline, plus whether food was logged.
 *
 * ## Reused, not rebuilt
 *
 * `WeekReview` already answers "how did this week go" with a verdict, a
 * comparison and a per-sport split, and it has a long list of hard-won rules
 * baked into it: no score, no streak, time instead of tonnage for a sport that
 * cannot hold a set, and a stated reason when the device cannot see far enough
 * back to compare. Rebuilding any of that for this tab would be a second
 * opinion about one week.
 *
 * What is added here is the one thing that card has never carried: **nutrition
 * adherence**, which the ticket's overview asks for beside the session counts.
 * It is a line rather than a tile because it is a different kind of measure —
 * days out of days, not sessions — and folding it into the sport split would
 * imply nutrition is a sport, which `lib/modules.ts` is careful it is not.
 *
 * ## The whole block is gated on the reading
 *
 * `WeekReview` renders "Nothing logged yet" when its totals are zero, which is
 * correct and is exactly the sentence that must never appear over a read that
 * has not answered. So it is not rendered at all until `week.state === 'ready'`
 * — the empty claim is reachable only from an actual answer.
 */
export function ThisWeek({
  week,
  nutrition,
  modules,
  units,
  unitsReady,
}: {
  week: Reading<Review>;
  nutrition: Reading<NutritionWeek>;
  modules: Module[];
  units: UnitSystem;
  unitsReady: boolean;
  }) {
  return (
    <RNView style={styles.wrap} testID="progress-section-week">
      {/*
        `empty: null` — the week reading is deliberately built with no
        `isEmpty`, because a week with zero sessions is still an ANSWER whose
        value `WeekReview` needs: it is what lets the card say "Nothing logged
        against this week's plan yet" rather than the flat "Nothing logged yet",
        and it still carries the planned count. Collapsing that into a
        payload-free `empty` here would replace a distinction the component
        already draws with a sentence that cannot.

        This started life as a real `empty` string, and review caught it: the
        copy was unreachable and the test asserting its absence could not fail.
        See `ReadingState`'s note on the prop.
      */}
      <ReadingState
        reading={week}
        subject="your week"
        empty={null}
        testID="progress-week-state"
      />
      {week.state === 'ready' && (
        <>
          <WeekReview
            review={week.value}
            modules={modules}
            units={units}
            unitsReady={unitsReady}
            testID="progress-week-review"
          />
          <StaleNote reading={week} testID="progress-week-stale" />
        </>
      )}
      <NutritionLine reading={nutrition} />
    </RNView>
  );
}

/**
 * "Food logged on 4 of 5 days so far" — or the honest reason there is no
 * number.
 *
 * **A separate reading from the week's**, deliberately. The sessions come from
 * SQLite and the food days come from a different table on a different schedule;
 * one union covering both would report the slower of the two as the state of
 * the faster, and a failed food read would blank a training week that loaded
 * perfectly.
 *
 * It renders NOTHING when nutrition is off — no line, no explanation — because
 * the section it sits in is about training and an athlete who has turned
 * nutrition off does not need every screen to keep mentioning it. The place
 * that explains "off" is the Nutrition section further down, which is where
 * somebody looking for it would go.
 */
function NutritionLine({ reading }: { reading: Reading<NutritionWeek> }) {
  if (reading.state === 'off') return null;

  return (
    <View style={styles.nutrition} testID="progress-week-nutrition">
      <Text style={styles.nutritionLabel}>FOOD LOGGED</Text>
      <Text style={styles.nutritionValue}>
        {reading.state === 'checking'
          ? '—'
          : reading.state === 'unavailable'
            ? "Couldn't check"
            : reading.state === 'empty'
              ? 'No days yet'
              : `${reading.value.logged} of ${reading.value.elapsed} ${
                  reading.value.elapsed === 1 ? 'day' : 'days'
                }`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  nutrition: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  nutritionLabel: {
    fontSize: 11,
    color: vola.textDim,
    letterSpacing: 0.8,
    fontWeight: '600',
  },
  nutritionValue: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
