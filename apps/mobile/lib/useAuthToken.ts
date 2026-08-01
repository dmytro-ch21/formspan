import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useEffect, useRef } from 'react';

import { getSessionToken } from './session';

/**
 * A token getter whose identity never changes.
 *
 * `@clerk/clerk-expo`'s `useAuth().getToken` is rebuilt on every render — it's
 * a bare arrow function, where `@clerk/react`'s equivalent is wrapped in
 * `useCallback`. So on mobile, and *only* on mobile, any `useCallback` or
 * `useEffect` listing `getToken` as a dependency is new on every render. The
 * damage that does isn't subtle:
 *
 *   - a `useEffect`/`useFocusEffect` fetch becomes an infinite refetch loop,
 *     because loading sets state, which re-renders, which rebuilds the
 *     callback, which re-runs the effect;
 *   - each of those reloads overwrites local state — so a set you're typing
 *     or an exercise you just reordered is wiped a frame later;
 *   - cleanup functions run on *every render* instead of on unmount, which
 *     silently defeats any debounce that flushes on unmount.
 *
 * All three were live bugs: reordering a workout's exercises did nothing
 * visible, and "+ Set" incremented the volume summary without the set ever
 * appearing.
 *
 * The fix is the standard latest-ref: hold the current getter in a ref and
 * hand out one stable wrapper. Every screen that fetches should use this
 * rather than destructuring `getToken` out of `useAuth`.
 *
 * **It now goes through `lib/session.ts` rather than straight to Clerk**, so a
 * screen asking for a token usually costs no Clerk call at all, and a
 * still-valid token keeps working when Clerk is unreachable. Returns a token
 * or throws `OfflineError` — never null, so no caller can mistake "couldn't
 * ask" for "signed out". See `session.ts` for why that distinction is the
 * whole point.
 */
export function useAuthToken(): TokenGetter {
  const { getToken, userId } = useAuth();
  const ref = useRef(getToken);
  // The account this getter is for. Held in a ref so the returned callback
  // stays identity-stable (the whole reason this hook exists) while still
  // seeing the current user.
  const userRef = useRef(userId);

  // Updated in an effect rather than during render — the ref is only ever
  // read from callbacks, never while rendering, so it's never stale by the
  // time it matters.
  useEffect(() => {
    ref.current = getToken;
    userRef.current = userId;
  }, [getToken, userId]);

  return useCallback(
    () => getSessionToken((opts) => ref.current(opts), userRef.current ?? null),
    [],
  );
}

/**
 * A getter that always yields a usable token or throws.
 *
 * `Promise<string>`, not `Promise<string | null>`: the null case is what
 * produced nine copies of `throw new Error('Not signed in.')`, and typing it
 * away means no new call site can reintroduce that reading.
 */
export type TokenGetter = () => Promise<string>;
