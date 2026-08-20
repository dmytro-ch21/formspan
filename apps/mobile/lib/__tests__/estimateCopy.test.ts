/**
 * What the meal-estimate screen says when the estimate does not arrive (N55).
 *
 * Separate from `estimateApi.test.ts`, which is about the wire layer — this is
 * about the two sentences that were wrong on a real phone, and it is a pure
 * function test so it can be run without rendering the screen.
 *
 * The screen used to show `err.message`, falling back to *"Could not reach the
 * server. Try again when you have signal."* Two failures came out of that:
 *
 * - **A 503 read as an outage.** The route answers 503 when the deploy has no
 *   provider key, by the handler's own comment — a feature that is not
 *   switched on. The athlete saw the server's bare *"meal estimation is not
 *   available"*, with nothing saying that typing the meal in still works.
 * - **A dead request read as a signal problem**, whatever had happened to it.
 */

import { ApiError, OfflineError, RequestDroppedError, TimeoutError } from '../apiError';
import { estimateErrorMessage } from '../estimateApi';

describe('a 503 — no provider key on this deploy', () => {
  const notConfigured = new ApiError('meal estimation is not available', 'internal', 503);

  it('reads as a feature that is not switched on', () => {
    expect(estimateErrorMessage(notConfigured)).toMatch(/switched on/i);
  });

  it('never reads as a connection problem', () => {
    // The criterion, stated as the assertion. A 503 is an ANSWER: the request
    // arrived, was understood, and was declined.
    expect(estimateErrorMessage(notConfigured)).not.toMatch(
      /signal|offline|connection|can't reach|could not reach/i,
    );
  });

  it('names the path that still works', () => {
    // Every other way of logging food is unaffected. Saying only "unavailable"
    // strands somebody holding a plate.
    expect(estimateErrorMessage(notConfigured)).toMatch(/by hand/i);
  });

  it('does not pass the server sentence through unchanged', () => {
    // What the athlete used to get.
    expect(estimateErrorMessage(notConfigured)).not.toBe('meal estimation is not available');
  });
});

describe('a request that never got an answer', () => {
  const dead = [
    ['no route to the API', new OfflineError()],
    ['a timeout', new TimeoutError()],
    ['a dropped connection', new RequestDroppedError()],
  ] as const;

  it.each(dead)('says which kind it was: %s', (_label, err) => {
    expect(estimateErrorMessage(err)).toContain(err.diagnosis);
  });

  it('gives all three different copy', () => {
    // Collapse any two and this goes red — the mutation that recreates N55.
    const msgs = dead.map(([, err]) => estimateErrorMessage(err));
    expect(new Set(msgs).size).toBe(3);
  });

  it('never blames signal for a request that had a network under it', () => {
    expect(estimateErrorMessage(new RequestDroppedError())).not.toMatch(/signal|reach/i);
    expect(estimateErrorMessage(new TimeoutError())).not.toMatch(/signal/i);
  });

  it('points at manual entry, because the athlete still has to log the meal', () => {
    for (const [, err] of dead) expect(estimateErrorMessage(err)).toMatch(/by hand/i);
  });
});

describe('everything else the server answered', () => {
  it('keeps the 429 message, reset time and all', () => {
    // Mapping this to copy of our own would throw away the one number the
    // athlete can act on. The server writes this for them; it is not ours to
    // paraphrase.
    const err = new ApiError(
      'you have used all 25 estimates for today — one more in 20 minutes',
      'rate_limited',
      429,
    );
    expect(estimateErrorMessage(err)).toBe(err.message);
    expect(estimateErrorMessage(err)).toContain('20 minutes');
  });

  it('keeps a 502 as the server worded it', () => {
    const err = new ApiError('estimation returned something unusable — try again', 'internal', 502);
    expect(estimateErrorMessage(err)).toBe(err.message);
  });

  it('does not fall back to network wording when it has nothing to say', () => {
    // Reaching the fallback means the server DID answer — it just answered
    // with something we cannot render. The old fallback said "check your
    // signal" here, which is a confident false statement.
    const msg = estimateErrorMessage({ status: 418 });
    expect(msg).not.toMatch(/signal|offline|connection|reach/i);
    expect(msg).toMatch(/by hand/i);
  });
});
