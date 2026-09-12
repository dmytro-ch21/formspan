/**
 * Shared setup for component tests.
 *
 * Only the things every screen needs to exist at all — navigation, auth,
 * native modules. Anything a specific test is actually asserting about
 * (the store, the API) is mocked per-file, so a test can never be satisfied
 * by a default defined somewhere else. That distinction matters: this
 * session already produced two tests that passed because a fixture supplied
 * the behaviour under test.
 */

/*
  F47 (#1057) — RNTL's automatic cleanup is switched off, and done below instead,
  INSIDE `act`.

  RNTL 14 registers `afterEach(async () => { await flushMicroTasks(); await
  cleanup(); })` the moment it is required. `flushMicroTasks` yields one real
  `setImmediate`, outside any `act`, and only then unmounts. So any timer that
  is DUE when a test body returns fires in that yield against a screen that is
  still mounted, and prints "An update to X inside a test was not wrapped in
  act(...)", whatever the test itself did. Measured causes, in a loop of full
  runs: `VirtualizedList`'s batched cell update, a `setTimeout` its
  `componentDidUpdate` re-arms every render (`workoutsScreen`,
  `sessionHistoryScreen`, `libraryRunTypes`, `socialScreen`), and
  `app/library.tsx`'s 250ms search debounce (`libraryBjjEntries`,
  `libraryControlsBoundary`) — six files in ten runs, never the same set
  twice. None of those is a chain a test can await, and all of them are
  cleared by unmount.

  Measured against three controls, not argued. Each is a throwaway test, run
  3 times under RNTL's own cleanup and 3 times under this one:

  1. A component arms a 5ms timer and the test returns after it is due.
     RNTL's cleanup: warned 3 of 3. This one: 0 of 3.
  2. A bare, SYNCHRONOUS state update outside `act` in the test body. Warned
     3 of 3 in BOTH arms, with `IS_REACT_ACT_ENVIRONMENT` true in every test.
     So act warnings are not switched off: a real unwrapped update still
     prints exactly as before.
  3. N505's shape (#878): a press whose handler sets state before its first
     `await`, a `waitFor` that returns on that, and the rest of the async
     chain left unawaited with its next step DUE when the body returns.
     RNTL's cleanup: warned (one hop 1 of 3, two hops 3 of 3). This one:
     0 of 3 for both.

  Control 3 is the cost, and it is stated here so nobody reads a zero census
  as more than it is. This teardown ALSO absorbs an unawaited async chain
  whose next step lands in the teardown yield: it runs inside `act` and
  prints nothing. So a census of 0 cannot prove a test awaited its chain;
  awaiting the chain's terminal effect is still the fix, and the census no
  longer enforces it. (A tail not yet due at teardown, a 50ms hop, printed
  nothing in EITHER arm: it lands after unmount, where React does not warn.)
  The pending work still RUNS, inside `act`; nothing is swallowed.

  Set before the require below, because RNTL reads it at require time.
*/
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

// Required at module scope, NOT inside the hook below. Importing RNTL
// registers its own cleanup hooks, and doing that from inside a running test
// throws "Hooks cannot be defined inside tests" — which failed every
// pure-logic suite in the project, not just the component ones.
const rntl = require('@testing-library/react-native');
const { act, cleanup } = rntl;
// F56 (#1135): whether a test rendered anything for the teardown to unmount.
const { hasRenderedTree } = require('./lib/__tests__/support/renderedTree');

/*
  Captured before any test can install fake timers. RNTL's own teardown yields
  on a REAL `setImmediate` for the same reason: a faked one would never fire,
  and the hook would time out instead of cleaning up.
*/
const realSetImmediate = globalThis.setImmediate;

