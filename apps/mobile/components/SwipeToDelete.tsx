import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import { vola } from '@/constants/Colors';

/**
 * Swipe a row left to reveal Delete.
 *
 * From the gym: *"Swipe left in progress session to remove a set"*. Removing
 * one was possible before, but only by tapping the row open, scrolling past
 * every field and the set-type chips, and finding "Remove set" at the bottom
 * — which is a fine place for it when you are correcting a session at a desk
 * and a bad one when you added a set by mistake between two working sets.
 *
 * **Reveal-then-tap, not swipe-to-delete.** A full swipe that deletes
 * immediately is the other half of the iOS convention and deliberately not
 * wired here: the thing being deleted is a set you actually performed, the
 * hand doing the swiping is mid-workout and often sweaty, and the row sits in
 * a vertically scrolling list where a slightly diagonal flick is normal. One
 * deliberate tap on a revealed button costs nothing at the speed this is used
 * at, and an accidental deletion costs a set of real training. Say the word
 * and full-swipe is a threshold constant away.
 *
 * **`PanResponder`, not `react-native-gesture-handler`.** The latter is the
 * usual answer and is genuinely better at gesture composition, but it is not
 * currently a dependency, and adding native code to get one row interaction
 * would mean a prebuild and a fresh device build for everyone. RN ships this.
 *
 * **The competing-gesture problem is the whole difficulty.** The row lives in
 * a vertical ScrollView, so claiming a gesture too eagerly breaks scrolling —
 * the failure mode being a list that intermittently refuses to move because a
 * row decided a mostly-vertical drag was a swipe. The claim below therefore
 * requires the movement to be decisively horizontal AND past a threshold, and
 * refuses on the first move rather than waiting to see how the gesture
 * develops.
 */

/** How far the row slides open — wide enough for the button plus padding. */
const ACTION_WIDTH = 96;

/**
 * Horizontal travel before this is a swipe at all.
 *
 * Chosen against the vertical scroll it competes with, not for feel: a real
 * scroll starts with a few pixels of horizontal noise, so anything smaller
 * makes the list stutter.
 */
const CLAIM_DX = 12;

/** Past this, releasing settles open rather than closed. */
const OPEN_AT = ACTION_WIDTH / 2;

/** Speed above which the throw decides, not the distance. */
const FLICK_VX = 0.3;

/**
 * Is this drag a swipe, or the start of a vertical scroll?
 *
 * The single most consequential line in this component, and the one that
 * breaks the screen when it is wrong: claim too eagerly and the list
 * intermittently refuses to scroll, because a row decided a mostly-vertical
 * drag belonged to it.
 */
export function shouldClaim(dx: number, dy: number): boolean {
  // Both conditions matter. The threshold alone lets a steep drag through;
  // the ratio alone lets a 2px twitch through.
  return Math.abs(dx) > CLAIM_DX && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Where the row settles when the finger lifts: 0 closed, -ACTION_WIDTH open. */
export function settleTarget(a: { rest: number; dx: number; vx: number }): number {
  // A fast flick settles in the direction it was thrown regardless of
  // distance — otherwise a quick swipe covering 40px snaps shut, which reads
  // as the gesture simply not working.
  if (a.vx < -FLICK_VX) return -ACTION_WIDTH;
  if (a.vx > FLICK_VX) return 0;
  return a.rest + a.dx < -OPEN_AT ? -ACTION_WIDTH : 0;
}

export function SwipeToDelete({
  children,
  onDelete,
  accessibilityLabel,
  enabled = true,
  closeOn,
  testID,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  /** Names the row, e.g. "Set 2" — read by VoiceOver on the Delete button. */
  accessibilityLabel: string;
  enabled?: boolean;
  /**
   * Any value that changes when the list's shape changes. Open rows close.
   *
   * Needed because the rows are keyed by INDEX — a set has no stable id, only
   * a `position` that is reassigned on every delete. So a component instance
   * outlives the set it was showing: swipe set 3 open, remove set 1 by some
   * other route, and that instance is now rendering set 2 while still holding
   * set 3's open swipe. The athlete sees a Delete button armed against a row
   * they never swiped. iOS dismisses open swipe actions on any list mutation
   * for the same reason.
   */
  closeOn?: unknown;
  testID?: string;
}) {
  const translate = useRef(new Animated.Value(0)).current;
  /** Where the row rests, so a second drag continues rather than restarts. */
  const rest = useRef(0);
  const [open, setOpen] = useState(false);

  const settle = useCallback(
    (to: number) => {
      rest.current = to;
      setOpen(to !== 0);
      Animated.spring(translate, {
        toValue: to,
        useNativeDriver: true,
        bounciness: 0,
      }).start();
    },
    [translate],
  );

  const close = useCallback(() => settle(0), [settle]);

  const firstRun = useRef(true);
  useEffect(() => {
    // Skipped on mount, or every row would animate closed as it appeared.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    close();
  }, [closeOn, close]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // NOT `onStartShouldSetPanResponder`. Claiming on touch-down would
        // swallow taps meant for the row's own controls — the done tick and
        // the expand toggle live inside `children`.
        onMoveShouldSetPanResponder: (_e, g) => enabled && shouldClaim(g.dx, g.dy),
        onPanResponderMove: (_e, g) => {
          const next = rest.current + g.dx;
          // Clamped both ways: left stops at the action's width so the row
          // cannot be dragged off screen, and right stops at 0 because there
          // is nothing revealed on that side to look at.
          translate.setValue(Math.max(-ACTION_WIDTH, Math.min(0, next)));
        },
        onPanResponderRelease: (_e, g) =>
          settle(settleTarget({ rest: rest.current, dx: g.dx, vx: g.vx })),
        // The gesture can be taken away mid-drag (a parent scroll wins).
        // Without this the row is left stranded part-open.
        onPanResponderTerminate: () => settle(rest.current),
        onPanResponderTerminationRequest: () => true,
      }),
    [enabled, settle, translate],
  );

  return (
    <View style={styles.wrap} testID={testID}>
      {/* Behind the row. `pointerEvents` is driven by `open` so the button is
          untappable while hidden — a Delete you cannot see must not be a
          Delete you can hit. */}
      <View style={styles.actions} pointerEvents={open ? 'auto' : 'none'}>
        <Pressable
          onPress={() => {
            close();
            onDelete();
          }}
          style={styles.deleteButton}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${accessibilityLabel}`}
          testID={testID ? `${testID}-delete` : undefined}
        >
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      </View>

      <Animated.View
        style={[styles.row, { transform: [{ translateX: translate }] }]}
        {...responder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  actions: {
    // Spelled out rather than spread from `StyleSheet.absoluteFill`, which is
    // a REGISTERED STYLE ID (a number) — spreading it yields `{}`, so the
    // absolute positioning silently disappears and the button lays out in
    // flow. `absoluteFillObject` is the object form, but this RN version's
    // types don't declare it, and four explicit lines beat working around
    // that.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  deleteButton: {
    width: ACTION_WIDTH,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: vola.danger,
    borderRadius: 12,
  },
  deleteText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  row: {
    // Opaque, and shaped EXACTLY like the row it carries (`setRow` is
    // `surface` at radius 12). Not decoration: this view is what hides the
    // Delete button while the row is closed, so any pixel where its shape
    // differs from the child's is a red sliver at the row's corner. A square
    // backing would also flatten the rounded corners it sits behind.
    backgroundColor: vola.surface,
    borderRadius: 12,
  },
});
