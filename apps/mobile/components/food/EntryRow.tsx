/**
 * One logged entry inside a `MealCard` — N531/#962.
 *
 * Pulled out of `MealCard` because a draggable row needs hooks of its own (an
 * `Animated.Value` and a `PanResponder` per row), and `MealCard` maps over
 * entries — hooks inside a `.map` are the rule-of-hooks violation the
 * typechecker cannot see. Everything the row shows is still passed in
 * computed; this file owns the row's gestures and nothing about the meal.
 *
 * ## Three gestures on one row, and who wins
 *
 * - **Tap** opens the entry (or toggles it while combine-selecting). The
 *   `Pressable` is the responder from touch-down, as before.
 * - **Horizontal swipe** reveals Delete — `SwipeToDelete`, the row's PARENT,
 *   steals the responder on a decisively horizontal move. Unchanged.
 * - **Long-press, then move** lifts the row and drags it to another meal.
 *   New. `onLongPress` ARMS the drag (`flags.arm()`); the wrapper's
 *   `PanResponder` claims the responder on the NEXT move only while armed,
 *   taking it from the `Pressable` the way `SwipeToDelete` already takes it.
 *   A move before the long-press timer fires is a scroll or a swipe, exactly
 *   as it was — the arm is the whole difference, and it costs the athlete a
 *   deliberate 300ms hold.
 *
 * While a drag is the responder, `SwipeToDelete`'s own claim is asked on
 * every move (it is a non-responder ancestor) and would take a diagonal
 * drag away; `onPanResponderTerminationRequest: () => false` refuses it. The
 * native `ScrollView` cannot be refused on iOS (see `SwipeToDelete`'s doc
 * comment), which is why the day view locks its own scroll for the length of
 * the drag — that is `food.tsx`'s job, via `scrollEnabled`.
 *
 * ## Why the drag is inert while selecting
 *
 * A row in combine-select mode is a checkbox. `onLongPress` is simply not
 * wired then, so nothing arms, so the pan never claims — the same shape as
 * `SwipeToDelete`'s `enabled={!selecting}` one level up, and for the same
 * reason: a gesture that is not offered cannot fight the one that is.
 *
 * ## Accessibility
 *
 * A drag has no assistive-tech equivalent, and none is invented here: moving
 * an entry between meals is ALREADY reachable from the entry screen's meal
 * picker (`app/food/entry/[id].tsx`), which is where a screen-reader user
 * changes a meal today. The 3-dot control is a labelled button — "More for
 * Greek yoghurt" — hidden while selecting for the same reason the drag is.
 */