// Everything a mock factory needs is `require`d INSIDE it. Jest hoists
// `jest.mock` above the imports, so a module-scope binding referenced in a
// factory is not initialised yet — and jest rejects it outright rather than
// letting it fail at runtime. Only names prefixed `mock` are exempt.
/*
  `expo-audio` cannot be loaded under jest at all.

  Its JS reads the native module's prototype at import time, and jest-expo does
  not stub this one — so the failure is "Cannot read properties of undefined
  (reading 'prototype')" at line 1 of `lib/sounds.ts`, and it takes down the
  whole SUITE rather than a test. That reaches any screen importing the
  celebration card, which is how a change about confetti broke the BJJ screen's
  tests.

  Here rather than per-file for the reason the header gives: it is a native
  module every screen needs to merely exist, not behaviour anything asserts.
  `lib/__tests__/sounds.test.ts` overrides this with its own richer mock, which
  is where the sound behaviour is actually pinned.
*/
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => ({
    play: () => {},
    pause: () => {},
    seekTo: () => Promise.resolve(),
    remove: () => {},
    volume: 1,
  }),
  setAudioModeAsync: () => Promise.resolve(),
}));

/*
  `expo-image` 57.0.2 broke under jest at import time, same class of failure
  as `expo-audio` above: its module scope wires an `expo-observe` integration,
  and `requireOptionalNativeModule('ExpoObserve')` — null on a device without
  the module, which is the guarded path — returns jest-expo's truthy stub
  here, so `observe.getIntegrations()` throws before any test runs and takes
  down every suite that renders an image.

  Mocked as a pass-through to React Native's Image rather than stubbing the
  observe internals: the app imports only `{ Image }` (verified — no
  `prefetch`, no `useImage`, no `ImageBackground`), no test asserts on
  expo-image behaviour, and a props-preserving component keeps testID/source
  queries working in the suites that render one.
*/
jest.mock('expo-image', () => {
  const React = require('react');
  const { Image } = require('react-native');
  return { Image: (props) => React.createElement(Image, props) };
});

/*
  `expo-haptics` is mocked for something happening two levels below it, and
  **only `expo-dev-client` makes it necessary** — which is measured, not
  assumed: on the commit before the dev client was added these three suites
  (`holdToConfirm`, `bjjSessionScreen`, `workoutDetailScreen`) pass with no
  haptics mock at all, and installing `expo-dev-client` alone turns them red.

  The chain: `expo-haptics` imports from `'expo'`, whose `Expo.fx` requires
  `async-require/messageSocket` at module scope — but only behind
  `__DEV__ && typeof globalThis.expo !== 'undefined'`. The dev client is what
  defines that global under jest, so the guard starts passing and the module
  then reads `NativeSourceCode.getConstants().scriptURL` (`null` here) and
  calls `.match` on it. Whole SUITE down, before any test runs.

  **Note it is NOT every `expo-*` package** — only those importing from
  `'expo'` (the SDK-57 `requireOptionalNativeModule` pattern).
  `expo-linear-gradient`, used unmocked by several screens under test, imports
  only react and react-native and never reaches `Expo.fx`. The symptom is the
  reliable tell, not the package prefix: a suite going red at `Test suite
  failed to run` with `reading 'match'` is this, and needs the same treatment.

  **Mocked here rather than at the module actually at fault**, because that
  does not work: jest-expo resolves `expo/src/async-require/messageSocket`
  through its `native` platform variant, so a `jest.mock` on that path
  registers under a different id and never intercepts (tried; suites stayed
  red). Patching `scriptURL` is worse than useless — a well-formed URL
  satisfies the guard and the module then opens a real WebSocket from the test
  run.

  Nothing asserts on haptics: no test file mentions it. The two references in
  `lib/__tests__/countdown.test.ts` are comments, over a pure module that does
  not import this one. Plain arrows rather than `jest.fn()` so no future test
  can quietly assert against this shared default — it would have to re-mock
  per-file, which is the rule this file's header sets.
*/
jest.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

