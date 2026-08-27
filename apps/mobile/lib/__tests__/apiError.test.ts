import { ApiError, parseRetryAfterMs, retryAfterOf, waitPhrase } from '../apiError';

/**
 * `Retry-After` parsing and formatting (F17, #403).
 *
 * F15 (#366) hit a trap worth naming here rather than repeating: "the obvious
 * test passes against the bug" whenever a whole number of seconds rounds the
 * same way regardless of the arithmetic under it. Every table below pins its
 * assertion at the actual transition — the last value on one side of a branch
 * next to the first value on the other — rather than at a value comfortably
 * in the middle of either.
 */

describe('parseRetryAfterMs — delay-seconds, what this server actually sends', () => {
  it('converts whole seconds to milliseconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5_000);
    expect(parseRetryAfterMs('1')).toBe(1_000);
    expect(parseRetryAfterMs('300')).toBe(300_000);
  });

  it('accepts "0" — the parser does not decide what is a valid wait, the caller does', () => {
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns undefined for absence, not zero — "no header" and "wait zero" are different facts', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
  });

  it('rejects a sign or a decimal point — RFC 9110 delay-seconds is digits only', () => {
    // Loose parsing here would silently accept a form the server never sends,
    // and "-5" parsed as a NEGATIVE wait is the one output this function must
    // never produce — every caller feeds it straight into a Math.max floor.
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('4.5')).toBeUndefined();
    expect(parseRetryAfterMs('abc')).toBeUndefined();
    expect(parseRetryAfterMs('5 ')).toBe(5_000); // trimmed, not rejected
  });
});

describe('parseRetryAfterMs — the HTTP-date fallback this server never sends today', () => {
  const now = () => Date.parse('2026-08-27T12:00:00.000Z');

  it('computes the delay from a future date', () => {
    const future = new Date(now() + 30_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(30_000);
  });

  it('clamps a past date to 0 rather than going negative', () => {
    const past = new Date(now() - 10_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it('returns undefined for unparseable text', () => {
    expect(parseRetryAfterMs('not a date, not a number', now)).toBeUndefined();
  });
});

describe('retryAfterOf', () => {
  it('reads the field off an ApiError that carries one', () => {
    const err = new ApiError('slow down', 'rate_limited', 429, 47_000);
    expect(retryAfterOf(err)).toBe(47_000);
  });

  it('is undefined for an ApiError with none', () => {
    expect(retryAfterOf(new ApiError('nope', 'invalid_input', 422))).toBeUndefined();
  });

  it('is undefined for anything that is not an ApiError', () => {
    expect(retryAfterOf(new Error('network'))).toBeUndefined();
    expect(retryAfterOf(null)).toBeUndefined();
    expect(retryAfterOf({ status: 429, retryAfterMs: 5_000 })).toBeUndefined();
  });
});

describe('waitPhrase', () => {
  it('says seconds under a minute, pluralised correctly', () => {
    expect(waitPhrase(1_000)).toBe('Wait 1 second');
    expect(waitPhrase(2_000)).toBe('Wait 2 seconds');
    expect(waitPhrase(47_000)).toBe('Wait 47 seconds');
  });

  it('never says zero — a sub-second remainder still reads as "1 second"', () => {
    expect(waitPhrase(0)).toBe('Wait 1 second');
    expect(waitPhrase(1)).toBe('Wait 1 second');
    expect(waitPhrase(400)).toBe('Wait 1 second');
  });

  /**
   * THE BOUNDARY. 59 whole seconds and 60 whole seconds sit on opposite
   * sides of the `< 60` branch — this is the F15-shaped pin: not a value
   * comfortably inside either branch, but the two values immediately either
   * side of the transition.
   */
  it('59 seconds stays in the seconds branch; 60 crosses into minutes', () => {
    expect(waitPhrase(59_000)).toBe('Wait 59 seconds');
    expect(waitPhrase(60_000)).toBe('Wait about 1 minute');
  });

  it('a fractional remainder that rounds up to 60s also crosses the boundary', () => {
    // 59.001s ceils to 60s, which must land in the SAME branch as 60_000 —
    // rounding happens once, at the top, not independently per branch.
    expect(waitPhrase(59_001)).toBe('Wait about 1 minute');
  });

  it('rounds to the nearest minute at or above a minute', () => {
    expect(waitPhrase(60_000)).toBe('Wait about 1 minute'); // singular
    expect(waitPhrase(90_000)).toBe('Wait about 2 minutes'); // rounds up at the midpoint
    expect(waitPhrase(119_000)).toBe('Wait about 2 minutes');
    expect(waitPhrase(300_000)).toBe('Wait about 5 minutes');
  });
});
