import { ApiError, OfflineError, RequestDroppedError, TimeoutError } from '@/lib/apiError';
import { SLOW_REQUEST_TIMEOUT_MS } from '@/lib/authedFetch';
import {
  DRAFT_RETRY_BUDGET_MS,
  FREE_ATTEMPTS,
  METERED_ATTEMPTS,
  draftErrorMessage,
  draftReflection,
  draftRetryClass,
  type DraftResponse,
} from '@/lib/reflectApi';

/**
 * Retrying a dictation without spending somebody's day (N118).
 *
 * ## What is measured here and what is assumed
 *
 * Stated up front because the premise of this ticket is that a belief encoded
 * in copy turned out to be false, and the same trap is available to a test.
 *
 * **Measured, from the code on `main`:** which failures the handler meters.
 * `reflect_handler.go` returns before `RecordDraft` for `ErrDraftUnreachable`
 * and falls through to it for everything else, so 503+`unavailable` is free and
 * 422 / 503+`internal` are billed. The Go tests in `reflect_outage_test.go`
 * assert exactly that, in rows, against the real handler.
 *
 * **Assumed, and it is the assumption the ticket rests on:** that an identical
 * dictation can be refused once and drafted the next time. The evidence is one
 * field report plus the mechanism — no `llm.Request` carries a temperature, so
 * both providers sample at their default. Nothing below stubs a provider, so
 * nothing below can confirm it; what these tests pin is the CONSEQUENCE we
 * chose from it, which is that the second attempt happens exactly once.
 *
 * A stub that answered "refused, then fine" would look like proof and would be
 * this file asserting its own author's belief back at itself.
 */

