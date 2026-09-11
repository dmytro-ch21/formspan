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

// Required at module scope, NOT inside the hook below. Importing RNTL
// registers its own cleanup hooks, and doing that from inside a running test
// throws "Hooks cannot be defined inside tests" — which failed every
// pure-logic suite in the project, not just the component ones.
const { act } = require('@testing-library/react-native');

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
 * Let each screen's trailing async work settle inside `act`.
 *
 * The screens load cache-first and then refresh from the network, so a test
 * that asserts on the cached paint finishes while the refresh is still in
 * flight — and its `setState` lands after the test body, producing "an update
 * was not wrapped in act(...)".
 *
 * Flushed rather than silenced. The warning is noise here, but suppressing it
 * would also swallow the next one, which might not be.
 */
afterEach(async () => {
  await act(async () => {});
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
    Easing: { bezier: (...points) => ({ factory: () => (t) => t, points }) },
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
  };
});
