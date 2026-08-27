import { identifyErrorMessage, identifyHint, isRetryable } from '../identifyApi';
import { ApiError, OfflineError, RequestDroppedError, TimeoutError } from '../apiError';

/**
 * The two pure decisions in the machine-identify client.
 *
 * Deliberately not a component test — what breaks here is not rendering, it is
 * telling an athlete to do the one thing that cannot work.
 */

describe('isRetryable', () => {
  it('says NO to a 422, because the same photo gives the same refusal', () => {
    // The load-bearing one. A 422 means the server read the photo and no
    // machine on the shortlist matched — deterministic, so a "try again"
    // button on that path is a button that cannot work. The screen must offer
    // "take another" instead, which is a different action.
    expect(isRetryable(new ApiError('nope', 'invalid_input', 422))).toBe(false);
  });

  it('says NO to a 400 and a 429', () => {
    // 400: the photo could not be read at all — resending the same bytes
    // fails identically. 429: retrying immediately is the exact behaviour the
    // limit exists to stop, and it spends money on every attempt.
    expect(isRetryable(new ApiError('bad', 'invalid_input', 400))).toBe(false);
    expect(isRetryable(new ApiError('slow down', 'rate_limited', 429))).toBe(false);
  });

  it('says YES to a 503 and to an unknown failure', () => {
    // A provider outage and a dead connection are both worth another attempt,
    // and both are states the athlete cannot fix by changing anything.
    expect(isRetryable(new ApiError('down', 'internal', 503))).toBe(true);
    expect(isRetryable(new Error('network'))).toBe(true);
    expect(isRetryable(null)).toBe(true);
  });
});

/**
 * `identifyHint` — a different question from `isRetryable` above (F17, #403).
 *
 * The 429 test in `isRetryable` above is untouched and must stay that way:
 * 429 is correctly non-retryable, and this block is not arguing otherwise.
 * What it pins is that the SCREEN's hint for a 429 is not folded into either
 * `retry` or `retake` — before this fix it fell through to `retake`, which
 * told a rate-limited athlete to reshoot a photo that had nothing to do with
 * the refusal.
 */
describe('identifyHint', () => {
  it('says WAIT for a 429, not retake — a new photo cannot fix a rate limit', () => {
    expect(identifyHint(new ApiError('slow down', 'rate_limited', 429))).toBe('wait');
  });

  it('still says retake for a 422 — the deterministic, photo-is-the-problem case', () => {
    expect(identifyHint(new ApiError('nope', 'invalid_input', 422))).toBe('retake');
  });

  it('says retake for a 400 too — an unreadable photo, same remedy as a 422', () => {
    expect(identifyHint(new ApiError('bad', 'invalid_input', 400))).toBe('retake');
  });

  it('says retry for anything isRetryable already says yes to', () => {
    expect(identifyHint(new ApiError('down', 'internal', 503))).toBe('retry');
    expect(identifyHint(new Error('network'))).toBe('retry');
    expect(identifyHint(null)).toBe('retry');
  });

  it('gives 429 its own distinct value — not equal to either retry or retake', () => {
    const wait = identifyHint(new ApiError('slow down', 'rate_limited', 429));
    expect(wait).not.toBe('retry');
    expect(wait).not.toBe('retake');
  });
});

