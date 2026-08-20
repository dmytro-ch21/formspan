import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { trackerFill, vola } from '@/constants/Colors';
import {
  addLabel,
  amountLine,
  glyphHint,
  glyphLabel,
  glyphSlots,
  loggedCount,
  progress,
  resolveRenderStyle,
  rowLabel,
  targetCount,
  valueLine,
  type Tracker,
  type TrackerEntry,
} from '@/lib/trackerModel';
import type { UnitSystem } from '@/lib/units';

/**
 * ONE card for every daily tracker.
 *
 * **There is no WaterCard and there will not be a CoffeeCard.** N77's
 * acceptance criterion is that a reviewer can see one row component and one
 * model; N78's is that a created tracker is indistinguishable from water. Both
 * hold because this component knows nothing about what it is drawing beyond the
 * record it is handed — the fill comes from `color_key`, the copy from
 * `trackerModel`, the shape from `resolveRenderStyle`.
 *
 * A pure render, like `NutritionCard` and `CheckinCard`: the screen owns the
 * fetching and passes props. And no self-margin — `styles.body` on Today and
 * Food space their children with `gap`, and a component that insets itself is
 * only correct on the screen it was written against.
 *
 * ## Three shapes, chosen from the record
 *
 * - **glyphs** — a row of cups. Up to twelve, which is roughly where a row
 *   stops being countable and becomes a block you have to tally.
 * - **bar** — past that, with the number stated, because the number is what is
 *   being read at that point.
 * - **dose** — one large glyph when the target is a single tap. The creatine
 *   case, and N78 says it is the most common one.
 *
 * ## What the copy never does
 *
 * There is no praise and no scolding anywhere in here, and nothing renders
 * differently at ten of eight than at four of eight except the number. Crossing
 * a target is not an event; it is a larger number.
 */
export function TrackerCard({
  tracker,
  entries,
  units,
  unitsReady,
  onAdd,
  onRemoveAt,
  onEdit,
  testID,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  units: UnitSystem;
  /** Never print a unit-bearing number before the preference has been read. */
  unitsReady: boolean;
  onAdd: () => void;
  /** Remove the nth logged tap — index into the filled glyphs, left to right. */
  onRemoveAt: (index: number) => void;
  onEdit: () => void;
  testID?: string;
}) {
  const count = loggedCount(entries);
  const style = resolveRenderStyle(tracker, count);
  const fill = trackerFill(tracker.color_key);
  const target = targetCount(tracker);
  const amount = unitsReady ? amountLine(tracker, entries, units) : null;

  return (
    <View style={styles.card} testID={testID ?? `tracker-card-${tracker.id}`}>
      <RNView style={styles.head}>
        <RNView style={[styles.dot, { backgroundColor: fill }]} />
        <Text style={[styles.eyebrow, { color: fill }]} numberOfLines={1}>
          {tracker.name.toUpperCase()}
        </Text>
        <Pressable
          onPress={onEdit}
          hitSlop={12}
          accessibilityRole="button"
          // The overflow control is the ONLY route to the target on a phone, so
          // its label says what it opens rather than "more". "Everything should
          // be manageable on the phone" is a hard rule, and an unlabelled dot
          // menu is how a setting becomes web-only in practice.
          accessibilityLabel={`${tracker.name} settings`}
          testID={`tracker-menu-${tracker.id}`}
        >
          <Icon name="settings" size={16} color={vola.textMuted} />
        </Pressable>
      </RNView>

      <Text style={styles.value} testID={`tracker-value-${tracker.id}`}>
        {valueLine(tracker, entries)}
        {amount ? <Text style={styles.amount}>{`  ·  ${amount}`}</Text> : null}
      </Text>

      <RNView
        style={styles.row}
        accessibilityLabel={rowLabel(tracker, entries)}
        testID={`tracker-row-${tracker.id}`}
      >
        <Pressable
          onPress={onAdd}
          hitSlop={6}
          style={[styles.add, { borderColor: fill }]}
          accessibilityRole="button"
          accessibilityLabel={addLabel(tracker)}
          testID={`tracker-add-${tracker.id}`}
        >
          <Icon name="plus" size={16} color={fill} />
        </Pressable>

        {style === 'bar' ? (
          <Bar tracker={tracker} entries={entries} fill={fill} />
        ) : (
          <Glyphs
            tracker={tracker}
            count={count}
            fill={fill}
            single={style === 'dose'}
            onRemoveAt={onRemoveAt}
          />
        )}
      </RNView>

      {target == null ? null : (
        <Text style={styles.foot} testID={`tracker-foot-${tracker.id}`}>
          {/* States the arithmetic and stops. No "keep going", no "you did it". */}
          {count >= target ? `Target ${target} reached` : `${target - count} to go`}
        </Text>
      )}
    </View>
  );
}

