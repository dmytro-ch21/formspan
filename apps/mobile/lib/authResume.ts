import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * N190 / issue #607 — "the app signs the athlete out when the phone locks".
 *
 * **What locking the phone actually does to Clerk.** Verified against the
 * installed `@clerk/clerk-js`, `@clerk/clerk-expo` and `@clerk/shared`:
 * nothing anywhere in their React Native code path listens to `AppState` or
 * refreshes on foreground. The only foreground-refresh mechanism Clerk ships
 * (`refreshTokenOnFocus`, a 5s poller) lives in the web `AuthCookieService`,
 * which `clerk-expo` never instantiates on native
 * (`standardBrowser: !isNative()`). Clerk's own published guidance for this
 * exact symptom — "How to Handle Session Expiry in a React Native App with
 * Clerk" — recommends adding this yourself, under the name
 * `useForegroundRefresh`. So: background the app, and nothing refreshes
 * anything until something in OUR code calls Clerk again.
 *
 * **What `isSignedIn` actually is.** Per `resolveAuthState`
 * (`@clerk/shared/authorization`), `isSignedIn` is `false` only when Clerk's
 * client reports `sessionId === null && userId === null` — it does not read
 * the cached JWT's `exp` at all. So the 60-second default token expiring,
 * by itself, does not explain a false reading; something has to actively
 * tell Clerk's client there is no session. The credible path: our own
 * foreground sync (`lib/sync.ts`) calls `getToken()` on resume, which makes
 * Clerk refetch its client/session state from FAPI — and if the radio has
 * not reconnected yet (a phone waking from a pocket lock is exactly this),
 * that fetch can race a "no session" read before a subsequent successful one
 * corrects it. This is the same shape of bug `session.ts` was built to
 * prevent for the JWT (Clerk answers a network failure with a false-looking
 * "no", not a thrown error) — just one layer up, inside Clerk's own client
 * resource, which is not ours to defend from the inside.
 *
 * **What this hook does, and does NOT do**, so a genuine sign-out is never
 * weakened by the fix for the false one (see CLAUDE.md's own account of nine
 * modules once reading an offline blip as "not signed in"):
 *
 * 1. On a foreground transition, nudge Clerk with a real, cache-skipping
 *    `getToken()` call — the fix Clerk's own docs recommend, and the only
 *    thing in this whole chain that can make the client's next read correct
 *    sooner rather than later. Failures are swallowed: an offline resume is
 *    ordinary, not this hook's problem, and not evidence of anything.
 * 2. For a short window after THAT SAME transition, an `isSignedIn === false`
 *    reading is held rather than acted on, giving the race above a chance to
 *    resolve itself. Deliberately narrow: this is the ONLY case delayed.
 * 3. Every other `false` reading — a cold start already signed out, an
 *    explicit Settings sign-out, a remote revoke discovered while the app is
 *    already in the foreground — is confirmed on the very next render,
 *    exactly as `_layout.tsx` did before this hook existed. There is no
 *    general "wait and see"; only a resume gets one.
 */

/**
 * How long a `false` reading is held after a resume before it is believed.
 *
 * Not tuned against a device — there is no measurement to tune it against
 * yet, see the PR's `NEEDS HUMAN EVIDENCE` list. Chosen to comfortably cover
 * a network round-trip on a radio that just woke up (the forced refresh
 * above is usually much faster than this), while staying short enough that a
 * GENUINE sign-out discovered on resume is still, in practice, instant to an
 * athlete glancing at the screen.
 */
export const RESUME_GRACE_MS = 2500;

/** The subset of Clerk's `useAuth().getToken` this hook actually calls. */
type ClerkGetToken = (opts?: { skipCache?: boolean }) => Promise<string | null>;

/**
 * Whether `_layout.tsx`'s redirect guard should treat `isSignedIn === false`
 * as a confirmed sign-out right now. See the module doc above for the full
 * reasoning; this is the wiring.
 *
 * `getToken` is Clerk's raw, unstable-per-render getter (see
 * `useAuthToken.ts`'s own doc comment: `@clerk/clerk-expo` rebuilds it every
 * render, unlike `@clerk/react`'s `useCallback`-wrapped one). The same
 * latest-ref trick is used here for the same reason: without it, the
 * `AppState` subscription below would tear down and re-register on every
 * render, and each re-registration recaptures `previous` from
 * `AppState.currentState` — silently losing whatever transition history it
 * was tracking.
 */
