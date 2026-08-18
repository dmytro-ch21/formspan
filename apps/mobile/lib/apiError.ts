/**
 * API failures, and the one question every caller actually has about them:
 * is this worth trying again?
 *
 * This lives apart from any one domain module because the answer is identical
 * for sessions, activities, workouts and profiles — and because having two
 * copies of it has already produced two different answers (see the 401 note
 * below). Anything that classifies an HTTP failure belongs here, so there is
 * exactly one place to be wrong.
 */

/**
 * An API failure that kept the error *code* from the response envelope.
 *
 * Codes are part of the contract; messages explicitly are not. Callers need
 * the code to tell "you typed an impossible RPE" (keep the screen, show the
 * message) apart from "this session no longer exists" (re-read the server).
 *
 * Every module that talks to the API should throw this rather than a bare
 * `Error`. A plain Error forces callers to pattern-match on the message, which
 * is exactly what the API conventions forbid — and which silently breaks the
 * day someone rewords a string server-side.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * We could not reach VOLA — no token, or no route to the API.
 *
 * Deliberately NOT an `ApiError`: nothing was ever answered, so there is no
 * status and no code to classify. That distinction is the whole point. The
 * old code threw `new Error('Not signed in.')` when Clerk returned a null
 * token, which offline is simply untrue and is what drove an athlete to try
 * signing in again mid-workout.
 *
 * The message is written to be read on a phone in a gym: it says what
 * happened, says the session is intact, and says what to expect next.
 */
export class OfflineError extends Error {
  constructor() {
    super("Can't reach VOLA. You're still signed in — this'll load when the connection is back.");
    this.name = 'OfflineError';
  }
}

/** "I couldn't ask", as opposed to any answer the server gave. */
export function isOffline(err: unknown): boolean {
  return err instanceof OfflineError;
}

/**
 * 4xx statuses that are nonetheless worth retrying.
 *
 * - **401** because Clerk session tokens are short-lived and `getToken()`
 *   refreshes internally. A long outbox drain over a slow link can expire its
 *   token partway through; the next attempt gets a fresh one and succeeds.
 *   Treating it as permanent means one badly-timed token expiry marks real
 *   training data as dead — this was live, and is the bug this module exists
 *   to stop recurring.
 * - **408 / 429** are explicitly "try again" by definition.
 */
const RETRYABLE_4XX = new Set([401, 408, 429]);

/**
 * Would the server reject this the same way forever?
 *
 * Takes a status rather than an error so callers holding a raw `Response`
 * (the activity outbox does) share the boundary with callers holding an
 * `ApiError`, instead of reimplementing it and drifting.
 */
export function isPermanentStatus(status: number): boolean {
  if (RETRYABLE_4XX.has(status)) return false;
  return status >= 400 && status < 500;
}

/**
 * Whether a failed push will fail identically no matter how many times it is
 * retried.
 *
 * The offline store's whole premise is that a failed push is an ordinary
 * state, so most failures stay quiet and retry. That's true of a dead network
 * and of a 5xx, and it is not true of a 404 (deleted elsewhere), a 409 (the ID
 * belongs to someone else) or a validation error — those will fail identically
 * forever, so staying quiet about them means an athlete finishes a workout
 * that was never going to sync.
 *
 * Anything that isn't an `ApiError` never reached the server — no token yet,
 * no signal, request aborted — and stays silent.
 */
export function isPermanentRejection(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return isPermanentStatus(err.status);
}

/** The server understood the request and refused its contents. */
export function isValidationError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'invalid_input';
}

/**
 * The server refused a GRIP it does not recognise — the one rejection a phone
 * can repair by itself.
 *
 * Its own code rather than `invalid_input` because the difference is the whole
 * point. A build knows a FIXED list of grips; the server decides how many
 * exist, and the two numbers diverge the moment either ships. (Do not write
 * the current count here in present tense — it was "four" until N9 made it six,
 * and the same sentence went stale in six files at once.) Checking
 * a grip against the local list answers "do I recognise this?" while pretending
 * to answer "would the server take it?" — so the day the server grows one, an
 * older phone reads a legitimate `mixed`, nulls it, and the wholesale PUT
 * writes that null back over data the athlete recorded. Silently.
 *
 * So the client no longer guesses: it sends what it holds and lets the server
 * adjudicate its own vocabulary. When the answer is no, THIS is what makes the
 * refusal actionable — drop the grip, retry, keep the rest of the session.
 * Matching the message instead would work today and break the day somebody
 * rewords it, which is exactly what the API conventions forbid.
 */
export function isUnknownGrip(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'invalid_grip';
}

/**
 * Distinguishes "the server says this doesn't exist" from "I couldn't ask".
 *
 * Load screens need this and cannot infer it: both arrive as a rejected
 * promise, but one means *there is genuinely nothing here* and the other means
 * *I don't know*. Rendering the first when it's really the second is how an
 * established profile ends up presented as a blank first-run form.
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
