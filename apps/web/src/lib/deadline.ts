/**
 * The deadline every web request runs under — N159 (#576).
 *
 * Before this, no web request had one. A hung response ran until the browser
 * or the server runtime gave up, minutes later, and then failed with a message
 * about an aborted operation — or, on the Library page, with nothing at all.
 *
 * **The numbers are the phone's, not new ones.** `apps/mobile/lib/authedFetch.ts`
 * owns the reasoning for both, and `scripts/check-timeout-parity.py` fails the
 * build if this copy, admin's copy and the phone's drift apart. Copied per app
 * rather than shared, the way `trace.ts` is: this repo has no shared package,
 * and this is not the thing to start one for.
 *
 * Directiveless on purpose: `modules.ts` and `unitSystem.ts` run in the
 * dashboard's Server Component layout and cannot import the client module
 * `api.ts`, so the wrapper cannot live there.
 */

/** A request's budget unless it says otherwise — see `authedFetch.ts` for why 30s. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The budget for a request that waits on a language model or carries a large
 * body. No web call does today. The first one must use this rather than a
 * third number: the server's own deadline on those routes is set to answer
 * under it, and `check-timeout-parity.py` holds that ordering.
 */
export const SLOW_REQUEST_TIMEOUT_MS = 45_000;

export type DeadlineOptions = {
  /** Override the budget. `SLOW_REQUEST_TIMEOUT_MS` for a model or a big body. */
  timeoutMs?: number;
};

/**
 * Our deadline fired.
 *
 * **Deliberately not an `AbortError`.** Fifteen dashboard call sites ignore
 * errors named `AbortError`, because that is how their own superseded requests
 * end. A timeout arriving under that name would be swallowed by exactly the
 * screens that need to show it, and they would look hung — the failure this
 * exists to end. The copy matches the phone's.
 */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super("VOLA took too long to answer. Try again.");
    this.name = "TimeoutError";
  }
}

export function isTimeout(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError;
}

/**
 * Run one request exchange under a deadline.
 *
 * `run` is handed the signal to give `fetch`, and the deadline stays armed
 * until `run` settles, so it bounds reading the body as well as the headers.
 * **This is where web deliberately differs from the phone**, whose `netFetch`
 * clears its timer when `fetch` resolves: a response whose headers arrive and
 * whose body never does is still a hung request.
 *
 * Composed with the caller's signal rather than replacing it, and **the caller
 * wins**: a request the screen abandoned is not a timeout anybody should read.
 *
 * Once the deadline has fired, `run`'s result is not trusted even if it
 * resolves. `api.ts` reads bodies with `res.json().catch(() => null)`, which
 * swallows the abort — without this rule a timed-out read would hand its
 * caller `null` as though that were the answer.
 */
export async function withDeadline<T>(
  callerSignal: AbortSignal | null | undefined,
  opts: DeadlineOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const caller = callerSignal ?? null;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, timeoutMs);
  const relay = () => controller.abort();

  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", relay);
  }

  try {
    const result = await run(controller.signal);
    if (deadlineFired && !caller?.aborted) throw new TimeoutError(timeoutMs);
    return result;
  } catch (err) {
    // Order matters: our deadline aborts too, so it can arrive as an
    // `AbortError`, and the caller's cancellation has to be answered first.
    if (err instanceof TimeoutError) throw err;
    if (caller?.aborted) throw err;
    if (deadlineFired) throw new TimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", relay);
  }
}
