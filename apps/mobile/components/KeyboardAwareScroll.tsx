import { useFocusEffect } from 'expo-router';
import { createContext, forwardRef, useCallback, useContext, useEffect, useRef } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';

/**
 * Keeps the focused input visible in the one case iOS doesn't cover.
 *
 * **The first version of this file documented the wrong mechanism, and the
 * wrong mechanism justified a bug.** It claimed
 * `automaticallyAdjustKeyboardInsets` "adjusts the inset but never scrolls".
 * That is false. In `RCTScrollViewComponentView.mm`'s
 * `_keyboardWillChangeFrame:`, RN asks the first responder for its focus rect
 * and, when the field's bottom sits below the keyboard, sets
 * `contentDiff = keyboardEndFrame.origin.y - focusEnd` and scrolls by it — on
 * the keyboard's own animation curve. `RCTTextInputComponentView.mm` even
 * supplies a 15pt margin. iOS already lifts the field on every keyboard
 * appearance, and does it better than this file can.
 *
 * **The real gap is that it only runs when the keyboard's FRAME CHANGES.**
 * Every field on the session screen is a `number-pad` or `decimal-pad`, and
 * those are the same height. So moving focus Weight → Reps → RIR → RPE, or
 * expanding a lower row while the keyboard is already up and tapping into it,
 * posts no keyboard notification at all — no notification, no native scroll,
 * and the field you just tapped stays hidden. That is precisely the gym
 * report, and the only case this file exists to handle.
 *
 * **So on iOS the keyboard listeners deliberately do not scroll.** They only
 * record where the keyboard is. Scrolling from them as well would race the
 * native adjustment: `offset.current` lags behind (it updates from throttled
 * `onScroll` events), so a JS scroll computed after the native one has landed
 * uses a stale offset and drags the list back down — hiding the field again,
 * intermittently, depending which won. Two mechanisms doing one job is worse
 * than either alone.
 *
 * Android needs the opposite, because `automaticallyAdjustKeyboardInsets` is
 * `@platform ios`: nothing there lifts the field for us, so the show event
 * has to.
 *
 * **Measured, not assumed.** The target comes from `measureInWindow` rather
 * than a row index, because set rows differ in height by the exercise's
 * measures (reps-only vs weight+reps vs distance+seconds) and by whether the
 * row is expanded.
 */

type EnsureVisible = (node: Measurable | null) => void;

/** The bit of a ref we actually use — TextInput and View both satisfy it. */
type Measurable = {
  measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void;
};

/**
 * Gap left between the field and the top of the keyboard.
 *
 * A little more than the 15pt iOS uses natively, so a field lifted by this
 * file sits clearly free rather than looking like a near-miss of the platform
 * behaviour.
 */
const MARGIN = 24;

/**
 * Which keyboard events exist on this platform.
 *
 * **`keyboardWillShow`/`keyboardWillHide` are iOS-only.** Android never emits
 * them, so using the iOS names there is not a slightly-worse experience — it
 * is dead code, and the whole feature silently does nothing while reading as
 * correct. One line deciding whether a feature exists at all, which is why it
 * is a tested function rather than a comment.
 */
export function keyboardEventNames(os: string): {
  show: 'keyboardWillShow' | 'keyboardDidShow';
  hide: 'keyboardWillHide' | 'keyboardDidHide';
  changeFrame: 'keyboardWillChangeFrame' | null;
} {
  return os === 'ios'
    ? { show: 'keyboardWillShow', hide: 'keyboardWillHide', changeFrame: 'keyboardWillChangeFrame' }
    : { show: 'keyboardDidShow', hide: 'keyboardDidHide', changeFrame: null };
}

/**
 * Does the platform lift the focused field by itself when the keyboard shows?
 *
 * iOS does — see the note at the top: `automaticallyAdjustKeyboardInsets`
 * genuinely scrolls, it does not merely inset. Android has no equivalent.
 *
 * This decides whether the show listener scrolls or only records, and it is
 * wrong in a different way in each direction: `true` on Android means nothing
 * ever lifts, `false` on iOS means two mechanisms fight over one scroll
 * position with a stale offset between them.
 */
export function nativeScrollsFocusedFieldClear(os: string): boolean {
  return os === 'ios';
}

/**
 * Where to scroll so a field clears the keyboard, or null to leave it alone.
 *
 * Pure, because it is the only arithmetic here and `apps/mobile` has no
 * component test runner — extracting it is the difference between this being
 * covered and being hoped about.
 */
export function scrollTargetFor(a: {
  /** Field's absolute Y on screen. */
  fieldY: number;
  fieldHeight: number;
  /** Absolute Y of the keyboard's top edge; null when it is down. */
  keyboardTop: number | null;
  /**
   * Absolute Y of the bottom of the scroll view itself.
   *
   * Not the same as `keyboardTop`, because the platforms hide the field in
   * different ways. iOS leaves the window alone and puts the keyboard over
   * it, so the keyboard's edge is the boundary. Android's default
   * `softwareKeyboardLayoutMode` is `resize`, so the WINDOW shrinks — the
   * scroll view is now short, the keyboard is not over it at all, and the
   * field is clipped by the view's own bottom.
   *
   * Taking whichever edge is higher describes both without branching on
   * `Platform` for geometry, and degrades sensibly for a case neither of us
   * predicted (a split keyboard, a floating window).
   */
  containerBottom: number;
  /** The scroll view's current offset. */
  offset: number;
}): number | null {
  if (a.keyboardTop === null) return null;
  // A node mid-layout measures as zero height. Scrolling on that would jump
  // the list somewhere arbitrary, which is worse than not scrolling at all —
  // the field is still reachable by hand.
  if (a.fieldHeight <= 0) return null;
  const usableBottom = Math.min(a.keyboardTop, a.containerBottom);
  const overlap = a.fieldY + a.fieldHeight + MARGIN - usableBottom;
  // Already clear. Scrolling anyway would drag the list under someone's thumb
  // every time they moved between two fields that were both visible.
  if (overlap <= 0) return null;
  return a.offset + overlap;
}