/**
 * The glyph row.
 *
 * Each glyph is its own button with its own label, which is the accessibility
 * half of the design: eight identically-labelled shapes are unusable with
 * VoiceOver even though every one of them is technically labelled, because
 * somebody swiping through cannot tell where they are.
 */
function Glyphs({
  tracker,
  count,
  fill,
  single,
  onRemoveAt,
}: {
  tracker: Tracker;
  count: number;
  fill: string;
  single: boolean;
  onRemoveAt: (index: number) => void;
}) {
  const slots = single ? 1 : glyphSlots(tracker, count);
  const size = single ? 44 : 22;
  return (
    <RNView style={styles.glyphs}>
      {Array.from({ length: slots }, (_, i) => {
        const filled = i < count;
        return (
          <Glyph
            key={i}
            filled={filled}
            fill={fill}
            size={size}
            label={glyphLabel(tracker, i, slots, filled)}
            hint={glyphHint(filled)}
            testID={`tracker-glyph-${tracker.id}-${i}`}
            // A filled glyph removes ITS tap; an empty one adds. Tapping a
            // filled cup to empty it is the correction a one-handed mis-tap
            // needs, and a tracker you cannot correct gets abandoned.
            onPress={() => onRemoveAt(i)}
            disabled={!filled}
          />
        );
      })}
    </RNView>
  );
}

/**
 * One glyph, filling on a spring.
 *
 * The animation is driven from `filled` rather than fired on press, so a glyph
 * that fills because the day was re-read from SQLite — or because another
 * device logged it — animates identically to one the athlete just tapped.
 * `useNativeDriver` because opacity and scale are both compositor properties;
 * this row can be tapped four times in a second and must not go through JS.
 */
function Glyph({
  filled,
  fill,
  size,
  label,
  hint,
  onPress,
  disabled,
  testID,
}: {
  filled: boolean;
  fill: string;
  size: number;
  label: string;
  hint: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  // `useState` with a lazy initialiser rather than `useRef`, and the difference
  // is not cosmetic: reading `.current` during render is what `react-hooks/refs`
  // flags, and this app holds its lint warnings on a ratchet precisely so a new
  // one has to be argued for. The value is created once and never replaced,
  // which is all the animation needs.
  const [t] = useState(() => new Animated.Value(filled ? 1 : 0));
  useEffect(() => {
    Animated.spring(t, {
      toValue: filled ? 1 : 0,
      useNativeDriver: true,
      friction: 7,
      tension: 90,
    }).start();
  }, [filled, t]);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabled ? undefined : hint}
      // Read as a checkbox by VoiceOver, so the state is spoken by the system
      // as well as being in the label. Belt and braces on the one row in the
      // app that is a wall of identical shapes.
      accessibilityState={{ checked: filled, disabled }}
      testID={testID}
    >
      <RNView
        style={[
          styles.glyph,
          { width: size, height: size, borderRadius: size / 3, borderColor: fill },
        ]}
      >
        <Animated.View
          style={[
            styles.glyphFill,
            {
              backgroundColor: fill,
              borderRadius: size / 3 - 2,
              opacity: t,
              transform: [{ scaleY: t }],
            },
          ]}
        />
      </RNView>
    </Pressable>
  );
}

/**
 * The bar, for a tracker whose row would not be countable.
 *
 * Deliberately not tappable per-unit: at this scale there is nothing to point
 * at. The `+` adds and the card's own screen removes, which is the honest
 * affordance rather than thirty invisible hit targets.
 */
function Bar({
  tracker,
  entries,
  fill,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  fill: string;
}) {
  const p = progress(tracker, entries);
  return (
    <RNView style={styles.barTrack} testID={`tracker-bar-${tracker.id}`}>
      <RNView
        style={[styles.barFill, { backgroundColor: fill, width: `${Math.round(p * 100)}%` }]}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, flex: 1 },
  value: { fontSize: 15, fontWeight: '700', color: vola.text },
  amount: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  add: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wraps rather than scrolls: twelve is the cap, and twelve 22pt glyphs fit
  // two rows on the narrowest phone this app supports. Past twelve the card is
  // a bar, so this never becomes the uncountable block N78 forbids.
  glyphs: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  glyph: {
    borderWidth: 1.5,
    alignItems: 'stretch',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  glyphFill: { flex: 1, margin: 1.5 },
  barTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: vola.gridRest,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 5 },
  foot: { fontSize: 12, color: vola.textMuted, fontWeight: '600' },
});