import { useCallback, useMemo, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { glyphFor } from '@/lib/foodGlyph';
import { loggedAmountLabel } from '@/lib/foodQuantity';
import { type Entry, type Meal } from '@/lib/nutrition';
import type { FoodUnit } from '@/lib/units';

/** How long the finger has to hold still before a move becomes a drag. */
export const LONG_PRESS_MS = 300;

/**
 * The two facts a row's gesture handlers pass between themselves: has the
 * long-press ARMED a drag, and has the pan responder then been GRANTED it.
 * Written by touch handlers, read by the responder, never read in render —
 * imperative bookkeeping in the same sense an `Animated.Value` is, and held
 * the same way (one instance per row, from a `useState` initialiser).
 *
 * A closure with methods rather than a ref or a mutable object, and the
 * reason is the lint, stated plainly: `react-hooks/refs` flags a ref handed
 * to `PanResponder.create` (it cannot tell a lazy read from a render-time
 * one) and this app holds that rule at a ratcheted cap;
 * `react-hooks/immutability` flags property writes on a `useState` value.
 * Neither can see inside a closure, and neither needs to — nothing here is
 * rendered.
 */
export function gestureFlags() {
  let armed = false;
  let granted = false;
  return {
    /** The long-press fired: the next move may claim the responder. */
    arm() {
      armed = true;
    },
    /** The responder took the touch. */
    grant() {
      granted = true;
    },
    /** Touch-down, or the gesture settled: back to nothing. */
    reset() {
      armed = false;
      granted = false;
    },
    isArmed: () => armed,
    wasGranted: () => granted,
  };
}

/**
 * What a row needs from the day view's drag coordinator (`useEntryDrag`).
 * Absent entirely when the caller does not drag — every existing `MealCard`
 * caller and test keeps working without it.
 */
export type EntryDragHandlers = {
  /** False while combine-selecting, or with nobody to write for. */
  enabled: boolean;
  /** The entry currently lifted anywhere on screen, or null. */
  activeId: string | null;
  onStart: (id: string, meal: Meal) => void;
  onMove: (pageY: number) => void;
  onEnd: (pageY: number) => void;
  onCancel: () => void;
};

export function EntryRow({
  entry,
  selecting,
  isSelected,
  addColor,
  checkColor,
  foodUnit,
  onPress,
  onMenu,
  drag,
}: {
  entry: Entry;
  selecting: boolean;
  isSelected: boolean;
  /** The accent the selected checkbox fills with. */
  addColor: string;
  /** The colour the tick draws in on that fill. */
  checkColor: string;
  foodUnit: FoodUnit;
  /** Tap: open the entry, or toggle it while selecting — the caller decides. */
  onPress: () => void;
  /** The 3-dot control. Not rendered when absent. */
  onMenu?: () => void;
  drag?: EntryDragHandlers;
}) {
  // One of each per row, for the row's lifetime — see `gestureFlags`.
  const [lift] = useState(() => new Animated.Value(0));
  const [flags] = useState(gestureFlags);
  const dragEnabled = !!drag && drag.enabled && !selecting;
  const isDragging = !!drag && drag.activeId === entry.id;

  // The responder is memoised on the callbacks it forwards to and on the one
  // thing that changes its DECISION (`dragEnabled`) — never on `activeId`,
  // which changes on the very gesture it is handling. A `PanResponder`
  // rebuilt mid-drag starts a fresh `gestureState`, and `dy` would snap to
  // zero under a moving finger. `useEntryDrag`'s callbacks are stable across
  // a drag, so with `food.tsx` memoising the object it hands down, this only
  // rebuilds when selecting starts or stops.
  const onMove = drag?.onMove;
  const onEnd = drag?.onEnd;
  const onCancel = drag?.onCancel;

  const settle = useCallback(() => {
    flags.reset();
    Animated.spring(lift, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
  }, [flags, lift]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Never on touch-down: that would swallow the tap. Only on a move,
        // and only once the long-press has armed it.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: () => dragEnabled && flags.isArmed(),
        onPanResponderGrant: () => {
          flags.grant();
          lift.setValue(0);
        },
        onPanResponderMove: (_e, g) => {
          lift.setValue(g.dy);
          onMove?.(g.moveY);
        },
        onPanResponderRelease: (_e, g) => {
          onEnd?.(g.moveY);
          settle();
        },
        // Taken away by something this cannot refuse (the native scroll on
        // iOS, a system gesture). Not a drop — the finger never lifted on a
        // section the athlete chose.
        onPanResponderTerminate: () => {
          onCancel?.();
          settle();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [dragEnabled, flags, lift, settle, onMove, onEnd, onCancel],
  );

  return (
    <Animated.View
      style={[
        styles.wrap,
        isDragging && styles.lifted,
        { transform: [{ translateY: lift }, { scale: isDragging ? 1.02 : 1 }] },
      ]}
      {...responder.panHandlers}
      testID={`food-entry-${entry.id}-row`}
    >
      <Pressable
        style={[styles.row, isDragging && styles.rowDragging]}
        onPress={onPress}
        onPressIn={flags.reset}
        onLongPress={
          dragEnabled
            ? () => {
                flags.arm();
                drag?.onStart(entry.id, entry.meal);
              }
            : undefined
        }
        onPressOut={() => {
          // The finger lifted (or the press was cancelled) WITHOUT the pan ever
          // taking over — a long-press with no movement. The row was announced
          // as lifted; un-lift it, or the day view stays scroll-locked on a
          // drag that never happened. When the pan DID take over, its own
          // release/terminate handles this, and `granted` says so — the
          // responder system grants the new responder before it terminates
          // the old one, so the flag is already set by the time this fires.
          if (flags.isArmed() && !flags.wasGranted()) {
            flags.reset();
            onCancel?.();
          }
        }}
        delayLongPress={LONG_PRESS_MS}
        // Selecting: a checkbox, not a button — `{ checked }` is what
        // announces "toggleable, currently on/off" rather than the generic
        // "button, selected" a `selected` state on a button role reads as.
        // Found in review (N115).
        accessibilityRole={selecting ? 'checkbox' : 'button'}
        accessibilityLabel={`${entry.name}, ${Math.round(entry.kcal)} calories`}
        accessibilityState={selecting ? { checked: isSelected } : undefined}
        testID={selecting ? `food-entry-${entry.id}-select` : `food-entry-${entry.id}-open`}
      >
        {selecting ? (
          <RNView
            style={[styles.checkbox, isSelected && { backgroundColor: addColor, borderColor: addColor }]}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {isSelected ? <Text style={[styles.checkboxTick, { color: checkColor }]}>✓</Text> : null}
          </RNView>
        ) : (
          <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
            {glyphFor(entry.category)}
          </Text>
        )}
        <RNView style={styles.rowMain}>
          <Text style={styles.rowName} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={styles.rowServing}>
            {loggedAmountLabel(entry.servings, entry.serving_label, foodUnit)}
          </Text>
        </RNView>
        <Text style={styles.rowKcal}>{Math.round(entry.kcal)}</Text>
      </Pressable>
      {/* OUTSIDE the row's Pressable, as a sibling — nested pressables fight
          over one touch, and this one must not be reachable while the row is
          a checkbox. 44pt square via padding, over the icon's own 18. */}
      {onMenu && !selecting ? (
        <Pressable
          onPress={onMenu}
          style={styles.more}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`More for ${entry.name}`}
          accessibilityHint="Duplicate, remove or share this entry"
          testID={`food-entry-${entry.id}-more`}
        >
          <Icon name="more" size={18} color={vola.textMuted} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center' },
  // Painted over its siblings while lifted. The card it belongs to gets the
  // same treatment from `MealCard` so the row also paints over the NEXT card
  // as it crosses into it — zIndex only orders siblings.
  lifted: { zIndex: 10, elevation: 10 },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  // The lifted row says so: a hairline in the section accent would tie it to
  // one card, and it is between cards, so the surface itself brightens.
  rowDragging: { borderWidth: 1, borderColor: vola.line, shadowOpacity: 0.3, shadowRadius: 8 },
  glyph: { fontSize: 20 },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 14, fontWeight: '600' },
  rowServing: { fontSize: 12, color: vola.textDim },
  rowKcal: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  more: { paddingVertical: 13, paddingLeft: 10, paddingRight: 2 },

  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxTick: { fontSize: 12, fontWeight: '700' },
});
