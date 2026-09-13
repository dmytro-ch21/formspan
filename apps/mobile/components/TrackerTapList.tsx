import { useState } from 'react';
import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { vola } from '@/constants/Colors';
import {
  tapAmountLabel,
  tapLabel,
  tapListToggleLabel,
  tapRemoveLabel,
  tapTimeLabel,
  type Tracker,
  type TrackerEntry,
} from '@/lib/trackerModel';
import type { UnitSystem } from '@/lib/units';

/**
 * A bar-style card's taps, one row each — N578.
 *
 * `TrackerCard` draws a bar past twelve glyphs, or whenever the athlete picked
 * `bar`. A bar has no per-tap element, so N437's long press had nothing to land
 * on. Neither correcting nor removing ONE tap was reachable there on a phone;
 * the only way to take back a mis-tap was to have fewer than thirteen of them.
 *
 * **The smallest thing that reaches both, and nothing more.** A disclosure,
 * closed by default, so a thirty-capsule card on Today costs one line until the
 * athlete asks. Opened, it lists the day's taps in the order they were logged:
 * the order the glyphs used. Each row opens the SAME correction screen a glyph's
 * long press does, through the same `onEditEntry`. Each row's × goes through the
 * card's own `onRemove`, so a coffee row still removes its caffeine through
 * `removeCoffeeTap`. There is no second write path to keep in step.
 *
 * Rows rather than tap targets on the bar, because a bar that knew where each
 * tap sat would be thirty invisible hit targets, which `Bar` already refuses.
 *
 * Closed again by a day switch for free: `TrackerList` keys the card on the day,
 * so this state remounts with it.
 */
export function TrackerTapList({
  tracker,
  entries,
  units,
  unitsReady,
  onRemove,
  onEditEntry,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  units: UnitSystem;
  unitsReady: boolean;
  onRemove: (entryID: string) => void;
  onEditEntry?: (entryID: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  const toggle = tapListToggleLabel(tracker, entries.length, open);

  return (
    <RNView style={styles.list}>
      <PressableScale
        onPress={() => setOpen((o) => !o)}
        style={styles.toggle}
        hitSlop={{ top: 6, bottom: 6 }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={toggle}
        testID={`tracker-taps-toggle-${tracker.id}`}
      >
        <Text style={styles.toggleText}>{toggle}</Text>
      </PressableScale>

      {/* Every row names an amount in the athlete's unit, so none is drawn
          before the preference has been read — the card's own rule. */}
      {open && unitsReady ? (
        <RNView style={styles.rows} testID={`tracker-taps-${tracker.id}`}>
          {entries.map((e) => {
            const time = tapTimeLabel(e);
            const said = (
              <Text style={styles.amount}>
                {tapAmountLabel(tracker, e, units)}
                {time ? <Text style={styles.time}>{`  ·  ${time}`}</Text> : null}
              </Text>
            );
            return (
              <RNView key={e.id} style={styles.row}>
                {onEditEntry ? (
                  <PressableScale
                    onPress={() => onEditEntry(e.id)}
                    style={styles.body}
                    // Same arithmetic as the caffeine banner's rows: the vertical
                    // slop makes a 44pt target of a 28pt row, and there is no
                    // horizontal slop because the × is right beside it.
                    hitSlop={{ top: 8, bottom: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={tapLabel(tracker, e, units)}
                    accessibilityHint="Double tap to change the amount"
                    testID={`tracker-tap-edit-${e.id}`}
                  >
                    {said}
                    <Text style={styles.change}>Change</Text>
                  </PressableScale>
                ) : (
                  <RNView style={styles.body}>{said}</RNView>
                )}
                <PressableScale
                  onPress={() => onRemove(e.id)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={tapRemoveLabel(tracker, e, units)}
                  testID={`tracker-tap-remove-${e.id}`}
                >
                  <Text style={styles.remove}>×</Text>
                </PressableScale>
              </RNView>
            );
          })}
        </RNView>
      ) : null}
    </RNView>
  );
}

// The caffeine banner's row tokens, so the two lists of taps read as one idiom.
const styles = StyleSheet.create({
  list: { gap: 6 },
  toggle: { alignSelf: 'flex-start', paddingVertical: 10 },
  toggleText: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
  rows: { gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  amount: { fontSize: 12, color: vola.textMuted },
  time: { fontSize: 12, color: vola.textDim },
  change: { fontSize: 12, fontWeight: '700', color: vola.textDim },
  remove: { fontSize: 15, fontWeight: '700', color: vola.textMuted },
});