const mockApiRequest = jest.fn();
jest.mock('@/lib/apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApiRequest(...a) }));
const apiRequest = mockApiRequest;

const ok: DraftResponse = {
  draft: {
    kind: 'rolling',
    gi: true,
    rounds: 5,
    round_minutes: 5,
    session_rpe: 8,
    note: '',
    body_note: '',
    tags: [],
    unresolved: [],
    notices: [],
    empty: false,
    model: 'test-model',
  },
  quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
};

const getToken = async () => 'token';

/** No wall-clock cost, and it records the ladder so backoff is assertable. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const refused = () => new ApiError('server prose', 'invalid_input', 422);
const providerDown = () => new ApiError('server prose', 'unavailable', 503);
const answeredBadly = () => new ApiError('server prose', 'internal', 503);
const outOfDrafts = () =>
  new ApiError('you have used all 10 reflection drafts for today — one more in about 3 hours', 'rate_limited', 429);

beforeEach(() => {
  apiRequest.mockReset();
});

describe('draftRetryClass', () => {
  it('treats a fast dead request as free — nothing reached a token', () => {
    for (const err of [new OfflineError(), new RequestDroppedError()]) {
      expect(draftRetryClass(err)).toBe('free');
    }
  });

  it('treats OUR OWN deadline as billed, because the backend does', () => {
    // The one that would have gone wrong quietly. `netFetch` aborting at 45s
    // cancels the request server-side mid-provider-call, and
    // `internal/platform/llm` maps a cancelled call away from ErrUnreachable
    // deliberately — "if cancellation were free, the quota would be trivially
    // defeatable". Reading it off N55's transport family as free would spend
    // three of ten while believing it spent none.
    expect(draftRetryClass(new TimeoutError())).toBe('metered');
  });

  it('separates the two 503s by CODE, because they differ by nothing else', () => {
    // The whole reason #367 gave the outage its own code. Reading the status
    // alone puts an unbilled outage and a billed unusable answer in the same
    // bucket, which is the distinction this ticket has to act on.
    expect(providerDown().status).toBe(answeredBadly().status);
    expect(draftRetryClass(providerDown())).toBe('free');
    expect(draftRetryClass(answeredBadly())).toBe('metered');
  });

  it('never retries an exhausted allowance, though N55 calls 429 retryable', () => {
    expect(draftRetryClass(outOfDrafts())).toBe('final');
  });

  it('never retries a request the server refused to accept', () => {
    expect(draftRetryClass(new ApiError('too long', 'invalid_input', 400))).toBe('final');
    expect(draftRetryClass(new ApiError('gone', 'not_found', 404))).toBe('final');
  });

  it('retries an expired token, which costs nothing and works on the next one', () => {
    expect(draftRetryClass(new ApiError('sign in', 'unauthorized', 401))).toBe('free');
  });

  it('calls a refusal metered — billed, and worth exactly one more go', () => {
    expect(draftRetryClass(refused())).toBe('metered');
  });

  it('does not classify something that never came from the API', () => {
    expect(draftRetryClass(new Error('boom'))).toBe('final');
    expect(draftRetryClass(null)).toBe('final');
  });
});

describe('draftReflection', () => {
  it('sends once when it works, and waits for a model while doing it', async () => {
    apiRequest.mockResolvedValueOnce(ok);
    await expect(draftReflection(getToken, 'rolled five')).resolves.toBe(ok);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    // The route waits on a provider, like estimate and identify. On the 30s
    // default it manufactures the timeout it is being retried for.
    expect(apiRequest.mock.calls[0][3]).toEqual({ timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
  });

  it('recovers from a dead network with the athlete doing nothing', async () => {
    apiRequest.mockRejectedValueOnce(new OfflineError()).mockResolvedValueOnce(ok);
    const { sleep, waits } = fakeSleep();

    await expect(draftReflection(getToken, 'rolled five', { sleep })).resolves.toBe(ok);

    expect(apiRequest).toHaveBeenCalledTimes(2);
    // Backed off, not hammered.
    expect(waits).toEqual([400]);
  });

  it('sends the same dictation on every attempt — a retry cannot lose the words', async () => {
    apiRequest.mockRejectedValueOnce(new RequestDroppedError()).mockResolvedValueOnce(ok);
    const { sleep } = fakeSleep();

    await draftReflection(getToken, 'hour of gi, drilled the knee cut', { sleep });

    const bodies = apiRequest.mock.calls.map((c) => JSON.parse((c[2] as RequestInit).body as string));
    expect(bodies).toEqual([
      { dictation: 'hour of gi, drilled the knee cut' },
      { dictation: 'hour of gi, drilled the knee cut' },
    ]);
  });

  it('stops after a bounded number of free attempts and backs off between them', async () => {
    apiRequest.mockRejectedValue(new OfflineError());
    const { sleep, waits } = fakeSleep();

    await expect(draftReflection(getToken, 'rolled five', { sleep })).rejects.toBeInstanceOf(OfflineError);

    expect(apiRequest).toHaveBeenCalledTimes(FREE_ATTEMPTS);
    expect(waits).toEqual([400, 1600]);
    // Each wait longer than the last: a ladder, not a fixed interval.
    expect(waits.every((w, i) => i === 0 || w > waits[i - 1])).toBe(true);
  });

  it('retries a refusal EXACTLY once — a second attempt is not a loop', async () => {
    apiRequest.mockRejectedValue(refused());
    const { sleep } = fakeSleep();

    await expect(draftReflection(getToken, 'rolled five', { sleep })).rejects.toBeInstanceOf(ApiError);

    // THE QUOTA ASSERTION. Every one of these is a billed call against ten a
    // day. If this number grows, an athlete's allowance shrinks by the same
    // amount and nobody notices until they run out.
    expect(apiRequest).toHaveBeenCalledTimes(METERED_ATTEMPTS);
    expect(METERED_ATTEMPTS).toBe(2);
  });

  it('spends at most one extra draft even when free retries came first', async () => {
    apiRequest
      .mockRejectedValueOnce(new OfflineError())
      .mockRejectedValueOnce(providerDown())
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused());
    const { sleep } = fakeSleep();

    await expect(draftReflection(getToken, 'rolled five', { sleep })).rejects.toBeInstanceOf(ApiError);

    // Four attempts, two of them billed: the free ones never reached a token.
    expect(apiRequest).toHaveBeenCalledTimes(4);
  });

  it('gives up the moment the allowance is gone', async () => {
    apiRequest.mockRejectedValue(outOfDrafts());
    const { sleep, waits } = fakeSleep();

    await expect(draftReflection(getToken, 'rolled five', { sleep })).rejects.toMatchObject({ status: 429 });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('stops retrying once it has been trying for too long', async () => {
    // Attempt count alone is not a bound the athlete can feel: three attempts
    // on a 45s deadline is over two minutes behind a spinner.
    apiRequest.mockRejectedValue(new TimeoutError());
    const { sleep } = fakeSleep();
    let clock = 0;
    const now = () => {
      const t = clock;
      clock += DRAFT_RETRY_BUDGET_MS; // one attempt burns the whole budget
      return t;
    };

    await expect(
      draftReflection(getToken, 'rolled five', { sleep, now }),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('tells the screen a retry is happening, and only when one is', async () => {
    apiRequest.mockRejectedValueOnce(new OfflineError()).mockResolvedValueOnce(ok);
    const { sleep } = fakeSleep();
    const onRetry = jest.fn();

    await draftReflection(getToken, 'rolled five', { sleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    apiRequest.mockReset();
    apiRequest.mockResolvedValueOnce(ok);
    await draftReflection(getToken, 'rolled five', { sleep, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('draftErrorMessage', () => {
  /** The accusation this ticket was filed about, in every form it could take. */
  const BLAME = /articulat|plainer|clearly|say it differently|speak/i;

  it('never repeats the server’s sentence for a refusal', () => {
    const msg = draftErrorMessage(refused());
    expect(msg).not.toContain('server prose');
    expect(msg).not.toMatch(BLAME);
    // It says what happened, and it says the words are still there.
    expect(msg).toMatch(/still here/i);
  });

  it('blames nobody, on any failure this route can produce', () => {
    for (const err of [
      new OfflineError(),
      new TimeoutError(),
      new RequestDroppedError(),
      refused(),
      providerDown(),
      answeredBadly(),
      outOfDrafts(),
      new ApiError('dictation is too long', 'invalid_input', 400),
      new Error('something odd'),
    ]) {
      const msg = draftErrorMessage(err);
      expect(msg).not.toMatch(BLAME);
      // One line, and never empty — blank space where a reason should be is
      // the failure this whole area keeps relearning.
      expect(msg.trim().length).toBeGreaterThan(0);
      expect(msg).not.toContain('\n');
    }
  });

  it('uses the transport’s own diagnosis rather than writing a second one', () => {
    expect(draftErrorMessage(new OfflineError())).toContain(new OfflineError().diagnosis);
    expect(draftErrorMessage(new TimeoutError())).toContain(new TimeoutError().diagnosis);
    // And never sends someone to find signal when the server answered.
    expect(draftErrorMessage(answeredBadly())).not.toMatch(/signal|offline|reach VOLA/i);
  });

  it('says an outage cost nothing, because otherwise the athlete assumes it did', () => {
    expect(draftErrorMessage(providerDown())).toMatch(/none of your daily drafts/i);
  });

  it('does NOT pass through a status it has no branch for', () => {
    // The fall-through used to be `err.message`, which quietly re-opened the
    // door this function exists to close for every status the backend grows
    // next. Raised in review; the doc claimed two exceptions and the code meant
    // all of them.
    for (const err of [
      new ApiError('server prose', 'forbidden', 403),
      new ApiError('server prose', 'already_exists', 409),
      new ApiError('server prose', 'teapot', 418),
    ]) {
      expect(draftErrorMessage(err)).not.toContain('server prose');
      expect(draftErrorMessage(err)).toMatch(/still here/i);
    }
  });

  it('keeps the server’s wording for a quota, which carries the reset', () => {
    // Deliberate, and the same call `estimateApi` documents: a mapped "you're
    // out of drafts" would throw away "one more in about 3 hours", which is
    // the only actionable part and something this file cannot reconstruct.
    expect(draftErrorMessage(outOfDrafts())).toContain('about 3 hours');
  });
});
