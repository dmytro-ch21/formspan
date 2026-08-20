import {
  OfflineError,
  RequestDroppedError,
  TimeoutError,
} from './apiError';

/**
 * Getting a token, and reaching the network, without lying about either.
 *
 * Every module that talks to the API used to open with:
 *
 *     const token = await getToken();
 *     if (!token) throw new Error('Not signed in.');
 *
 * in nine places. **That message is false, and it is the one an athlete
 * actually met.** Clerk's `getToken()` returns `null` when it cannot reach
 * Clerk — verified in the installed clerk-js, which logs "Network request
 * failed while offline, returning null" and returns null rather than throwing
 * (its `rethrowOfflineNetworkErrors` option is off by default). Session tokens
 * are short-lived, so on a gym wifi dead-spot every screen in the app
 * simultaneously announced "Not signed in." to someone who was signed in and
 * had never been signed out.
 *
 * The user's report was exactly this: *"When offline I would see a lot of sign
 * in? why I'm on my phone signed in why should i again?"*
 *
 * So: a null token inside the signed-in app means **we could not authenticate
 * this request**, never **you are signed out**. The signed-out case is already
 * handled one level up, by the guard in `app/_layout.tsx` — if a screen is
 * rendering at all, there is a session.
 *
 * Token acquisition itself lives in `session.ts`, which is the only module
 * that talks to Clerk. This file is now just the transport half.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';

/**
 * Exported so `apiRequest` and the reachability probe cannot drift apart —
 * the probe has to ask the host the failed request was aimed at, or it answers
 * a different question from the one being asked.
 */
export const API_BASE = `${API_URL}/v1`;

/**
 * How long a request may run before we stop waiting.
 *
 * Under this ceiling **nothing in the app had a deadline at all** except two
 * screens that wrote their own. A request therefore ran to whatever the OS
 * allowed (~60s on iOS) and then failed with a message about signal.
 *
 * 30s rather than something snappier because the point is to own the
 * classification, not to hurry the athlete: it sits under the OS budget so the
 * timeout is *ours* and can be named, and above anything that legitimately
 * succeeds on gym wifi. A screen that wants to give up sooner passes its own.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The budget for a photo upload plus the model round trip behind it.
 *
 * The estimate and identify routes hold the connection open while a provider
 * looks at the image, and the backend puts no ceiling of its own on that call.
 * 45s keeps them inside a deadline we can name while leaving the slow-but-fine
 * case alone — a plate of food over gym wifi is the request most likely to be
 * legitimately slow, and cutting it off would be a new bug wearing the fix's
 * clothes.
 */
export const UPLOAD_TIMEOUT_MS = 45_000;

/** Long enough for a healthy API on a bad link, short enough to be invisible. */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * How long a probe answer stands for.
 *
 * The outbox drains row by row, so an outage would otherwise probe once per
 * pending row. Two seconds collapses a drain into roughly one probe while
 * staying far too short to answer a *later* failure with a stale verdict.
 */
const PROBE_TTL_MS = 2_000;

export interface NetFetchOptions {
  /** Override the deadline. `UPLOAD_TIMEOUT_MS` for anything carrying a photo. */
  timeoutMs?: number;
}

let probeInFlight: Promise<boolean> | null = null;
let probeAnswer: { at: number; reachable: boolean } | null = null;

/**
 * Forget what we know about reachability.
 *
 * Exists for tests — the cache is module state and two cases in one file would
 * otherwise share an answer. Harmless in production; nothing calls it there.
 */
export function resetReachabilityCache(): void {
  probeInFlight = null;
  probeAnswer = null;
}

/**
 * Is there a route to VOLA right now?
 *
 * **This is the whole discriminator, and it is a measurement rather than a
 * guess.** React Native gives JS almost nothing to classify a failed request
 * by (see `netFetch` below), so instead of inferring a cause from an error
 * object, the phone asks a question it can get a real answer to: it sends one
 * bodyless, unauthenticated GET to `/v1/healthz` and sees whether anything
 * comes back.
 *
 * **Any response at all counts, including a 500.** The question is whether
 * packets reach VOLA and answers come back, not whether VOLA is healthy — a
 * 500 proves the route exists, which is precisely what the failed request's
 * classification turns on.
 *
 * Never throws, and never goes through `netFetch`: a probe that could itself
 * be classified would recurse.
 *
 * ### What it cannot tell you, stated plainly
 *
 * - A captive portal that answers everything with its own 200 reads as
 *   reachable. The athlete then gets "That didn't get through" instead of
 *   "Can't reach VOLA" — wrong in detail, right in advice, and neither of them
 *   tells them to sign in again.
 * - It cannot separate "this phone has no radio" from "VOLA is down" — both
 *   are *no route to the API*, which is the thing `OfflineError` now claims
 *   and the most the app can honestly say. Separating them would mean probing
 *   a third-party host from an athlete's phone, which is not a trade this
 *   project makes for a wording nuance.
 */
async function apiReachable(): Promise<boolean> {
  const cached = probeAnswer;
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.reachable;
  if (probeInFlight) return probeInFlight;

  const run = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(`${API_BASE}/healthz`, { method: 'GET', signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })().then(
    (reachable) => {
      probeAnswer = { at: Date.now(), reachable };
      probeInFlight = null;
      return reachable;
    },
    () => {
      // `run` catches everything above, so this only fires if the runtime
      // itself misbehaves. Treating that as unreachable is the conservative
      // reading, and not caching it means the next failure asks again.
      probeInFlight = null;
      return false;
    },
  );

  probeInFlight = run;
  return run;
}

