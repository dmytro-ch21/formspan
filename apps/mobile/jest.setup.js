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

/* eslint-disable @typescript-eslint/no-require-imports */

// Required at module scope, NOT inside the hook below. Importing RNTL
// registers its own cleanup hooks, and doing that from inside a running test
// throws "Hooks cannot be defined inside tests" — which failed every
// pure-logic suite in the project, not just the component ones.
const { act } = require('@testing-library/react-native');

// Everything a mock factory needs is `require`d INSIDE it. Jest hoists
// `jest.mock` above the imports, so a module-scope binding referenced in a
// factory is not initialised yet — and jest rejects it outright rather than
// letting it fail at runtime. Only names prefixed `mock` are exempt.
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

jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => async () => 'tok' }));

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
