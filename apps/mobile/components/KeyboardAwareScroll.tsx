import { useFocusEffect } from 'expo-router';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  ScrollView,
  View,
  type FlatListProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type ViewProps,
} from 'react-native';

/**
 * Everything this app knows about the keyboard, in one file.
 *
 * There are THREE distinct ways a keyboard ruins a screen, they have different
 * fixes, and conflating them is how this kept getting half-solved:
 *
 *  1. **The focused field is hidden.** iOS mostly handles this; Android never
 *     does. See `scrollTargetFor` and the note below.
 *  2. **Content below the fold is unreachable** — the list can't scroll far
 *     enough, so the last rows sit behind the keyboard permanently. This is the
 *     one that gets reported as "the keyboard covers the techniques and you
 *     can't see them all", and neither the field-lifting above nor a bigger
 *     `paddingBottom` fixes it. `automaticallyAdjustKeyboardInsets` does.
 *  3. **A fixed footer is buried.** A footer is a SIBLING of the scroll view,
 *     so no content inset can reach it — it has to move. See
 *     `KeyboardAwareFooter`.
 *
 * **The components here bake in the fix for all three, so a screen gets it by
 * existing rather than by remembering.** That is the point: this file was
 * correct and adopted by exactly one screen out of thirteen, while the other
 * twelve each reinvented some fraction of it — four with
 * `automaticallyAdjustKeyboardInsets`, three with nothing but
 * `keyboardShouldPersistTaps`, five FlatLists with no handling at all, and
 * `sign-in` with no scroll container whatsoever. Centralising the knowledge
 * did not help, because using it was still opt-in.
 *
 * ---
 *
 * ## On lifting the focused field (problem 1)
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
 * report, and the only case `useEnsureVisible` exists to handle.
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
 *
 * ## On unreachable content (problem 2)
 *
 * `automaticallyAdjustKeyboardInsets` is the whole fix, and it is iOS-only —
 * but Android needs no equivalent, which is why nothing here compensates for
 * it. Android's default `softwareKeyboardLayoutMode` is `resize`: the WINDOW
 * shrinks, so the scroll view is already short and every row is reachable by
 * scrolling. Adding a JS bottom inset there would double-count and leave a
 * keyboard-sized hole under the list.
 *
 * That asymmetry is why `keyboardInsetFor` takes a measured `containerBottom`
 * rather than a keyboard height: on iOS the container runs under the keyboard
 * and the overlap is real, on Android it stops above it and the overlap is
 * zero. One formula, no `Platform` branch, correct on both — and it degrades
 * sensibly for a case neither of us predicted (a split keyboard, a floating
 * window, a large-screen Android in `pan` mode).
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
 * Which dismiss mode this platform actually honours.
 *
 * **`'interactive'` is iOS-only, and Android fails it SILENTLY** — it is not a
 * type error and it does not warn, the keyboard simply never dismisses on
 * drag. Same class of trap as the `keyboardWillShow` names above: the feature
 * reads as present in the source and does nothing on the device.
 *
 * `'on-drag'` is the honest Android equivalent — less fluid, actually works.
 */
