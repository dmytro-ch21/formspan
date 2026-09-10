/**
 * One logged entry inside a `MealCard` — N531/#962.
 *
 * Pulled out of `MealCard` because a draggable row needs hooks of its own (an
 * `Animated.Value` and a `PanResponder` per row), and `MealCard` maps over
 * entries — hooks inside a `.map` are the rule-of-hooks violation the
 * typechecker cannot see. Everything the row shows is still passed in
 * computed; this file owns the row's gestures and nothing about the meal.
 *
 * ## Four gestures on one row, and who wins
 *
 * - **Tap** opens the entry (or toggles it while combine-selecting). The
 *   `Pressable` is the responder from touch-down, as before.
 * - **Horizontal swipe** reveals Delete — `SwipeToDelete`, the row's PARENT,
 *   steals the responder on a decisively horizontal move. Unchanged.
 * - **Long-press, then move** lifts the row and drags it. `onLongPress` ARMS
 *   the drag (`flags.arm()`); the wrapper's `PanResponder` claims the
 *   responder on the NEXT move only while armed, taking it from the
 *   `Pressable` the way `SwipeToDelete` already takes it. A move before the
 *   long-press timer fires is a scroll or a swipe, exactly as it was.
 * - **Drag the handle** (N553) does the same thing with no hold at all, and
 *   the handle only exists once the meal is in edit mode. Its own
 *   `PanResponder` claims on TOUCH-DOWN — the row's does not and must not,
 *   because the row is also a button and a scroll surface, whereas the grip
 *   at the end of a row (44 × 44 — see `styles.grip`, which is measured
 *   rather than asserted) is only ever one thing.
 *
 * ## What long-press MEANS now, which is one thing (N553/#1019)
 *
 * **Long-press puts this row's meal into edit mode, and picks this row up.**
 * That is a single meaning, not two: lifting the finger without moving leaves
 * the meal in edit mode with every row showing a handle, and moving the finger
 * drags — the same continuous gesture N531 shipped, which is why that muscle
 * memory is not broken by this ticket. The athlete's own words were "on press
 * hold it should enter a edit mode with movable items up and down"; edit mode
 * is what makes the second and third moves cost no hold at all.
 *
 * The alternative — keep N531's immediate drag and hang edit mode off a
 * separate button — was rejected in the history entry: two ways to move a row
 * is a worse story than one, and it would have left the gesture the athlete
 * actually performed still doing the thing they said was wrong.
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
import { Animated, PanResponder, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { glyphFor } from '@/lib/foodGlyph';
import { loggedAmountLabel } from '@/lib/foodQuantity';
import { type Entry, type Meal } from '@/lib/nutrition';
import type { FoodUnit } from '@/lib/units';
import { PressableScale } from '@/components/ui/PressableScale';

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
  /** N553 — long-press also puts the row's meal into edit mode. */
  onEnterEdit: (meal: Meal) => void;
  /**
   * N553 — move a row one place, without a gesture. `delta` is -1 for up and
   * +1 for down. The VoiceOver equivalent of the drag, and the reason edit
   * mode is reachable at all with a screen reader on.
   */
  onNudge: (id: string, meal: Meal, delta: number) => void;
  onStart: (id: string, meal: Meal) => void;
  onMove: (pageY: number) => void;
  onEnd: (pageY: number) => void;
  onCancel: () => void;
};