/** The caller's own cancellation, or a deadline we imposed — both land here. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * The one cause React Native does hand us, and the only string this file
 * matches on.
 *
 * Measured against the installed runtime rather than assumed. iOS's
 * `RCTNetworking.mm` sends `[requestID, error.localizedDescription,
 * error.code == kCFURLErrorTimedOut]`; React Native's `XMLHttpRequest` turns
 * that third field into a `timeout` event, and `whatwg-fetch@3.6.20` turns
 * *that* into `TypeError('Network request timed out')` — driving RN's real
 * `XMLHttpRequest` with the native payload produces exactly those events.
 *
 * The `name` check is for a future runtime that throws a spec `TimeoutError`
 * instead. If both miss, nothing breaks: the failure falls through to the
 * probe and gets classified by measurement, which is the stronger path anyway.
 */
function isRuntimeTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.message === 'Network request timed out';
}

/**
 * `fetch`, with a transport failure reported as what it is.
 *
 * ## What React Native can and cannot tell us (measured, 2026-08-20)
 *
 * This is the constraint the whole design is shaped around, so it is written
 * down rather than left to be rediscovered.
 *
 * `fetch` here is `whatwg-fetch@3.6.20` over RN's `XMLHttpRequest`. On the
 * native side iOS sends JS the failure as `error.localizedDescription` — the
 * string that actually distinguishes *"The Internet connection appears to be
 * offline."* from *"An SSL error has occurred…"*. **JS never sees it.**
 * `whatwg-fetch` sets `responseType = 'blob'` (RN has Blob, so its feature
 * check passes), and RN's `XMLHttpRequest` keeps the error string only when
 * the response type is `''` or `'text'`; on a blob request `responseText`
 * throws rather than returning it, and `fetch` hands back no xhr to read it
 * from. Measured both ways against the installed modules: with `'text'` the
 * string is right there, with `'blob'` it is gone.
 *
 * The only other route to it is `XMLHttpRequest.__setInterceptor_DO_NOT_USE`,
 * a single global slot the dev network inspector already claims — its name is
 * the API's own opinion of that idea.
 *
 * So through `fetch`, three outcomes survive: **abort**, **timeout** (iOS
 * only, and only for `kCFURLErrorTimedOut`), and **everything else** as one
 * undifferentiated `TypeError('Network request failed')`. Offline, DNS
 * failure, TLS failure and a connection dropped mid-upload are the same
 * object. **No classifier reading that error can tell them apart, and one
 * that appears to is reading its own test fixtures.**
 *
 * Hence the shape below: cases the app can *establish* rather than infer.
 *
 * 1. The caller cancelled — it says so, and it is not a failure.
 * 2. Our deadline fired — we set it, so we know.
 * 3. The runtime said "timed out" — the one cause it does report.
 * 4. Anything else: ask VOLA whether it is reachable, and classify on the
 *    answer. Reachable means this request failed on its own merits
 *    (`RequestDroppedError`); unreachable means what `OfflineError` says.
 *
 * **`OfflineError` is now the case with evidence behind it, not the fallback**
 * — that inversion is the fix. Note what is deliberately absent: no separate
 * TLS or DNS sentinel. Both make every request to the host fail, so the probe
 * fails too and they arrive as "no route to the API", which is true and is all
 * the app can honestly say. Inventing `TlsError` from a message string would
 * pass its tests and mislead on a phone.
 *
 * ## Deadlines
 *
 * The deadline is composed with the caller's signal rather than replacing it:
 * a screen keeps superseding and unmounting its own requests, and a superseded
 * search is still not a connectivity problem. If both fire, the caller wins —
 * a request the screen abandoned should not surface as a timeout the athlete
 * reads.
 *
 * **Nothing here reads `signal.reason`, and nothing may.** RN replaces the
 * global `AbortController` with `abort-controller@3.0.0`, which has no
 * `reason`, no `throwIfAborted`, no `AbortSignal.timeout` and no
 * `AbortSignal.any` — measured. Jest runs on Node, which has all four, so code
 * depending on them passes every test and does nothing on a phone. The
 * deadline is tracked in a plain local instead, and `rnGlobals.test.ts` keeps
 * the trap from coming back.
 */
export async function netFetch(
  input: string,
  init: RequestInit = {},
  opts: NetFetchOptions = {},
): Promise<Response> {
  const caller = init.signal ?? null;
  const controller = new AbortController();
  // A local, not `controller.abort(reason)` — see the note above.
  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const relay = () => controller.abort();

  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', relay);
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // Order matters: our deadline aborts, so it arrives as an `AbortError`
    // too, and the caller's cancellation has to be answered before either.
    if (caller?.aborted) throw err;
    if (deadlineFired) throw new TimeoutError();
    if (isAbortError(err)) throw err;
    if (isRuntimeTimeout(err)) throw new TimeoutError();
    throw (await apiReachable()) ? new RequestDroppedError() : new OfflineError();
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', relay);
  }
}
