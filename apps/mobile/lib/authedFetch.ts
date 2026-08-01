import { OfflineError } from './apiError';

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

/**
 * `fetch`, with a transport failure reported as what it is.
 *
 * React Native rejects an unreachable host with `TypeError: Network request
 * failed` — which screens rendered verbatim. Same class of problem as the
 * token message: technically accurate, useless to read, and indistinguishable
 * from a bug in the app.
 *
 * An aborted request is passed through untouched: a superseded search or an
 * unmounted screen is not a connectivity problem, and callers already
 * distinguish it by checking their own signal.
 */
export async function netFetch(input: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new OfflineError();
  }
}