export function EntryRow({
  entry,
  selecting,
  editing = false,
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
  /**
   * N553 — this row's meal is in edit mode: show the grip instead of the
   * 3-dot, and let the grip start a drag with no hold. Default false so every
   * caller and test written before N553 renders exactly as it did.
   */
  editing?: boolean;
  isSelected: boolean;
  /** The accent the selected checkbox fills with. */
  addColor: string;
  /** The colour the tick draws in on that fill. */
  checkColor: string;
  foodUnit: FoodUnit;
  /** Tap: open the entry, or toggle it while selecting — the caller decides. */
  onPress: () => void;
  /** The 3-dot control. Not rendered when absent, or while editing. */
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

  // The grip's responder, and the one place in this file that claims a touch
  // on TOUCH-DOWN. That is safe here and nowhere else on the row: the handle
  // is rendered only in edit mode, it is 44 points of nothing but grip, and it
  // has no second meaning to swallow. The row itself still must not, because
  // it is simultaneously a button (tap opens the entry) and part of a scroll
  // surface.
  const onStart = drag?.onStart;
  const handleResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          flags.arm();
          flags.grant();
          lift.setValue(0);
          onStart?.(entry.id, entry.meal);
        },
        onPanResponderMove: (_e, g) => {
          lift.setValue(g.dy);
          onMove?.(g.moveY);
        },
        onPanResponderRelease: (_e, g) => {
          onEnd?.(g.moveY);
          settle();
        },
        onPanResponderTerminate: () => {
          onCancel?.();
          settle();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [flags, lift, settle, onStart, onMove, onEnd, onCancel, entry.id, entry.meal],
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
      <PressableScale
        style={[styles.row, isDragging && styles.rowDragging]}
        onPress={onPress}
        onPressIn={flags.reset}
        onLongPress={
          dragEnabled
            ? () => {
                // ONE meaning, two consequences that are the same intention:
                // the meal enters edit mode (and stays there when the finger
                // lifts), and this row is picked up (so a continuous
                // hold-and-drag works with no second gesture). See the doc
                // comment above for why this replaced N531's drag-only
                // long-press rather than sitting beside it.
                flags.arm();
                drag?.onEnterEdit(entry.meal);
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
      </PressableScale>
      {/* OUTSIDE the row's Pressable, as a sibling — nested pressables fight
          over one touch, and neither of these may be reachable while the row
          is a checkbox. Both reach 44 × 44 over the icon's own 18, and by
          DIFFERENT means, stated here because the comment that used to sit
          in this slot claimed 44 for a target that measured 30 across (see
          `styles.grip`): the grip gets its 44 from padding, because a
          `PanResponder` on a bare `View` is not a `Pressable` and `hitSlop`
          outside a clipping ancestor is not something to bet a gesture on;
          the 3-dot keeps its narrow padding and takes the rest from
          `hitSlop`, because it is a tap and a tap can afford that.

          Edit mode swaps the 3-dot for the grip rather than adding it beside:
          the row already carries a tap, a swipe, a long-press and a drag, and
          a fifth control competing for the same 44 points is how a thumb hits
          the wrong one. The menu's actions are all reachable again the moment
          edit mode ends, which is one tap on Done. */}
      {dragEnabled && editing ? (
        <RNView
          {...handleResponder.panHandlers}
          style={styles.grip}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Reorder ${entry.name}`}
          accessibilityHint="Drag to move this item up or down, or use the actions to move it one place"
          // A drag has no assistive-tech equivalent, so the same two moves are
          // offered as ACTIONS — the rotor's answer to a gesture VoiceOver
          // cannot perform. This is the gap N531's own doc comment named and
          // could only point elsewhere for; within-meal order had nowhere else
          // to be set, so here it is closed rather than deferred.
          accessibilityActions={[
            { name: 'increment', label: 'Move up' },
            { name: 'decrement', label: 'Move down' },
          ]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') drag?.onNudge(entry.id, entry.meal, -1);
            if (e.nativeEvent.actionName === 'decrement') drag?.onNudge(entry.id, entry.meal, 1);
          }}
          testID={`food-entry-${entry.id}-grip`}
        >
          <Icon name="grip" size={18} color={vola.textMuted} />
        </RNView>
      ) : onMenu && !selecting ? (
        <PressableScale
          onPress={onMenu}
          style={styles.more}
          // 30 across + 7 either side = 44. It was 6 (giving 42), which is
          // the same near-miss the grip had in a form that at least reached
          // most of the way; one point makes the number the one Apple's own
          // minimum states.
          hitSlop={7}
          accessibilityRole="button"
          accessibilityLabel={`More for ${entry.name}`}
          accessibilityHint="Duplicate, remove or share this entry"
          testID={`food-entry-${entry.id}-more`}
        >
          {/*
            W23/#1020 — `textDim`, not `textMuted`, and the difference is the
            whole ticket. The athlete's verdict on the row was *"it is ugly
            they better blend into the item somehow"*, and measured against the
            card (`vola.surface` #10151F) `textMuted` sits at **6.85:1** —
            louder than most of the row's own text, on a control almost nobody
            taps. `textDim` is **3.67:1**: it recedes into the row and still
            clears WCAG 1.4.11's 3:1 for an interactive component.

            That floor is the reason this stops here rather than going quieter.
            Everything below `textDim` fails it — `textMuted` at 55% opacity is
            2.93, `textDim` at 80% is 2.81 — and a control the athlete cannot
            find is not a subtler control, it is a missing one. See the tests
            in `entryRowAffordance.test.ts`, which pin both numbers.

            Reveal-on-interaction is the obvious next idea and there is nowhere
            to put it: this dot is a sibling of the row's `Pressable` (nested
            pressables fight), the row's own press OPENS the entry, and mobile
            has no hover. Long-press and swipe are both spoken for — edit mode
            and reorder (N553), and delete — so a context menu has no gesture
            left to live on either. A quieter dot is the whole available move.
          */}
          <Icon name="more" size={18} color={vola.textDim} />
        </PressableScale>
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
  // The 3-dot: 13 + 18 + 13 = 44 tall, 10 + 18 + 2 = 30 across, and the
  // missing 14 comes from its `hitSlop={7}` above. A `Pressable` may do that;
  // the grip may not (below).
  more: { paddingVertical: 13, paddingLeft: 10, paddingRight: 2 },
  // N553 — the grip, and the arithmetic is the point: 13 + 18 + 13 = 44 tall,
  // 24 + 18 + 2 = 44 across, over an 18pt icon. It is 44 of REAL PADDING, not
  // 30 of padding and a promise, which is what shipped in the first draft of
  // this ticket and what frontend-reviewer caught: the file's own comments
  // said "44 points of grip" while the style said 10 + 18 + 2 = 30, and a
  // thumb landing in the missing 14 hit the row's `Pressable` and OPENED the
  // entry instead of picking it up — the exact failure #1019's fifth
  // criterion ("draggable without a second hand") is about.
  //
  // The 24 is all on the LEFT so the icon does not move when edit mode swaps
  // the 3-dot for the grip (both keep `paddingRight: 2`); the row's own
  // `Pressable` is a sibling, not an ancestor, so a wider grip SHRINKS it
  // rather than overlapping it — the 14 points are taken from the far end of
  // a full-width row, and nothing else lives there.
  grip: { paddingVertical: 13, paddingLeft: 24, paddingRight: 2 },

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
