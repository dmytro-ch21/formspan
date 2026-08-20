import { StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { TrackerCard } from '@/components/TrackerCard';
import { vola } from '@/constants/Colors';
import type { TrackerDay } from '@/lib/useTrackerDay';
import type { UnitSystem } from '@/lib/units';

/**
 * Every tracker's card, for one day.
 *
 * The one place Today and Food both render, so the two screens cannot end up
 * showing different things — and so the empty and unknown states are decided
 * once. See `useTrackerDay` for why that matters here in particular.
 *
 * No self-margin: both screens space their children with `gap`.
 */
export function TrackerList({
  day,
  dayAtTap,
  units,
  unitsReady,
  testID,
}: {
  day: TrackerDay;
  /**
   * The day a tap should be FILED UNDER, resolved at the MOMENT of the tap.
   *
   * A function, and the type is the guard: a `string` here would be computed
   * during render, and Today stays mounted for the life of the process — so a
   * phone left open across midnight would hold yesterday's value and the first
   * tap at 00:05 would file a cup under the day that just ended. A stale read
   * is a nuisance; a stale WRITE is data. Requiring a thunk makes passing a
   * frozen day a type error rather than a bug nobody meets until midnight.
   *
   * The screen decides what it means: Today reads the clock, Food passes its
   * stepper's day, because there the day is the subject of the screen and a tap
   * while reading Tuesday belongs to Tuesday.
   *
   * There is deliberately no separate "day being rendered" prop — the cards
   * show whatever `day.refresh(on)` last loaded, and the screen owns that call.
   * Two day inputs would be two things to keep in step.
   */
  dayAtTap: () => string;
  units: UnitSystem;
  unitsReady: boolean;
  testID?: string;
}) {
  if (day.view.state === 'unknown') {
    // Deliberately says nothing rather than "you have no trackers". This device
    // has not been told yet — the server provisions water on the first list —
    // and a confident empty state here would tell an athlete with a water card
    // that they have none.
    return null;
  }
  if (day.view.trackers.length === 0) {
    return (
      <Text style={styles.empty} testID={testID ? `${testID}-empty` : 'trackers-empty'}>
        Nothing to track today.
      </Text>
    );
  }
  return (
    <>
      {day.view.trackers.map((t) => (
        <TrackerCard
          key={t.id}
          tracker={t}
          entries={day.entriesFor(t.id)}
          units={units}
          unitsReady={unitsReady}
          onAdd={() => void day.addTap(t, dayAtTap())}
          onRemove={(entryID) => void day.removeEntry(entryID, dayAtTap())}
          onEdit={() => day.openSettings(t)}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, color: vola.textDim },
});