export function dismissModeFor(os: string): 'interactive' | 'on-drag' {
  return os === 'ios' ? 'interactive' : 'on-drag';
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

/**
 * How far a fixed element must move to sit clear of the keyboard.
 *
 * For problem 3 — a footer, an action bar, anything that is a SIBLING of the
 * scroll view rather than inside it. Content insets cannot reach those, so the
 * element itself is translated.
 *
 * Deliberately NOT the keyboard's height. On Android `resize` the window has
 * already shrunk and the footer has already moved with it, so the honest
 * answer there is zero — and `containerBottom - keyboardTop` yields zero on
 * its own, with no `Platform` branch. Reading `endCoordinates.height` instead
 * would push the footer a second keyboard-height up the screen on Android,
 * which is the kind of bug that only shows up on the platform nobody is
 * testing on.
 */
export function keyboardInsetFor(a: {
  /** Absolute Y of the keyboard's top edge; null when it is down. */
  keyboardTop: number | null;
  /** Absolute Y of the bottom of the element being kept clear. */
  containerBottom: number;
}): number {
  if (a.keyboardTop === null) return 0;
  return Math.max(0, a.containerBottom - a.keyboardTop);
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

/**
 * The tracking shared by the scroll view and the list.
 *
 * Extracted so the two wrappers cannot drift: a FlatList that listened for the
 * wrong events, or forgot the `onTop` guard, would be broken in a way that
 * only reproduces on one of thirteen screens.
 *
 * `scrollToY` is the one difference between the containers — `scrollTo` on a
 * ScrollView, `scrollToOffset` on a FlatList.
 */
function useKeyboardAware(scrollToY: (y: number) => void) {
  /** Current scroll offset — the scroll APIs are absolute, there is no scrollBy. */
  const offset = useRef(0);
  /** Absolute Y of the top of the keyboard; null when it is down. */
  const keyboardTop = useRef<number | null>(null);
  /** The field to keep visible. */
  const focused = useRef<Measurable | null>(null);
  /** The scrollable itself, measured for `containerBottom`. */
  const container = useRef<Measurable | null>(null);

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

  const scrollClear = useCallback(
    (node: Measurable | null) => {
      const kbTop = keyboardTop.current;
      const frame = container.current;
      if (!node || kbTop === null || !frame || !onTop.current) return;
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
          scrollToY(target);
        });
      });
    },
    [scrollToY],
  );

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

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.y;
  }, []);

  /**
   * Records the scrollable's node for measurement.
   *
   * `ScrollView`/`FlatList` types do not declare `measureInWindow` — it is a
   * native method on the underlying view — so this is checked rather than
   * cast. A blind cast would turn a future RN change into a crash on the one
   * screen that must never crash mid-workout.
   */
  const setContainer = useCallback((node: object | null) => {
    const m = node as Partial<Measurable> | null;
    container.current = m && typeof m.measureInWindow === 'function' ? (m as Measurable) : null;
  }, []);

  return { ensureVisible, handleScroll, setContainer };
}

/**
 * The keyboard props every scrollable in this app should carry.
 *
 * `keyboardShouldPersistTaps` is here rather than left to callers because
 * without it the first tap on a search result only dismisses the keyboard —
 * so search-then-open, the main use of every list in this app, takes two taps.
 * Four screens had worked that out independently; five had not.
 */