/*
  `react-native-maps` cannot be loaded under jest at all.

  Its JS reads a native module (`RNMapsAirModule`) via
  `TurboModuleRegistry.getEnforcing` at import time, which throws outside a
  real native binary — jest-expo does not stub this one, same class of
  failure as `expo-audio` above, and it takes down the whole SUITE rather
  than a test. `SessionCelebration` started importing it for N461's running
  route thumbnail, which is how a change about a run's map broke the BJJ
  screen's render test.

  Mocked as inert `View` stand-ins rather than a real map: no test in this
  suite asserts on map rendering — the thumbnail's actual logic
  (`regionForRoute`, `downsampleRoute`) is pure and covered directly in
  `lib/__tests__/celebration.test.ts`, per this app's logic-first testing
  rule — and a props-preserving stand-in keeps any future testID query
  working.
*/
jest.mock('react-native-maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapView = (props) => React.createElement(View, props, props.children);
  return {
    __esModule: true,
    default: MapView,
    Polyline: (props) => React.createElement(View, props),
    Marker: (props) => React.createElement(View, props),
    PROVIDER_DEFAULT: 'default',
    PROVIDER_GOOGLE: 'google',
  };
});

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    // Keyed on the callback, NOT on `[]`. The real `useFocusEffect` re-runs
    // when its callback identity changes, and screens rely on that: the
    // workouts list wraps `load` in a `useCallback` keyed on `scope`, so
    // switching tabs is what triggers the refetch. Pinned to `[]` the mock
    // renders a screen that can never reload, and any test of a state change
    // fails for a reason that exists only in the mock.
    useFocusEffect: (cb) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Link: ({ children }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: () => ({ userId: 'u1', isLoaded: true, isSignedIn: true, getToken: async () => 'tok' }),
}));

// ONE getter, created once — not a fresh arrow per call.
//
// The real hook goes to deliberate lengths to be identity-stable (see the
// comment in lib/useAuthToken.ts: an unstable getToken turns any effect that
// depends on it into an infinite refetch loop, which was three live bugs). A
// mock that hands back a new function every render breaks that guarantee and
// reproduces exactly those loops — a screen under test re-enters its loading
// state forever, and the failure reads as a bug in the screen.
const mockTokenGetter = async () => 'tok';
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'generated-uuid' }));

// Every screen renders ScreenHeader, which reads `useSafeAreaInsets()`. That
// throws outside a provider rather than returning zeros, so without this a
// component test fails on the header before reaching anything it asserts.
// The library ships this mock for the purpose.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const inset = { top: 47, bottom: 34, left: 0, right: 0 };
  return {
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
    initialWindowMetrics: { insets: inset, frame: { x: 0, y: 0, width: 390, height: 844 } },
  };
});

