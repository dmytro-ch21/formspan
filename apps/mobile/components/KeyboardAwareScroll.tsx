import { useFocusEffect } from 'expo-router';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
 * **So on iOS the keyboard listeners deliberately do not scroll — UNLESS
 * nothing native is going to.** They only record where the keyboard is, and
 * scrolling from them as well would race the native adjustment:
 * `offset.current` lags behind (it updates from throttled `onScroll` events),
 * so a JS scroll computed after the native one has landed uses a stale offset
 * and drags the list back down — hiding the field again, intermittently,
 * depending which won. Two mechanisms doing one job is worse than either
 * alone.
 *
 * Android needs the opposite, because `automaticallyAdjustKeyboardInsets` is
 * `@platform ios`: nothing there lifts the field for us, so the show event
 * has to. **A screen with a `KeyboardAwareFooter` is, for this purpose, iOS
 * running with that prop off** — see `needsPlatformKeyboardInset` — so it
 * needs exactly the same JS-driven lift Android always has, on both
 * platforms. `nativeScrollsFocusedFieldClear` takes `hasLiftingFooter`
 * precisely so this file's own claim about "what iOS already does" stays
 * true instead of describing a mechanism that screen just switched off.
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
 * wrong in a different way in each direction: `true` when nothing lifts
 * natively means nothing ever lifts at all; `false` when something already
 * does means two mechanisms fight over one scroll position with a stale
 * offset between them.
 *
 * **`hasLiftingFooter` matters because it is what `automaticallyAdjustKeyboard-
 * Insets` is conditioned on** — see `needsPlatformKeyboardInset`. A screen with
 * a `KeyboardAwareFooter` runs with that prop OFF, on every platform, so the
 * native iOS mechanism this function otherwise defers to is not running
 * either. Ignoring that (as this used to) left iOS with NEITHER mechanism on
 * such a screen: the prop that scrolls the field is off, and this function
 * still claimed iOS "already does it" and told the JS listener to stand down.
 * The gap is invisible on a short screen with one field near the top (the
 * reflection wizard's note step) and real on a long one — a set row low in a
 * multi-exercise session is exactly the case `useEnsureVisible` exists for.
 */
export function nativeScrollsFocusedFieldClear(os: string, hasLiftingFooter = false): boolean {
  return os === 'ios' && !hasLiftingFooter;
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
 * Pure, because it is the only arithmetic worth pinning here — extracting it
 * is the difference between this being covered and being hoped about. (This
 * used to add "and `apps/mobile` has no component test runner", which stopped
 * being true: `screenHeader.test.tsx` and `keyboardFooterCoordination.test.tsx`
 * both render. Rendering still cannot produce a keyboard or a Yoga pass, so
 * the arithmetic is still better off out here.)
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
 *
 * `hasLiftingFooter` comes from each caller's own `FooterCtx` read rather than
 * from a context read in here, so this stays a plain hook a screen without a
 * `KeyboardAwareScreen` ancestor can still call — `FooterCtx` defaults to "no
 * footer" and every caller already reads it for `needsPlatformKeyboardInset`;
 * this is the second, footer-aware use of the exact same boolean.
 */
function useKeyboardAware(scrollToY: (y: number) => void, hasLiftingFooter: boolean) {
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
    // `hasLiftingFooter` matters here exactly as it does to
    // `needsPlatformKeyboardInset`: a `KeyboardAwareFooter` on screen runs
    // `automaticallyAdjustKeyboardInsets` OFF, so iOS is not natively lifting
    // anything either — this is what makes N184 a footer-aware read rather
    // than a bare `Platform.OS` check.
    const nativeHandlesIt = nativeScrollsFocusedFieldClear(Platform.OS, hasLiftingFooter);
    const track = (e: { endCoordinates: { screenY: number } }) => {
      keyboardTop.current = e.endCoordinates.screenY;
      // Deliberately does NOT scroll when something native already will: a
      // second scroll from here would race the native adjustment with a
      // stale offset. Where nothing native is running — Android always,
      // iOS with a lifting footer — the show event has to.
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
  }, [scrollClear, hasLiftingFooter]);

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
  scrollEventThrottle: 16,
} as const;

/**
 * Does this scroll view still need the platform's keyboard inset?
 *
 * **Only when nothing else has already shortened it.** `automaticallyAdjust‑
 * KeyboardInsets` is the fix for problem 2, but it is not the only thing that
 * can solve problem 2, and running it alongside something that already has is
 * where the fourth failure mode came from:
 *
 * A `KeyboardAwareFooter` sibling pads itself by the keyboard's height, and
 * because it is the last child of a `flex: 1` column that padding SHRINKS the
 * scroll view — whose bottom now sits above the keyboard, exactly as Android's
 * `resize` mode arranges by itself. At that point the honest inset is zero.
 *
 * But the native inset was computed one frame earlier, from the frame the
 * scroll view had BEFORE the footer grew, so it is the full pre-shrink overlap
 * and it stays. The scroll view ends up carrying a keyboard-height of inset it
 * no longer overlaps, which is legal scroll range with nothing in it: focusing
 * the note field scrolled the wizard's title off the top and parked ~200pt of
 * blank between the last line of content and the footer. Measured on an iPhone
 * 15 Pro: footer lift 328pt, surplus inset 246pt, void ~200pt.
 *
 * This is the same double-count the file already refuses on Android, where the
 * window resize does the shortening — see `keyboardInsetFor`. One compensation
 * per scroll view, whichever one is doing it.
 */
export function needsPlatformKeyboardInset(a: { hasLiftingFooter: boolean }): boolean {
  return !a.hasLiftingFooter;
}

/**
 * Whether a `KeyboardAwareFooter` shares this screen with the scroll view.
 *
 * A context because the two are SIBLINGS — the footer cannot be a descendant
 * of the scroll view (that is the whole reason it exists), so neither can
 * discover the other by nesting. `KeyboardAwareScreen` is the common parent
 * that lets them agree on who is compensating.
 *
 * Defaulting to "no footer" is the safe direction: a scroll view rendered
 * outside a `KeyboardAwareScreen` keeps the platform inset it has always had,
 * so the twelve screens with no footer are untouched by this.
 */
const FooterCtx = createContext<{ register: () => () => void; hasFooter: boolean }>({
  register: () => () => {},
  hasFooter: false,
});

/**
 * Wraps a screen whose scroll view and `KeyboardAwareFooter` are siblings.
 *
 * It exists because the alternative — asking the screen with a footer to also
 * remember `automaticallyAdjustKeyboardInsets={false}` — is precisely the
 * opt-in this file was written to end: correct, invisible when forgotten, and
 * forgotten by twelve screens out of thirteen last time.
 *
 * **Renders no view of its own.** Callers already have a root with their own
 * theming and `flex: 1`, and inserting a second box would either drop the
 * themed background or add a layout node between the column and its children —
 * and that column is load-bearing, since it is what lets the footer's padding
 * shrink the scroll view (see `KeyboardAwareFooter`).
 *
 * Counting registrations rather than storing a boolean so the footer can mount
 * and unmount (the wizard's is always rendered, but a screen that shows one
 * only on the last step is an obvious next call site) without stranding the
 * scroll view in the wrong mode.
 *
 * **A footer that mounts while the keyboard is already up needs checking on a
 * device first.** In `RCTScrollViewComponentView.mm`, `updateProps` only stores
 * `automaticallyAdjustKeyboardInsets` and `_keyboardWillChangeFrame:` returns
 * early when it is off — so flipping it true→false mid-keyboard leaves the
 * inset that is already applied in place, and the later hide notification is
 * ignored, stranding it past dismissal. The wizard is safe because its footer
 * mounts with the screen, keyboard down; a "footer on the last step" screen
 * reached by typing on the step before is exactly the case that is not, and
 * wants either a keyboard dismiss on step change or a device check. Nothing in
 * jest can see this — the prop is inert without native code.
 */
export function KeyboardAwareScreen({ children }: { children: React.ReactNode }) {
  const [footers, setFooters] = useState(0);
  const register = useCallback(() => {
    setFooters((n) => n + 1);
    return () => setFooters((n) => n - 1);
  }, []);
  const value = useMemo(() => ({ register, hasFooter: footers > 0 }), [register, footers]);

  return <FooterCtx.Provider value={value}>{children}</FooterCtx.Provider>;
}

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function KeyboardAwareScrollView({ children, onScroll, ...props }, forwardedRef) {
    const scrollRef = useRef<ScrollView>(null);
    const scrollToY = useCallback((y: number) => {
      scrollRef.current?.scrollTo({ y, animated: true });
    }, []);
    // Read before `useKeyboardAware` so the hook can decide whether iOS is
    // natively lifting the field — see that hook's own doc comment.
    const { hasFooter } = useContext(FooterCtx);
    const { ensureVisible, handleScroll, setContainer } = useKeyboardAware(scrollToY, hasFooter);

    return (
      <Ctx.Provider value={ensureVisible}>
        <ScrollView
          // Before the spread so a caller can override any of them; the
          // defaults are a floor, not a cage.
          {...scrollDefaults}
          automaticallyAdjustKeyboardInsets={needsPlatformKeyboardInset({
            hasLiftingFooter: hasFooter,
          })}
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
  // Read before `useKeyboardAware` — see the `KeyboardAwareScrollView` call
  // site for why.
  const { hasFooter } = useContext(FooterCtx);
  const { ensureVisible, handleScroll, setContainer } = useKeyboardAware(scrollToY, hasFooter);

  return (
    <Ctx.Provider value={ensureVisible}>
      <FlatList<ItemT>
        {...scrollDefaults}
        automaticallyAdjustKeyboardInsets={needsPlatformKeyboardInset({
          hasLiftingFooter: hasFooter,
        })}
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
 *
 * **The bottom-edge invariance this relies on is a property of the LAYOUT, not
 * of this component.** It holds when the footer is a content-sized last child
 * of a `flex: 1` column whose other child can shrink — which is the reflection
 * wizard, whose sibling is a ScrollView (`flexGrow: 1, flexShrink: 1` by
 * default). Drop this into a content-hugging parent with no slack to give and
 * the bottom edge moves when the padding does, at which point the measurement
 * feeds itself. Worth checking before the second call site.
 */
export function KeyboardAwareFooter({ style, children, ...props }: ViewProps) {
  const [inset, setInset] = useState(0);
  const ref = useRef<View>(null);

  /**
   * Tells the scroll view above to stand down.
   *
   * The padding below shrinks that scroll view clear of the keyboard, so the
   * platform inset it would otherwise apply is a second compensation for the
   * same overlap — see `needsPlatformKeyboardInset`. Registered from an effect
   * rather than during render because it sets state on an ancestor.
   */
  const { register } = useContext(FooterCtx);
  useEffect(() => register(), [register]);

  /**
   * Same reason the scrollers have one: `Keyboard` listeners are global, so a
   * screen that is merely covered rather than unmounted still hears every
   * event. Without this, pushing a screen with an input over the wizard makes
   * the buried footer measure and pad itself.
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

  useEffect(() => {
    const names = keyboardEventNames(Platform.OS);
    const measure = (keyboardTop: number | null) => {
      const node = ref.current;
      if (!node || !onTop.current) return;
      node.measureInWindow((_x, y, _w, h) => {
        // `y + h` — the footer's BOTTOM edge — is invariant under this
        // padding, which is what makes measuring here safe to repeat. The
        // footer is the last child of a flex column, so it is pinned to the
        // bottom: adding `paddingBottom` grows the box upward (h rises, y
        // falls by the same amount) and lifts the content, while the bottom
        // edge stays put. Feeding the previous inset back in would therefore
        // compound it on every keyboard frame change, walking the footer up
        // the screen a keyboard-height at a time.
        const lift = keyboardInsetFor({ keyboardTop, containerBottom: y + h });
        // `+ MARGIN` when lifting at all, because this padding REPLACES the
        // footer's own `paddingBottom` rather than adding to it — so the bare
        // overlap parks the buttons flush against the keyboard's top edge with
        // no air at all, which reads as clipped. Same 24pt the field-lifting
        // path leaves, so the two paths space alike.
        setInset(lift > 0 ? lift + MARGIN : 0);
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
