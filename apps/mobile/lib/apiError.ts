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
 * The request produced no answer at all — the base of the transport family.
 *
 * Deliberately NOT an `ApiError`: nothing was answered, so there is no status
 * and no code to classify. That distinction is the whole point.
 *
 * **Why it is a family rather than one class (N55).** It used to be one:
 * `netFetch` converted every `fetch` rejection except an abort into
 * `OfflineError`, so a TLS failure, a DNS failure, a timeout and a phone with
 * no radio were literally the same object by the time any screen saw them.
 * An athlete with four bars was told to *"Try again when you have signal"*
 * while a photo upload was being dropped for its size. One sentinel cannot
 * carry four diagnoses, and no per-screen wording can recover a distinction
 * the transport already threw away.
 *
 * ## Diagnosis and action are separate on purpose
 *
 * `diagnosis` is what happened; the message is that plus a default action.
 * A surface with a better action than "try again" — the machine camera can
 * send you to search, the meal screen to manual entry — composes its own from
 * `transportDiagnosis()` instead of writing a second description of the same
 * failure. That is what keeps the wording central while the actions stay
 * local: two screens had already written their own network copy, and a third
 * would have made it the pattern.
 *
 * Copy is one line then an action, because it is read one-handed over a plate.
 */
export class TransportError extends Error {
  /** What happened, with no advice attached. Always ends in a full stop. */
  readonly diagnosis: string;

  constructor(diagnosis: string, action: string) {
    super(`${diagnosis} ${action}`);
    this.name = 'TransportError';
    this.diagnosis = diagnosis;
  }
}

/**
 * No route to the API — nothing answered, and VOLA did not answer a probe
 * either.
 *
 * **This is now the narrow case, not the default.** It is thrown when we have
 * positive evidence that the API is unreachable: `netFetch` asks `/v1/healthz`
 * before claiming it. `session.ts` also throws it when Clerk cannot be
 * reached, which is the same statement about the same network.
 *
 * The "still signed in" clause is load-bearing and is not to be trimmed away:
 * Clerk returns `null` offline, nine modules once read that as *"Not signed
 * in."*, and a gym dead-spot told a signed-in athlete to sign in again on
 * every screen at once. What was trimmed is the third sentence.
 *
 * Note what it does **not** claim: not "you are offline". A phone with a
 * perfect signal and an API that is down is also here, and the athlete cannot
 * act on the difference — see the captive-portal note in `authedFetch.ts`.
 */
export class OfflineError extends TransportError {
  constructor() {
    super("Can't reach VOLA.", "You're still signed in — try again in a moment.");
    this.name = 'OfflineError';
  }
}

/**
 * We stopped waiting.
 *
 * Thrown when `netFetch`'s own deadline fires — so the app decides this, it
 * does not read it off an error — and also when the runtime reports its own
 * timeout. Distinct from `OfflineError` because a request that ran for thirty
 * seconds had a network under it the whole time, and telling that athlete to
 * go and find signal is the exact misdiagnosis N55 is about.
 */
export class TimeoutError extends TransportError {
  constructor() {
    super('VOLA took too long to answer.', 'Try again.');
    this.name = 'TimeoutError';
  }
}

/**
 * The request failed while VOLA was demonstrably reachable.
 *
 * A connection reset, a refused body, a TLS handshake that failed on this
 * request — the transport cannot tell us which (see `authedFetch.ts`), so this
 * says only what was actually established: the network is there, and this
 * request did not complete. That is enough to stop sending the athlete to look
 * for signal, which is the whole complaint.
 *
 * The likeliest producer is an upload: biggest body, longest round trip, and
 * the one the backend can cut off mid-stream — `MaxBytesReader` closes the
 * connection after answering, so a client that is still writing may never read
 * the 400 it was sent.
 */
export class RequestDroppedError extends TransportError {
  constructor() {
    super("That didn't get through.", 'Try again.');
    this.name = 'RequestDroppedError';
  }
}

/**
 * "I couldn't ask", as opposed to any answer the server gave.
 *
 * **This is the check that inherited the old `isOffline` behaviour**, and
 * every caller that used `isOffline` to mean "stay quiet and retry later" was
 * moved to it — because before N55 every no-answer failure WAS an
 * `OfflineError`, so this is what those call sites have always meant. Reach
 * for `isOffline` only when the difference between "no route" and "the request
 * failed" changes what you show.
 */
export function isTransportFailure(err: unknown): boolean {
  return err instanceof TransportError;
}

/** Specifically no route to the API, as opposed to any other dead request. */
export function isOffline(err: unknown): boolean {
  return err instanceof OfflineError;
}

/**
 * The sentence describing a dead request, for a surface that supplies its own
 * action. `null` for anything the server actually answered.
 */
export function transportDiagnosis(err: unknown): string | null {
  return err instanceof TransportError ? err.diagnosis : null;
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
