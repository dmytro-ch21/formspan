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

type Cached = { token: string; exp: number; sub: string | null };

let cached: Cached | null = null;
let inflight: Promise<Cached> | null = null;

/**
 * Memoised keychain read, so a cold start reads it exactly once.
 *
 * A promise rather than a boolean latch: a boolean answers "has someone
 * started", but callers need "has it finished". With the latch, the three
 * components the Home screen mounts together all skipped the *unfinished*
 * restore and each started a Clerk refresh — one wasted call online, and
 * offline every caller but the first threw `OfflineError` while a perfectly
 * good token was milliseconds from being read.
 */
let restorePromise: Promise<void> | null = null;

/**
 * Bumped whenever the session is torn down.
 *
 * A refresh that started before sign-out can settle after it and write the old
 * athlete's token straight back into the cache and keychain. Comparing the
 * epoch captured at the start of a refresh against the current one makes that
 * write a no-op instead.
 */
let epoch = 0;

/**
 * `sub` and `exp` from a JWT, read locally.
 *
 * Read from the token we already hold rather than asked of Clerk: the whole
 * point is to not make a network call to find out whether we need one.
 *
 * **`sub` is read for safety, not convenience.** A cache keyed only on expiry
 * belongs to no one, and this one is persisted — so on a shared device the
 * next athlete's requests would carry the previous athlete's credential until
 * it expired. Nothing about a keychain read tells you whose token it is
 * except the token itself. This is NOT a verification (no signature check
 * here — that is the API's job); it is an identity *match*, which is all that
 * is needed to refuse a token belonging to someone else.
 */
function claimsOf(jwt: string): { sub: string | null; exp: number | null } {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { sub: null, exp: null };
  try {
    // base64url → base64, then pad. `atob` exists on Hermes; if a runtime
    // lacks it we fall back to the assumed TTL rather than crashing on a
    // hot path.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(globalThis.atob(padded)) as { sub?: string; exp?: number };
    return {
      sub: typeof json.sub === 'string' ? json.sub : null,
      exp: typeof json.exp === 'number' ? json.exp * 1000 : null,
    };
  } catch {
    return { sub: null, exp: null };
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
function usableToken(skewMs: number, forUser: string | null): string | null {
  const c = cached;
  if (c === null) return null;
  // Someone else's token is not a usable token, however fresh it is.
  if (forUser && c.sub && c.sub !== forUser) return null;
  return c.exp - skewMs > Date.now() ? c.token : null;
}

function restore(forUser: string | null): Promise<void> {
  restorePromise ??= (async () => {
    const started = epoch;
    try {
      const stored = await SecureStore.getItemAsync(STORE_KEY);
      if (!stored) return;
      const { sub, exp } = claimsOf(stored);
      // Torn down while we were reading — do not resurrect it.
      if (started !== epoch) return;
      // Someone else's token, left on a shared device. Drop it rather than
      // letting the next athlete authenticate as the previous one.
      if (forUser && sub && sub !== forUser) {
        await SecureStore.deleteItemAsync(STORE_KEY).catch(() => {});
        return;
      }
      // An expired stored token is worse than none: it would be sent, rejected
      // with a 401, and read as an auth problem rather than a stale cache.
      if (exp && exp > Date.now()) cached = { token: stored, exp, sub };
    } catch {
      // An unreadable keychain is not fatal — we just refresh from Clerk.
    }
  })();
  return restorePromise;
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
  forUser: string | null,
): Promise<string> {
  // Captured BEFORE the first await, not next to the refresh that uses it.
  // `restore()` yields, so a sign-out landing during it would otherwise be
  // invisible: the epoch read afterwards would already be the post-clear
  // value, the guard would compare equal, and the departed athlete's token
  // would be written straight back. A test caught exactly that.
  const started = epoch;

  await restore(forUser);

  // The common case, and the one worth making free: a token we already hold,
  // comfortably inside its life — and belonging to the athlete asking.
  const fresh = usableToken(REFRESH_SKEW_MS, forUser);
  if (fresh) return fresh;

  // A refresh is already running — join it rather than starting a second.
  if (inflight) {
    try {
      return (await inflight).token;
    } catch {
      // Fall through: that attempt failed, but our own cache may still carry
      // a token that is expiring-soon yet not yet expired.
      const stillValid = usableToken(0, forUser);
      if (stillValid) return stillValid;
      throw new OfflineError();
    }
  }

  inflight = (async (): Promise<Cached> => {
    const token = await clerkGetToken(TEMPLATE ? { template: TEMPLATE } : undefined);
    if (!token) throw new OfflineError();
    const { sub, exp } = claimsOf(token);
    const next = { token, exp: exp ?? Date.now() + ASSUMED_TTL_MS, sub };
    // Signed out while this was in flight. Publishing it now would put the
    // departed athlete's credential back into memory AND the keychain, right
    // after it was deliberately cleared — the exact resurrection the epoch
    // exists to prevent. Return it to this caller and store nothing.
    if (started !== epoch) return next;
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
    const stillValid = usableToken(0, forUser);
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
  // Bump FIRST. Anything already in flight now fails its epoch check and
  // publishes nothing, so a refresh that started a moment ago cannot write the
  // old token back after this returns.
  epoch++;
  cached = null;
  inflight = null;
  // A resolved promise, not null: a later caller must not re-read the keychain
  // we are about to empty and resurrect what we just cleared.
  restorePromise = Promise.resolve();
  try {
    await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Best effort; the token expires on its own regardless.
  }
}
