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
 * **`PanResponder`, not `react-native-gesture-handler`.** RNGH is better at
 * gesture composition and is already in the store as an optional peer of
 * `expo-router` — so the honest cost is not "a new dependency" but a fresh
 * native build of the `expo run:ios --device` artifact this project installs
 * on real phones. That is still a real cost for one row interaction, and
 * PanResponder is sufficient here, but the earlier version of this comment
 * overstated the case.
 *
 * **The competing-gesture problem, accurately.** On iOS a JS responder cannot
 * actually stop a native `UIScrollView` pan: `blockNativeResponder` is
 * Android-only, and `RCTSurfaceTouchHandler` refuses to be prevented by a
 * recognizer inside the surface. So on iOS an over-eager claim causes a
 * diagonal drag to swipe AND scroll at once, not a frozen list. The "list
 * intermittently refuses to scroll" failure is the ANDROID one — which is
 * also the platform this has never been run on. Either way the predicate
 * below is deliberately conservative: decisively horizontal AND past a
 * threshold.
 *
 * One consequence worth knowing: `TextInput` defaults `rejectResponderTermination`
 * to true, so a swipe that STARTS on a focused field is ignored. The swipe
 * target is the row, not the inputs on an expanded row.
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
export function shouldClaim(dx: number, dy: number, enabled: boolean): boolean {
  // `enabled` lives IN here rather than beside the call, so the
  // finished-session guard is covered by the same tests as the geometry.
  // Outside the function it was the one thing that can destroy a logged set
  // and had no test that could reach it.
  if (!enabled) return false;
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

  useEffect(() => {
    // Refusing new claims is not enough. Swipe a row open, scroll down, tap
    // "Finish session" — `enabled` goes false while `open` stays true, and a
    // Delete sits armed on a session that is now a read-only record.
    if (!enabled) close();
  }, [enabled, close]);

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
        onMoveShouldSetPanResponder: (_e, g) => shouldClaim(g.dx, g.dy, enabled),
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
      {/* Behind the row.
          `pointerEvents` blocks the TOUCH, but it is NOT an accessibility
          gate — it maps to `userInteractionEnabled`, which governs hit
          testing only, while the accessibility tree is walked independently.
          Left at that, VoiceOver read "Delete set 1, button" before every
          single row, doubling the elements on the screen and announcing a
          destructive action on rows nobody had swiped — including on a
          finished, read-only session. Worse on Android, where TalkBack
          activation goes through `performClick()`, which `pointerEvents` does
          not gate at all, so the delete could plausibly fire.
          So the subtree is hidden from assistive tech as well as from
          touch. */}
      <View
        style={styles.actions}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
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
    // `navy`, not white. White on `danger` measures 2.78:1 — below AA's 4.5
    // and below even the 3:1 large-text floor — on a destructive control read
    // in gym daylight. navy on the same red is 6.75:1. Every other colour in
    // this app carries a measured ratio in constants/Colors.ts; this one was
    // the first that did not, and it was also the one that failed.
    color: vola.navy,
    fontWeight: '700',
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
