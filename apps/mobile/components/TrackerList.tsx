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
  on,
  units,
  unitsReady,
  testID,
}: {
  day: TrackerDay;
  /** The local calendar day these cards describe. */
  on: string;
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
          onAdd={() => void day.addTap(t, on)}
          onRemoveAt={(i) => void day.removeTapAt(t, on, i)}
          onEdit={() => day.openSettings(t)}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, color: vola.textDim },
});