const Ctx = createContext<EnsureVisible>(() => {});

/**
 * Call with a focused input's ref to scroll it clear of the keyboard.
 *
 * A context rather than a prop, because the inputs are two components deep
 * (screen → SetRow → Field) and threading a callback through every row would
 * put keyboard plumbing in the signature of a component that renders a number.
 */
export function useEnsureVisible(): EnsureVisible {
  return useContext(Ctx);
}

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function KeyboardAwareScrollView({ children, onScroll, ...props }, forwardedRef) {
    const scrollRef = useRef<ScrollView>(null);
    /** Current scroll offset — `scrollTo` is absolute, and there is no `scrollBy`. */
    const offset = useRef(0);
    /** Absolute Y of the top of the keyboard; null when it is down. */
    const keyboardTop = useRef<number | null>(null);
    /** The field to keep visible. */
    const focused = useRef<Measurable | null>(null);

    /**
     * Whether this screen is the one on top.
     *
     * `Keyboard` listeners are global, and the session screen stays mounted
     * when the exercise picker is pushed over it. Without this, focusing the
     * picker's search field fires this screen's handler, which measures and
     * scrolls a list nobody can see — and you come back to a session that has
     * moved under you.
     */
    const onTop = useRef(true);
    useFocusEffect(
      useCallback(() => {
        onTop.current = true;
        return () => {
          onTop.current = false;
        };
      }, []),
    );

    const scrollClear = useCallback((node: Measurable | null) => {
      const kbTop = keyboardTop.current;
      const scroller = scrollRef.current;
      if (!node || kbTop === null || !scroller || !onTop.current) return;
      // `ScrollView`'s type does not declare `measureInWindow` — it is a
      // native method on the underlying view — so this is checked rather than
      // cast. A blind cast would turn a future RN change into a crash on the
      // one screen that must never crash mid-workout.
      const frame = scroller as unknown as Partial<Measurable>;
      if (typeof frame.measureInWindow !== 'function') return;
      // The scroll view is measured too, not just the field — see
      // `containerBottom` for why the keyboard's edge alone is not the
      // boundary on every platform.
      frame.measureInWindow((_sx: number, sy: number, _sw: number, sh: number) => {
        node.measureInWindow((_x, y, _w, h) => {
          const target = scrollTargetFor({
            fieldY: y,
            fieldHeight: h,
            keyboardTop: kbTop,
            containerBottom: sy + sh,
            offset: offset.current,
          });
          if (target === null) return;
          scrollRef.current?.scrollTo({ y: target, animated: true });
        });
      });
    }, []);

    useEffect(() => {
      const names = keyboardEventNames(Platform.OS);
      const nativeHandlesIt = nativeScrollsFocusedFieldClear(Platform.OS);
      const track = (e: { endCoordinates: { screenY: number } }) => {
        keyboardTop.current = e.endCoordinates.screenY;
        // Deliberately does NOT scroll on iOS: the platform is already doing
        // it for this very event, and a second scroll from here would race it
        // with a stale offset. Android gets no such help, so there it must.
        if (!nativeHandlesIt) scrollClear(focused.current);
      };
      const subs = [
        Keyboard.addListener(names.show, track),
        Keyboard.addListener(names.hide, () => {
          keyboardTop.current = null;
          // Cleared, so a later frame change cannot re-scroll to a field that
          // no longer has focus. The scroll POSITION is deliberately left
          // alone — the content returns via the inset (iOS) or the window
          // resize (Android), and yanking the list back to where it was would
          // move the row out from under someone still reading it.
          focused.current = null;
        }),
      ];
      if (names.changeFrame) subs.push(Keyboard.addListener(names.changeFrame, track));
      return () => subs.forEach((s) => s.remove());
    }, [scrollClear]);

    const ensureVisible = useCallback<EnsureVisible>(
      (node) => {
        focused.current = node;
        // The case that matters, and the only one the platform misses: the
        // keyboard is ALREADY up (so `keyboardTop` is set) and focus moved to
        // another same-height field, which posts no keyboard event. On the
        // first tap `keyboardTop` is still null, this is a no-op, and iOS
        // does the work when the keyboard arrives.
        scrollClear(node);
      },
      [scrollClear],
    );

    const handleScroll = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.y;
        onScroll?.(e);
      },
      [onScroll],
    );

    return (
      <Ctx.Provider value={ensureVisible}>
        <ScrollView
          // Before the spread so a caller can override it; `onScroll` goes
          // after, because tracking `offset` is not optional.
          scrollEventThrottle={16}
          {...props}
          ref={(node) => {
            scrollRef.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          onScroll={handleScroll}
        >
          {children}
        </ScrollView>
      </Ctx.Provider>
    );
  },
);

/** The margin, exported so a caller can reason about the spacing it gets. */
export const KEYBOARD_MARGIN = MARGIN;