/**
 * Tear each test down inside `act`: settle, then unmount (F47, #1057).
 *
 * The screens load cache-first and then refresh from the network, and several
 * hold timers (a list's cell batch, a search debounce). A test that asserts on
 * the cached paint can finish with that work still due, and its `setState`
 * lands after the body.
 *
 * **This hook used to be `await act(async () => {})` on its own, and it could
 * not do its job.** jest-circus runs a block's `afterEach` hooks in the order
 * they were declared, and RNTL's automatic cleanup was declared first, the
 * moment this file required it. So the "settle" ran against a tree RNTL had
 * already unmounted, after RNTL's own yield had let the due work land outside
 * `act`. Doing both steps here, in one `act`, is what the old comment described.
 *
 * One yield, then cleanup: the same two steps RNTL performs, in the same order.
 * Anything not due by then is cleared by the unmount.
 *
 * Flushed rather than silenced. The warning is noise here, but suppressing it
 * would also swallow the next one, which might not be.
 *
 * **A test that rendered nothing skips `act` and the yield (F56, #1135), but
 * still runs `cleanup()`.** It has no React work to settle. Skipping the
 * macrotask boundary is the point, because that boundary is how this hook
 * used to fail.
 *
 * Measured on a host at load ~340: a worker descheduled for 15s while inside
 * this hook fails with "Exceeded timeout of 15000 ms for a hook", in whatever
 * test happens to be running. The yield, `cleanup()` and `act`'s own tail each
 * take milliseconds. Across the full suite the unconditional hook's slowest
 * teardown was 260ms; with this change, the ~1,450 tests that still take the
 * full path peaked at 283ms and 282ms in two full-suite runs. The failure is
 * not slow work. It is jest's timeout
 * timer expiring while the process is not running, then firing first at the
 * next timers phase. A hook that finishes in microtasks never reaches a timers
 * phase, so a stall of any length cannot fail it.
 *
 * `cleanup()` stays on the short path because "nothing rendered" is not
 * "nothing to clean up". RNTL's `waitFor` registers its poll in the same queue
 * `cleanup()` drains, whether or not anything was rendered
 * (`dist/wait-for.js`). A first version returned before `cleanup()`, and that
 * poll kept firing into the next test: `renderedTree.test.tsx`'s "sees no
 * further polls" went red on it, 10 polls where 1 was expected. Draining it
 * stays microtask-only, because the callback `waitFor` queues is synchronous
 * and `cleanup()` only awaits each one.
 *
 * Rendered tests still take the full teardown above. They stay exposed to a
 * worker frozen for 15s; this fixes the tests that render nothing, not the
 * freeze. `hasRenderedTree`'s own comment says why the check is "screen.root
 * throws RNTL's not-rendered error" and never truthiness.
 *
 * `rntl.screen`, read at call time, and never a `screen` destructured at the
 * top of this file. RNTL 14 REASSIGNS its `screen` export: `render` sets
 * `exports.screen = renderResult` and `cleanup` puts back a placeholder
 * (`dist/screen.js`). A destructured binding captures that placeholder once
 * and never sees a render, so every test looks unrendered, `cleanup()` never
 * runs, and trees leak into the next test. The first draft of this hook did
 * exactly that; `renderedTree.test.tsx`'s "is false again in the next test"
 * went red on it.
 */
afterEach(async () => {
  if (!hasRenderedTree(rntl.screen)) {
    await cleanup();
    return;
  }
  await act(async () => {
    await new Promise((resolve) => realSetImmediate(resolve));
    await cleanup();
  });
});

