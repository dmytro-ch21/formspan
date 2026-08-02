import { renderHook } from '@testing-library/react-native';

import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The hook's identity stability, asserted rather than assumed.
 *
 * `useAuthToken` exists for exactly one reason: `@clerk/clerk-expo`'s
 * `getToken` is a bare arrow rebuilt every render, so any effect depending on
 * it re-runs forever. Its own doc comment lists the three bugs that caused —
 * an infinite refetch loop, local state wiped a frame after being typed, and
 * debounces that never flushed.
 *
 * Nothing tested that guarantee. The shared component-test mock in
 * `jest.setup.js` used to hand back a fresh function per call, which
 * reproduced the loop inside the harness and made a correct screen look
 * broken. Aligning the mock with the real contract fixed that — and left a
 * gap, because now a screen test passes whether or not the real hook is
 * stable. This is the test that closes it: if the `useCallback(…, [])` in
 * `lib/useAuthToken.ts` were dropped, only this file would notice.
 *
 * `@clerk/clerk-expo` is unmocked here on purpose — the point is the real
 * hook's behaviour against a Clerk that rebuilds its getter, which is what the
 * setup mock already simulates.
 */
test('returns the same getter across renders', () => {
  const { result, rerender } = renderHook(() => useAuthToken());
  const first = result.current;

  rerender({});
  rerender({});

  expect(result.current).toBe(first);
});
