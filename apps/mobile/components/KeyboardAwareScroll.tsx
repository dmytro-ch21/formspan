import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import {
  Keyboard,
  ScrollView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';

/**
 * A ScrollView that lifts the focused input above the keyboard.
 *
 * **Why this exists, given `automaticallyAdjustKeyboardInsets` was already
 * set.** That prop was on the session screen the whole time, and the report
 * from the gym was still *"i had hard time with inputs that are lower and go
 * bihind the keyboard"*. Both are true, because the prop does less than its
 * name suggests: it adjusts the scroll view's **content inset**, so the field
 * becomes *reachable* — it does not **scroll** anything. The keyboard comes
 * up, the field you just tapped is behind it, and iOS's contribution is that
 * you are now allowed to drag it into view yourself. Mid-set, one-handed,
 * that is the complaint rather than the fix.
 *
 * So the inset prop stays (it is what makes the content slide back down when
 * the keyboard goes away, and it keeps the last field scrollable past the
 * fold) and this adds the missing half: on focus, measure the field against
 * the keyboard and scroll it clear.
 *
 * **Measured, not assumed.** The obvious implementation guesses — scroll by a
 * fixed amount, or by the keyboard's height. Both are wrong for the set rows
 * this was built for, whose height varies with the exercise's measures
 * (reps-only versus weight+reps versus distance+seconds) and with whether the
 * row is expanded. `measureInWindow` asks where the field actually is, and
 * the scroll is the exact overlap plus a margin, so a field one pixel behind
 * the keyboard moves one pixel plus the margin rather than a screenful.
 *
 * **Two orderings, both real.** Tapping a field with no keyboard up fires
 * focus *first* and the keyboard frame arrives after; tapping a second field
 * while the keyboard is already up gives the frame first and focus second.
 * Handling only the first ordering is the common bug — it works when you test
 * it once and fails as soon as you tab between fields, which is exactly what
 * logging a set is. So the focused field is remembered and the scroll is
 * attempted from both events.
 *
 * No new dependency. `react-native-keyboard-controller` does this and more,
 * but it is native code, and this is ~40 lines against an API RN already has.
 */

type EnsureVisible = (node: Measurable | null) => void;

/** The bit of a ref we actually use — TextInput and View both satisfy it. */
type Measurable = {
  measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void;
};

/**
 * Gap left between the field and the top of the keyboard.
 *
 * Not merely cosmetic: a field flush against the keyboard reads as clipped,
 * and on the session screen the thing directly under a numeric field is
 * usually its own hint text or the next field, which you want to see to know
 * where you are.
 */
const MARGIN = 24;

/**
 * Where to scroll so a field clears the keyboard, or null to leave it alone.
 *
 * Pulled out as a pure function because it is the only part of this file that
 * makes a decision, and the rest is RN plumbing that needs a device to mean
 * anything. `apps/mobile` has no component test runner (see the tests
 * alongside this), so extracting the arithmetic is the difference between
 * this logic being covered and being hoped about.
 */
export function scrollTargetFor(a: {
  /** Field's absolute Y on screen. */
  fieldY: number;
  fieldHeight: number;
  /** Absolute Y of the keyboard's top edge; null when it is down. */
  keyboardTop: number | null;
  /** The scroll view's current offset. */
  offset: number;
}): number | null {
  if (a.keyboardTop === null) return null;
  // A node mid-layout measures as zero height. Scrolling on that would jump
  // the list somewhere arbitrary, which is worse than not scrolling at all —
  // the field is still reachable by hand.
  if (a.fieldHeight <= 0) return null;
  const overlap = a.fieldY + a.fieldHeight + MARGIN - a.keyboardTop;
  // Already clear. Scrolling anyway would drag the list under someone's
  // thumb every time they moved between two visible fields.
  if (overlap <= 0) return null;
  return a.offset + overlap;
}

const Ctx = createContext<EnsureVisible>(() => {});

/**
 * Call with a focused input's ref to scroll it clear of the keyboard.
 *
 * A context rather than a prop, because the inputs are two components deep
 * (screen → SetRow → Field) and threading a callback through every row would
 * put keyboard plumbing in the signature of a component that only renders a
 * number.
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
    /** The field to keep visible, remembered across the two event orderings. */
    const focused = useRef<Measurable | null>(null);

    const scrollClear = useCallback((node: Measurable | null) => {
      const kbTop = keyboardTop.current;
      if (!node || kbTop === null) return;
      node.measureInWindow((_x, y, _w, h) => {
        const target = scrollTargetFor({
          fieldY: y,
          fieldHeight: h,
          keyboardTop: kbTop,
          offset: offset.current,
        });
        if (target === null) return;
        scrollRef.current?.scrollTo({ y: target, animated: true });
      });
    }, []);

    useEffect(() => {
      // `Will` rather than `Did`: the scroll then animates alongside the
      // keyboard instead of visibly correcting itself after it has arrived.
      const show = Keyboard.addListener('keyboardWillShow', (e) => {
        keyboardTop.current = e.endCoordinates.screenY;
        scrollClear(focused.current);
      });
      // `keyboardWillChangeFrame` covers the cases a show/hide pair misses:
      // switching between a number pad and a text keyboard of a different
      // height, and the floating/split keyboard on iPad.
      const change = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        keyboardTop.current = e.endCoordinates.screenY;
        scrollClear(focused.current);
      });
      const hide = Keyboard.addListener('keyboardWillHide', () => {
        keyboardTop.current = null;
        // The focused field is deliberately NOT cleared and the scroll
        // position is deliberately NOT restored: iOS returns the content via
        // the inset, and yanking the list back to where it was before would
        // move the row out from under someone who is still reading it.
      });
      return () => {
        show.remove();
        change.remove();
        hide.remove();
      };
    }, [scrollClear]);

    const ensureVisible = useCallback<EnsureVisible>(
      (node) => {
        focused.current = node;
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
          {...props}
          ref={(node) => {
            scrollRef.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          onScroll={handleScroll}
          // Needed for `offset` to track: without it RN sends scroll events
          // rarely enough that the stored offset is stale by the time a field
          // is focused, and the scroll lands in the wrong place.
          scrollEventThrottle={16}
        >
          {children}
        </ScrollView>
      </Ctx.Provider>
    );
  },
);

/** The margin, exported so tests can assert the arithmetic rather than restate it. */
export const KEYBOARD_MARGIN = MARGIN;