/*
  What RNTL's automatic setup would also have done, and does not now that it
  is switched off: declare this a React act environment for the whole file,
  and put back whatever was there before. Without it React stops emitting act
  warnings entirely, which would read as the census going to zero.
*/
let previousActEnvironment;
beforeAll(() => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

// Measured, not assumed: extra flush rounds here do NOT help. Work that a
// screen kicks off and that resolves DURING the test body has to be awaited
// by the test itself — see the catalog wait in workoutDetailScreen.test.tsx.
// This hook only covers what is still pending when the body ends.

/*
  F38/#1037 — Reanimated, mocked.

  `components/ui/Button.tsx` is the app's shared control, and F38 gave it a
  Reanimated CSS transition for press feedback. That made every component test
  that renders a Button — which is most of them — import Reanimated, whose
  entry point reaches for the native worklets module and dies in jest with
  `Cannot read properties of undefined (reading 'loadUnpackers')`. It takes
  the whole SUITE down, not a test, so the failure reads as unrelated screens
  breaking.

  Declared here rather than per-file because the trigger is a shared
  primitive: any component test that renders a button needs it, and "remember
  to mock Reanimated" is a rule each new test file would re-forget.

  The mock is deliberately MINIMAL, and stays that way: a broad stub would let
  a real API mistake pass here and fail on device, which is the trade this
  repo's testing rules refuse.

  **F46/#1045 grew it, exactly as the note above asked.** The second import
  site is `components/today/MacroRings.tsx`, which moved the ring sweep off
  the JS thread onto `useSharedValue` + `useAnimatedProps`. Each addition
  below does the REAL thing rather than returning a placeholder, for the same
  reason: `interpolate` computes the actual piecewise-linear value, and
  `useAnimatedProps` actually calls the worklet, so `macroRings*.test.tsx` can
  assert the dash offsets the rings are drawn with and a mistake in that
  arithmetic fails here rather than on a device nobody is holding.

  What is deliberately NOT simulated is TIME. `withTiming` and `withDelay`
  resolve to their final value immediately — there is no frame clock in jest,
  and pretending otherwise would be an apparatus that cannot fail. So a test
  here sees the sweep's DESTINATION, never a frame partway along it; the
  620ms, the 380ms delay and the curve are device-evidence criteria on #1045,
  not assertions.
*/
jest.mock('react-native-reanimated', () => {
  // NOT `react-native-reanimated/mock`. The shipped mock re-imports the real
  // package, so it dies exactly where the real one does — measured, not
  // assumed: same `loadUnpackers` throw, same stack through
  // `react-native-worklets`. A factory that never touches the package is the
  // only thing that works.
  const React = require('react');
  const { View } = require('react-native');

  /*
    F55/#1134: every write to every shared value, in order — the value as it was
    ASSIGNED, before the mock's same-value short-circuit. Exposed as
    `__sharedValueWrites` so a test can show that reversing the timer's swap
    assigns a new animation to the SAME value with no start value written in
    between, which is the whole of what makes a reversal continue rather than
    restart. Without it the only thing a test could see is where each animation
    comes to rest, which is identical for the flash and the fix.
  */
  const sharedValueWrites = [];

  /** A layout-animation builder that remembers every call made on it. See N558 below. */
  const layoutBuilder = (name, config) => {
    const chain = { name, config };
    for (const key of ['duration', 'delay', 'easing', 'reduceMotion', 'withInitialValues', 'withCallback']) {
      chain[key] = (value) => layoutBuilder(name, { ...config, [key]: value });
    }
    return chain;
  };

  /*
    Real piecewise-linear interpolation, not a stub. Mirrors Reanimated's own
    default extrapolation (EXTEND) by clamping to the first and last segment's
    slope, which is also what core `Animated`'s `interpolate` did before F46 —
    so a test comparing the two reads the same numbers.
  */
  const interpolate = (value, input, output) => {
    if (value <= input[0]) return output[0];
    const last = input.length - 1;
    if (value >= input[last]) return output[last];
    for (let i = 1; i <= last; i += 1) {
      if (value <= input[i]) {
        const span = input[i] - input[i - 1];
        if (span === 0) return output[i];
        return output[i - 1] + ((value - input[i - 1]) / span) * (output[i] - output[i - 1]);
      }
    }
    return output[last];
  };

  return {
    __esModule: true,
    // `Animated.createAnimatedComponent(Pressable)` must return something
    // renderable that still forwards props — the tests below press it.
    // `animatedProps` is spread onto the wrapped component the way Reanimated
    // applies it natively, so an SVG arc renders with the offset its worklet
    // computed instead of silently dropping it.
    default: {
      createAnimatedComponent: (Component) => {
        const Wrapped = React.forwardRef(({ animatedProps, ...rest }, ref) =>
          React.createElement(Component, { ...rest, ...animatedProps, ref }),
        );
        Wrapped.displayName = `Animated(${Component.displayName || Component.name || 'Component'})`;
        return Wrapped;
      },
      View,
    },
    cubicBezier: (...points) => `cubic-bezier(${points.join(', ')})`,
    // The curve is carried as data rather than evaluated: nothing in jest
    // advances a clock, so no test can observe its shape, and returning a
    // describable object keeps a wrong call site visible.
    Easing: {
      bezier: (...points) => ({ factory: () => (t) => t, points }),
      // Identity, which is also what the real `Easing.linear` is.
      linear: (t) => t,
    },
    interpolate,
    // No frame clock in jest — see the note above. Both resolve to the value
    // the animation would come to rest at.
    withTiming: (toValue) => toValue,
    withDelay: (_delay, animation) => animation,
    /*
      Backed by a ref for the value and a counter for the re-render.

      **The re-render is the one place this mock is deliberately UNLIKE the
      real library, and it is what makes the rings observable at all.** A real
      shared value is written on the UI runtime and pushed straight at the
      native view — React never re-renders, which is the entire point of
      moving off `Animated.Value`. In jest there is no native view and no
      frame clock, so a write that did not re-render would leave every arc
      rendered with the value it had BEFORE the effect ran: measured, and it
      is how this mock was first written — every ring came back at full
      `strokeDashoffset`, i.e. unswept, and a test asserting that would have
      been green while watching nothing.

      Re-rendering on write means a test sees the value the sweep comes to
      REST at. It still cannot see a frame partway along it; see the note
      above on time.
    */
    useSharedValue: (initial) => {
      const [, bump] = React.useState(0);
      const ref = React.useRef(null);
      if (ref.current === null) {
        const box = { current: initial };
        const write = (next) => {
          const value = typeof next === 'function' ? next(box.current) : next;
          sharedValueWrites.push({ target: ref.current, value });
          if (Object.is(value, box.current)) return;
          box.current = value;
          bump((n) => n + 1);
        };
        ref.current = {
          get: () => box.current,
          set: write,
          get value() {
            return box.current;
          },
          set value(next) {
            write(next);
          },
        };
      }
      return ref.current;
    },
    // Calls the worklet for real, so an error in it surfaces here. Re-running
    // on every render is what makes a value written in an effect visible to
    // the next render, which is as close to the real thing as a mock without
    // a frame clock can get.
    useAnimatedProps: (worklet) => worklet(),

    /*
      N558/#1047 grew it a third time, for `components/Timer.tsx`: the rest
      timer's drain (`useAnimatedStyle` + `withSequence`) and its four layout
      animations. Same rules as above — real where a test can observe it, and
      no invented clock.

      `withSequence` resolves to its LAST animation's destination, which is
      what a sequence comes to rest at. `withTiming` is left exactly as it was
      (returns its destination) so a test can `jest.spyOn` it and read the
      config each drain was armed with — the duration, the curve and the
      `reduceMotion` — which is the observable half of an animation jest cannot
      run.

      The layout-animation builders are RECORDERS, not no-ops: each chained
      call returns a new builder carrying what it was told, so a test can read
      `entering.config.reduceMotion` off the rendered view. A no-op builder
      would let a missing `.reduceMotion(ReduceMotion.System)` pass silently —
      the one property of these builders that is a rule rather than taste.

      `LayoutAnimationConfig` renders a plain View CARRYING its skip flags. It
      first rendered its children bare, which threw the flags away — and review
      measured the cost: deleting `skipEntering skipExiting` from `Timer.tsx`
      left every test green. Same no-op-builder trap, one component over.
    */
    useAnimatedStyle: (worklet) => worklet(),
    __sharedValueWrites: sharedValueWrites,
    withSequence: (...animations) => animations[animations.length - 1],
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    LayoutAnimationConfig: ({ children, skipEntering, skipExiting }) =>
      React.createElement(
        View,
        { testID: 'layout-animation-config', skipEntering, skipExiting },
        children,
      ),
    FadeInDown: layoutBuilder('FadeInDown', {}),
    FadeOutUp: layoutBuilder('FadeOutUp', {}),
    FadeOut: layoutBuilder('FadeOut', {}),
    // F55/#1134: the timer's arrival is opacity-only now.
    FadeIn: layoutBuilder('FadeIn', {}),
    // A constructor returning an object is how `new Keyframe(frames)` keeps the
    // same recording chain as the preset builders.
    Keyframe: function Keyframe(frames) {
      return layoutBuilder('Keyframe', { frames });
    },
  };
});
