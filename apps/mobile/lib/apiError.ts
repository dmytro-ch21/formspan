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