const scrollDefaults = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: dismissModeFor(Platform.OS),
  /**
   * The fix for problem 2, and the reason these wrappers exist at all.
   * iOS-only by design — see the note at the top for why Android needs
   * nothing here.
   */
  automaticallyAdjustKeyboardInsets: true,
  scrollEventThrottle: 16,
} as const;

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function KeyboardAwareScrollView({ children, onScroll, ...props }, forwardedRef) {
    const scrollRef = useRef<ScrollView>(null);
    const scrollToY = useCallback((y: number) => {
      scrollRef.current?.scrollTo({ y, animated: true });
    }, []);
    const { ensureVisible, handleScroll, setContainer } = useKeyboardAware(scrollToY);

    return (
      <Ctx.Provider value={ensureVisible}>
        <ScrollView
          // Before the spread so a caller can override any of them; the
          // defaults are a floor, not a cage.
          {...scrollDefaults}
          {...props}
          ref={(node) => {
            scrollRef.current = node;
            setContainer(node);
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          onScroll={(e) => {
            handleScroll(e);
            onScroll?.(e);
          }}
        >
          {children}
        </ScrollView>
      </Ctx.Provider>
    );
  },
);

/**
 * A `FlatList` that handles the keyboard, for the screens a ScrollView cannot
 * serve.
 *
 * Five screens search a list of things while typing — the technique library,
 * the exercise picker, saved workouts, pinned records, the workout editor —
 * and every one of them is virtualised because the catalogs run to ~1000 rows.
 * They cannot simply use `KeyboardAwareScrollView`: nesting a FlatList in a
 * ScrollView defeats virtualisation and RN warns about it.
 *
 * So this is the same mechanism attached to the other container. It is a
 * plain function rather than a `forwardRef` because `forwardRef` erases the
 * generic — `FlatList<Technique>` would degrade to `FlatList<unknown>` and
 * every `renderItem` would lose its type.
 *
 * **It deliberately does not forward a ref.** The version that did tripped
 * `react-hooks/immutability` (an error in eslint-config-expo, and a fair
 * one — assigning to a `ref` prop's `.current` inside the ref callback is
 * mutating a prop), and no caller wanted one: all five lists here are
 * scrolled by the user, not by the screen. Add it deliberately when something
 * genuinely needs to drive the scroll position, rather than speculatively.
 */
export function KeyboardAwareFlatList<ItemT>({ onScroll, ...props }: FlatListProps<ItemT>) {
  const innerRef = useRef<FlatList<ItemT>>(null);
  const scrollToY = useCallback((y: number) => {
    innerRef.current?.scrollToOffset({ offset: y, animated: true });
  }, []);
  const { ensureVisible, handleScroll, setContainer } = useKeyboardAware(scrollToY);

  return (
    <Ctx.Provider value={ensureVisible}>
      <FlatList<ItemT>
        {...scrollDefaults}
        {...props}
        ref={(node) => {
          innerRef.current = node;
          setContainer(node);
        }}
        onScroll={(e) => {
          handleScroll(e);
          onScroll?.(e);
        }}
      />
    </Ctx.Provider>
  );
}

/**
 * A footer that stays above the keyboard.
 *
 * Problem 3. The reflection wizard's Next button is a sibling of its
 * ScrollView, so the content inset that rescues the list does nothing for it:
 * on iOS the keyboard simply covers the only control that advances the
 * wizard, while typing into the note field on the last step.
 *
 * Padding rather than `transform`, so the footer's own background still
 * reaches the bottom of the screen — a translated footer leaves a strip of
 * whatever is behind it visible under the keyboard as it animates.
 *
 * On Android this measures to zero and renders unchanged; see
 * `keyboardInsetFor`.
 */
export function KeyboardAwareFooter({ style, children, ...props }: ViewProps) {
  const [inset, setInset] = useState(0);
  const ref = useRef<View>(null);

  useEffect(() => {
    const names = keyboardEventNames(Platform.OS);
    const measure = (keyboardTop: number | null) => {
      const node = ref.current;
      if (!node) return;
      node.measureInWindow((_x, y, _w, h) => {
        // `y + h` — the footer's BOTTOM edge — is invariant under this
        // padding, which is what makes measuring here safe to repeat. The
        // footer is the last child of a flex column, so it is pinned to the
        // bottom: adding `paddingBottom` grows the box upward (h rises, y
        // falls by the same amount) and lifts the content, while the bottom
        // edge stays put. Feeding the previous inset back in would therefore
        // compound it on every keyboard frame change, walking the footer up
        // the screen a keyboard-height at a time.
        setInset(keyboardInsetFor({ keyboardTop, containerBottom: y + h }));
      });
    };
    const subs = [
      Keyboard.addListener(names.show, (e) => measure(e.endCoordinates.screenY)),
      Keyboard.addListener(names.hide, () => setInset(0)),
    ];
    if (names.changeFrame) {
      subs.push(Keyboard.addListener(names.changeFrame, (e) => measure(e.endCoordinates.screenY)));
    }
    return () => subs.forEach((s) => s.remove());
  }, []);

  return (
    <View ref={ref} style={[style, inset > 0 && { paddingBottom: inset }]} {...props}>
      {children}
    </View>
  );
}

/** The margin, exported so a caller can reason about the spacing it gets. */
export const KEYBOARD_MARGIN = MARGIN;