describe('identifyErrorMessage', () => {
  it('tells the athlete what would actually help on a 422', () => {
    const msg = identifyErrorMessage(new ApiError('x', 'invalid_input', 422));
    // Naming the remedy is the whole value. "Could not identify" alone leaves
    // somebody pressing the same button on the same machine.
    expect(msg).toMatch(/straighter shot|whole machine|label/i);
  });

  it('never blames the network for a refusal', () => {
    // The shared fallback says "check your signal", which is the wrong
    // diagnosis for a photo the server read perfectly well and declined — and
    // it sends the athlete to fix something that is not broken.
    const msg = identifyErrorMessage(new ApiError('x', 'invalid_input', 422));
    expect(msg).not.toMatch(/signal|connection|offline|reach the server/i);
  });

  it('offers the search fallback wherever the camera cannot help', () => {
    // 503 and an unknown failure both leave the athlete mid-session needing to
    // add an exercise. A message that only apologises strands them; every one
    // of these has to point at the path that still works.
    for (const err of [
      new ApiError('x', 'internal', 503),
      new ApiError('x', 'rate_limited', 429),
      new Error('boom'),
    ]) {
      expect(identifyErrorMessage(err)).toMatch(/search/i);
    }
  });

  it('distinguishes all five outcomes', () => {
    // Distinct copy per status, asserted as a set rather than one by one: two
    // statuses collapsing onto one string is the regression this catches, and
    // it is invisible when each is only checked against a pattern.
    const msgs = [400, 422, 429, 503, 500].map((s) =>
      identifyErrorMessage(new ApiError('x', 'c', s)),
    );
    expect(new Set(msgs).size).toBe(5);
  });

  /**
   * F17 (#403). The two branches this pins are: "the response carried a
   * `Retry-After`" and "it did not" — a real fork in `identifyErrorMessage`,
   * not a round-trip of a value the test itself set on a header. Nothing
   * here touches `parseRetryAfterMs`; `apiError.test.ts` owns that boundary.
   */
  describe('on a 429', () => {
    it('says the server-computed wait when the response carried one', () => {
      const msg = identifyErrorMessage(new ApiError('slow down', 'rate_limited', 429, 47_000));
      expect(msg).toMatch(/wait 47 seconds/i);
      expect(msg).not.toMatch(/a few minutes/i);
    });

    it('falls back to the vague wording only when there is truly nothing to report', () => {
      // The 4th constructor argument left OFF entirely — not "0", which is a
      // real answer ("retry now") and must not collapse into "unknown".
      const msg = identifyErrorMessage(new ApiError('slow down', 'rate_limited', 429));
      expect(msg).toMatch(/a few minutes/i);
    });

    it('a zero-second wait is reported as zero, not folded into the vague fallback', () => {
      const msg = identifyErrorMessage(new ApiError('slow down', 'rate_limited', 429, 0));
      // waitPhrase(0) reads "Wait 1 second" (never "0 seconds") — asserted in
      // full here so this test would fail if that floor were ever dropped.
      expect(msg).toMatch(/wait 1 second/i);
      expect(msg).not.toMatch(/a few minutes/i);
    });
  });
});

/**
 * The branch N55 added, and the one the device report was actually about.
 *
 * The athlete photographed a machine on a phone with four bars and read
 * *"Could not reach the server. Try again when you have signal, or search for
 * the exercise instead."* — this function's no-status default, taken because
 * an oversized upload was dropped and every dead request looked alike.
 */
describe('identifyErrorMessage, on a request that never got an answer', () => {
  const dead = [
    ['no route to the API', new OfflineError()],
    ['a timeout', new TimeoutError()],
    ['a dropped connection', new RequestDroppedError()],
  ] as const;

  it.each(dead)('says which kind of dead request it was: %s', (_label, err) => {
    // Each carries its own diagnosis rather than all three sharing one
    // sentence. Fold two of them together and this goes red.
    expect(identifyErrorMessage(err)).toContain(err.diagnosis);
  });

  it('gives all three different copy', () => {
    const msgs = dead.map(([, err]) => identifyErrorMessage(err));
    expect(new Set(msgs).size).toBe(3);
  });

  it('never sends an athlete with a working connection to look for signal', () => {
    // The exact regression. A dropped upload and a timeout both happened over
    // a network that was working; only the offline case may mention reach.
    expect(identifyErrorMessage(new RequestDroppedError())).not.toMatch(/signal|reach/i);
    expect(identifyErrorMessage(new TimeoutError())).not.toMatch(/signal/i);
  });

  it('still offers the search fallback on every one of them', () => {
    // Mid-session, the athlete needs the exercise either way.
    for (const [, err] of dead) expect(identifyErrorMessage(err)).toMatch(/search/i);
  });

  it('adds the action once, not twice', () => {
    // The sentinel's own message ends in an action too. Composing the whole
    // message instead of the diagnosis would read "... Try again. Search for
    // the exercise instead."
    expect(identifyErrorMessage(new TimeoutError())).not.toMatch(/try again/i);
  });

  it('offers a retry, because none of these is the athlete\'s fault', () => {
    for (const [, err] of dead) expect(isRetryable(err)).toBe(true);
  });
});
