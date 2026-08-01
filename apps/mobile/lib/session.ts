import * as SecureStore from 'expo-secure-store';

import { OfflineError } from './apiError';

/**
 * The one place that asks Clerk for anything.
 *
 * **Why this exists.** Every module used to call Clerk's `getToken()` directly
 * — 12 direct call sites plus 18 through `useAuthToken` — once per API
 * request. Clerk's default session token lives about a minute, so the app had
 * a hard dependency on Clerk's servers being reachable *roughly every 60
 * seconds*, for work that is otherwise entirely local. Step into a dead spot
 * in a gym and, one minute later, every screen fails at once.
 *
 * Worse, it failed dishonestly. Clerk returns `null` rather than throwing when
 * it cannot be reached — verified in the installed clerk-js, which logs
 * "Network request failed while offline, returning null" — and each of those
 * call sites read the null as `throw new Error('Not signed in.')`. An athlete
 * mid-workout was told, on every screen, to sign in to an account he had
 * never been signed out of.
 *
 * **What this changes.**
 *
 * 1. *One* caller of Clerk. Everything else asks this module.
 * 2. The token is cached against its own `exp`, so a burst of screens mounting
 *    together costs zero extra Clerk calls, and no call at all is made while a
 *    valid token is in hand.
 * 3. Concurrent misses collapse into a single refresh (`inflight`), instead of
 *    five screens each starting one.
 * 4. **A token that is still valid keeps being used when Clerk is
 *    unreachable.** This is the actual offline fix: being unable to *refresh*
 *    is not being unable to *authenticate*.
 * 5. The last token is persisted, so a cold start in a dead spot can still
 *    talk to our API until that token genuinely expires — rather than the app
 *    being useless from launch.
 * 6. When there is genuinely no usable token and Clerk cannot be asked, the
 *    result is `OfflineError`, never a claim about being signed out. Signed-out
 *    is decided one level up, by the guard in `app/_layout.tsx`.
 *
 * **What this does NOT fix**, and shouldn't be mistaken for: reads still go to
 * the network. The token being valid does not make `GET /v1/sessions` work in
 * a basement. Serving reads from the local store is the offline-first work
 * tracked separately; this change is what stops *authentication* from being
 * the thing that breaks first.
 *
 * **The cheapest further win is configuration, not code.** `CLERK_JWT_TEMPLATE`
 * below asks Clerk for a template token instead of the default session token,
 * and a template's lifetime is set in the Clerk dashboard. The backend
 * verifies signature, issuer, expiry and `sub` only — no `azp`, no audience
 * (see `internal/platform/auth/auth.go`) — so a longer-lived template token
 * needs no server change, and multiplies the offline grace window by whatever
 * lifetime is chosen. Unset, everything here still works on the 60s default.
 */

/** Name of a Clerk JWT template, if one is configured. */
const TEMPLATE = process.env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE || undefined;

/**
 * Refresh this long before expiry.
 *
 * Not tuning for its own sake: a token that expires *during* a request is a
 * 401, and the outbox treats 401 as retryable precisely because that used to
 * happen mid-drain. Renewing early costs nothing — the old token is still
 * valid — and removes the race.
 */
const REFRESH_SKEW_MS = 20_000;

/**
 * Assumed lifetime when a token's `exp` can't be read.
 *
 * Deliberately shorter than Clerk's own default, so an undecodable token makes
 * us refresh *more* often rather than trust a token past its death.
 */
const ASSUMED_TTL_MS = 30_000;

const STORE_KEY = 'vola.session.token';

type Cached = { token: string; exp: number };

let cached: Cached | null = null;
let inflight: Promise<Cached> | null = null;
/** Set once we've tried the keychain, so a cold start reads it exactly once. */
let restored = false;

/**
 * Seconds-since-epoch `exp` from a JWT, in milliseconds — or null.
 *
 * Read from the token we already hold rather than asked of Clerk: the whole
 * point is to not make a network call to find out whether we need one.
 */
function expiryOf(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64, then pad. `atob` exists on Hermes; if a runtime
    // lacks it we fall back to the assumed TTL rather than crashing on a
    // hot path.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(globalThis.atob(padded)) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The cached token if it is still good, else null.
 *
 * Reads the module variable *inside* a function on purpose: as a type guard
 * over `cached` directly, TypeScript's control-flow analysis narrows it to
 * `never` after the early return above — it cannot see that the async refresh
 * reassigns it. This shape is also just clearer at the call sites.
 */
function usableToken(skewMs: number): string | null {
  const c = cached;
  return c !== null && c.exp - skewMs > Date.now() ? c.token : null;
}

async function restore(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const stored = await SecureStore.getItemAsync(STORE_KEY);
    if (!stored) return;
    const exp = expiryOf(stored);
    // An expired stored token is worse than none: it would be sent, rejected
    // with a 401, and read as an auth problem rather than a stale cache.
    if (exp && exp > Date.now()) cached = { token: stored, exp };
  } catch {
    // An unreadable keychain is not fatal — we just refresh from Clerk.
  }
}

async function persist(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORE_KEY, token);
  } catch {
    // Non-fatal: the token still works for this launch, it just won't survive
    // a cold start offline.
  }
}

/**
 * A token for an authenticated request.
 *
 * `clerkGetToken` is Clerk's own getter, passed in rather than imported, so
 * this module stays a plain function — callable from the outbox and other
 * non-React code, which is where sync actually runs.
 *
 * Throws `OfflineError` when there is no usable token AND Clerk can't be
 * asked. Never claims the user is signed out.
 */
export async function getSessionToken(
  clerkGetToken: (opts?: { template?: string }) => Promise<string | null>,
): Promise<string> {
  await restore();

  // The common case, and the one worth making free: a token we already hold,
  // comfortably inside its life.
  const fresh = usableToken(REFRESH_SKEW_MS);
  if (fresh) return fresh;

  // A refresh is already running — join it rather than starting a second.
  if (inflight) {
    try {
      return (await inflight).token;
    } catch {
      // Fall through: that attempt failed, but our own cache may still carry
      // a token that is expiring-soon yet not yet expired.
      const stillValid = usableToken(0);
      if (stillValid) return stillValid;
      throw new OfflineError();
    }
  }

  inflight = (async (): Promise<Cached> => {
    const token = await clerkGetToken(TEMPLATE ? { template: TEMPLATE } : undefined);
    if (!token) throw new OfflineError();
    const next = { token, exp: expiryOf(token) ?? Date.now() + ASSUMED_TTL_MS };
    cached = next;
    await persist(token);
    return next;
  })();

  try {
    return (await inflight).token;
  } catch {
    // Clerk is unreachable. If what we hold has not actually expired yet, it
    // is still a perfectly valid credential — being unable to renew is not
    // being unable to authenticate. This is the branch that keeps a workout
    // usable in a dead spot.
    const stillValid = usableToken(0);
    if (stillValid) return stillValid;
    throw new OfflineError();
  } finally {
    inflight = null;
  }
}

/**
 * Drop everything on sign-out.
 *
 * Without this the next account on a shared device inherits the previous
 * athlete's token from the keychain — the same class of leak the modules
 * provider was caught with.
 */
export async function clearSessionToken(): Promise<void> {
  cached = null;
  inflight = null;
  restored = true;
  try {
    await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Best effort; the token expires on its own regardless.
  }
}