export function useResumeSignOutGuard(
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
  getToken: ClerkGetToken,
): boolean {
  const [confirmed, setConfirmed] = useState(false);

  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  const refreshOnResume = useCallback(
    () => getTokenRef.current({ skipCache: true }),
    [],
  );

  // `null` until the first resume; read by the confirm effect below to
  // decide whether the CURRENT `false` reading falls inside a resume window.
  // A ref, not state: written from an AppState callback outside React's
  // render cycle, same reasoning as every module-level ref in `session.ts`.
  const resumedAt = useRef<number | null>(null);

  useEffect(() => {
    // Captured once per subscription, exactly as `startSyncOrchestrator` in
    // `lib/sync.ts` does it — compared, never regex-matched.
    // `AppState.currentState` is documented as possibly `null` at startup
    // (and is not guaranteed to be a string under jest), so a `.match` on it
    // throws; that mistake is Clerk's own sample code for this exact pattern,
    // and this file exists partly to not repeat it.
    let previous: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasAway = previous === 'background' || previous === 'inactive';
      const returned = wasAway && next === 'active';
      previous = next;
      if (!returned) return;
      resumedAt.current = Date.now();
      void refreshOnResume().catch(() => {
        // Offline right after waking up is ordinary — see the module doc.
      });
    });
    return () => sub.remove();
  }, [refreshOnResume]);

  useEffect(() => {
    // No setState here on the `isSignedIn === true` path — deliberately.
    // `confirmed` can only ever be stale-`true` while `isSignedIn` is
    // true (see the masked return below), so there is nothing to
    // synchronise; a bare mirror-a-prop-into-state call here is exactly
    // what `react-hooks/set-state-in-effect` exists to catch.
    if (!isLoaded || isSignedIn) return;
    const elapsed = resumedAt.current === null ? Infinity : Date.now() - resumedAt.current;
    if (elapsed >= RESUME_GRACE_MS) {
      // No recent resume, or the window already lapsed — nothing to hold.
      setConfirmed(true);
      return;
    }
    // A fresh grace period. Explicitly un-confirm first: `confirmed` can
    // be stale `true` here if this is a SECOND false-episode following a
    // sign-in in between (the mask below hid that staleness while
    // `isSignedIn` was true) — without this line the athlete would read
    // as confirmed-signed-out for the whole window instead of held.
    setConfirmed(false);
    // A self-rescheduling timer, not a one-shot — found in review. iOS
    // suspends JS timers while backgrounded, so: resume, this timer arms,
    // the athlete re-locks before it fires (suspending it), a LATER resume
    // updates `resumedAt.current` — but `isSignedIn` never changed in
    // between, so THIS effect never re-runs to arm a fresh window; the
    // suspended timer is the only thing that will ever fire again. A
    // one-shot version that only re-checked `resumedAt.current` (an earlier
    // draft) would correctly decline to confirm at that point, but then
    // confirm nothing EVER — the athlete would be stuck unconfirmed
    // indefinitely with no further resume to re-trigger it. Rescheduling
    // against whatever `resumedAt.current` says right now is what keeps a
    // moved goalpost from becoming a stuck one: every time this fires early
    // for the CURRENT window, it re-arms for the remaining time on that
    // window instead of doing nothing.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) return;
        const stillElapsed =
          resumedAt.current === null ? Infinity : Date.now() - resumedAt.current;
        if (stillElapsed >= RESUME_GRACE_MS) {
          setConfirmed(true);
        } else {
          check(RESUME_GRACE_MS - stillElapsed);
        }
      }, delay);
    };
    check(RESUME_GRACE_MS - elapsed);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isLoaded, isSignedIn]);

  // `isSignedIn` always wins over a stale `confirmed` — see the comment on
  // the effect above for why re-entering "false" is what actually resets it.
  return isLoaded && !isSignedIn && confirmed;
}
