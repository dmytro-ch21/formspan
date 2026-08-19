import {
  DEFAULTS,
  TelemetryBuffer,
  fingerprintOf,
  redact,
  type Level,
} from '../telemetry';

/**
 * The four things the user asked for by name — do not make thousands of
 * writes, self-clean, be efficient, gate by level — plus the constraint that
 * matters most: nothing personal leaves the device.
 *
 * Every assertion here was checked by breaking the guard it covers and
 * watching it go red. That is the house rule, and it is the rule this file
 * most needs: a reporter that quietly stops reporting passes any test that
 * only asserts it did not crash.
 */

const T0 = 1_700_000_000_000;

function buf(cfg = {}) {
  return new TelemetryBuffer(cfg);
}

describe('coalescing — the thing that stops a dead spot becoming a flood', () => {
  it('folds repeat occurrences into ONE event carrying the true count', () => {
    const b = buf();
    for (let i = 0; i < 60; i++) {
      b.record('error', 'client_error', 'Cannot read property x of undefined', undefined, T0 + i);
    }
    // Sixty occurrences. One event, not sixty — this is the whole difference
    // between a render loop costing one payload and costing sixty.
    expect(b.size).toBe(1);
    const [e] = b.drain(T0 + 100);
    expect(e.count).toBe(60);
  });

  it('coalesces across a long offline stretch without growing', () => {
    const b = buf();
    const twoHours = 2 * 60 * 60 * 1000;
    for (let i = 0; i < 5000; i++) {
      b.record('error', 'sync_blocked', 'push rejected', undefined, T0 + (i * twoHours) / 5000);
    }
    // Nothing drained in between, so this is exactly the reconnect-flood case.
    expect(b.size).toBe(1);
    expect(b.drain(T0 + twoHours)[0].count).toBe(5000);
  });

  it('keeps genuinely different problems apart', () => {
    const b = buf();
    b.record('error', 'client_error', 'network down', undefined, T0);
    b.record('error', 'client_error', 'cannot parse response', undefined, T0);
    expect(b.size).toBe(2);
  });

  it('treats the same bug with different ids as one problem', () => {
    // "row 41 failed" and "row 87 failed" are one bug. If these fingerprint
    // apart, coalescing never coalesces and the cap never binds — which looks
    // like it is working right up until a device is in a loop.
    const a = fingerprintOf('client_error', 'row 41 failed to sync');
    const c = fingerprintOf('client_error', 'row 87 failed to sync');
    expect(a).toBe(c);
  });

  it('normalises uuids, hex and quoted strings out of the fingerprint', () => {
    const one = fingerprintOf(
      'client_error',
      'entry 3f2504e0-4f89-11d3-9a0c-0305e82c3301 rejected at 0xdeadbeef with "bad meal"',
    );
    const two = fingerprintOf(
      'client_error',
      'entry 7c9e6679-7425-40de-944b-e07fc1f90ae7 rejected at 0xfeedface with "bad name"',
    );
    expect(one).toBe(two);
  });

  it('does not collapse two different bugs into one fingerprint', () => {
    // The mirror of the above, and the one that matters if normalisation is
    // ever made more aggressive: over-normalising hides real problems behind
    // whichever one arrived first.
    expect(fingerprintOf('client_error', 'token refresh failed')).not.toBe(
      fingerprintOf('client_error', 'database migration failed'),
    );
  });

  it('separates the same text under different kinds', () => {
    expect(fingerprintOf('client_error', 'failed')).not.toBe(
      fingerprintOf('sync_blocked', 'failed'),
    );
  });
});

describe('the cap — bounded payloads per problem', () => {
  it('stops producing new events for one fingerprint once its window is spent', () => {
    const b = buf({ maxSendsPerFingerprint: 3, windowMs: 60_000 });
    for (let round = 0; round < 3; round++) {
      expect(b.record('error', 'client_error', 'boom', undefined, T0)).toBe(true);
      b.drain(T0);
    }
    // Fourth attempt inside the window: no new event.
    expect(b.record('error', 'client_error', 'boom', undefined, T0)).toBe(false);
    expect(b.size).toBe(0);
  });

  it('lets the fingerprint through again once the window rolls', () => {
    const b = buf({ maxSendsPerFingerprint: 1, windowMs: 60_000 });
    b.record('error', 'client_error', 'boom', undefined, T0);
    b.drain(T0);
    expect(b.record('error', 'client_error', 'boom', undefined, T0 + 59_999)).toBe(false);
    expect(b.record('error', 'client_error', 'boom', undefined, T0 + 60_000)).toBe(true);
  });

  it('REPORTS what the cap hid rather than hiding it', () => {
    // The load-bearing one. A cap that silently drops makes a burst look like
    // a single occurrence, which turns a cost control into a lie.
    const b = buf({ maxSendsPerFingerprint: 1, windowMs: 60_000 });
    b.record('error', 'client_error', 'boom', undefined, T0);
    b.drain(T0);
    for (let i = 0; i < 25; i++) {
      b.record('error', 'client_error', 'boom', undefined, T0 + 1000 + i);
    }
    const [e] = b.drain(T0 + 60_000 + 1) ?? [];
    expect(e).toBeUndefined(); // nothing buffered — the cap held

    b.record('error', 'client_error', 'boom', undefined, T0 + 60_001);
    const [next] = b.drain(T0 + 60_002);
    expect(next.dropped).toBe(25);
  });

  it('caps each fingerprint independently', () => {
    const b = buf({ maxSendsPerFingerprint: 1, windowMs: 60_000 });
    b.record('error', 'client_error', 'first', undefined, T0);
    b.drain(T0);
    // A different problem must not be silenced by the first one's cap.
    expect(b.record('error', 'client_error', 'second', undefined, T0)).toBe(true);
  });
});

describe('the ring — it cannot grow on a phone', () => {
  it('holds at most `capacity` distinct problems', () => {
    const b = buf({ capacity: 5 });
    for (let i = 0; i < 50; i++) {
      b.record('error', 'client_error', `distinct problem ${String.fromCharCode(97 + i)}`, undefined, T0 + i);
    }
    expect(b.size).toBe(5);
  });

  it('evicts the OLDEST problem, and counts what it lost', () => {
    const b = buf({ capacity: 2 });
    b.record('error', 'client_error', 'alpha', undefined, T0);
    b.record('error', 'client_error', 'bravo', undefined, T0 + 1);
    b.record('error', 'client_error', 'charlie', undefined, T0 + 2);
    const messages = b.drain(T0 + 3).map((e) => e.message);
    expect(messages).toEqual(['bravo', 'charlie']);
    // Silence is never the answer: the evicted event is gone, the fact that it
    // existed is not.
    expect(b.takeLost()).toBe(1);
  });

  it('clears the lost tally once it has been told', () => {
    const b = buf({ capacity: 1 });
    b.record('error', 'client_error', 'a', undefined, T0);
    b.record('error', 'client_error', 'b', undefined, T0 + 1);
    expect(b.takeLost()).toBe(1);
    expect(b.takeLost()).toBe(0);
  });

  it('counts a failed flush as loss rather than pretending it sent', () => {
    const b = buf();
    b.record('error', 'client_error', 'a', undefined, T0);
    const batch = b.drain(T0);
    b.recordLoss(batch.length);
    expect(b.takeLost()).toBe(1);
  });
});

describe('levels that actually gate', () => {
  it('keeps info and debug on the device by default', () => {
    const b = buf();
    expect(DEFAULTS.minLevel).toBe('error');
    expect(b.record('debug', 'client_error', 'tick', undefined, T0)).toBe(false);
    expect(b.record('info', 'client_error', 'synced', undefined, T0)).toBe(false);
    expect(b.record('warn', 'client_error', 'retrying', undefined, T0)).toBe(false);
    expect(b.size).toBe(0);
  });

  it('lets error and fatal through', () => {
    const b = buf();
    expect(b.record('error', 'client_error', 'boom', undefined, T0)).toBe(true);
    expect(b.record('fatal', 'client_error', 'crash', undefined, T0)).toBe(true);
  });

  it('can be opened up for a support session', () => {
    const b = buf({ minLevel: 'debug' as Level });
    expect(b.record('debug', 'client_error', 'tick', undefined, T0)).toBe(true);
  });
});

describe('batching', () => {
  it('does not ask to flush on the first event', () => {
    const b = buf();
    b.record('error', 'client_error', 'a', undefined, T0);
    expect(b.shouldFlush(T0)).toBe(false);
  });

  it('flushes at the size threshold', () => {
    const b = buf({ flushAtCount: 3 });
    b.record('error', 'client_error', 'a', undefined, T0);
    b.record('error', 'client_error', 'b', undefined, T0);
    expect(b.shouldFlush(T0)).toBe(false);
    b.record('error', 'client_error', 'c', undefined, T0);
    expect(b.shouldFlush(T0)).toBe(true);
  });

  it('flushes on age, measured from the OLDEST event', () => {
    const b = buf({ flushAfterMs: 30_000, flushAtCount: 99 });
    b.record('error', 'client_error', 'old', undefined, T0);
    b.record('error', 'client_error', 'new', undefined, T0 + 29_000);
    // Measured from the oldest, so a steady trickle still gets sent rather
    // than the clock resetting on every new arrival.
    expect(b.shouldFlush(T0 + 29_999)).toBe(false);
    expect(b.shouldFlush(T0 + 30_000)).toBe(true);
  });

  it('never asks to flush when empty', () => {
    expect(buf().shouldFlush(T0 + 10 ** 9)).toBe(false);
  });

  it('empties the buffer on drain', () => {
    const b = buf();
    b.record('error', 'client_error', 'a', undefined, T0);
    b.drain(T0);
    expect(b.size).toBe(0);
  });
});

describe('what must never leave the device', () => {
  it('drops any key not on the allowlist', () => {
    expect(
      redact({
        code: 'invalid_input',
        notes: 'felt awful, shoulder hurt again',
        foodName: 'chicken and rice',
        partner: '@someone',
        photoUri: 'file:///var/mobile/photo.jpg',
      }),
    ).toEqual({ code: 'invalid_input' });
  });

  it('drops objects and arrays whole rather than walking them', () => {
    // A nested object is where prose hides, and a recursive sanitiser is a
    // thing that grows an exception.
    expect(redact({ reason: { note: 'private' } })).toEqual({});
    expect(redact({ entity: ['a', 'b'] })).toEqual({});
  });

  it('keeps allowlisted primitives, and truncates long strings', () => {
    const out = redact({ status: 422, offline: true, reason: 'x'.repeat(500) });
    expect(out.status).toBe(422);
    expect(out.offline).toBe(true);
    expect(String(out.reason)).toHaveLength(80);
  });

  it('drops null, undefined and NaN rather than shipping them', () => {
    expect(redact({ code: null, status: undefined, attempt: NaN })).toEqual({});
  });

  it('survives no details at all', () => {
    expect(redact(undefined)).toEqual({});
  });

  it('truncates the message well under the server byte cap', () => {
    const b = buf();
    b.record('error', 'client_error', 'y'.repeat(1000), undefined, T0);
    expect(b.drain(T0)[0].message).toHaveLength(200);
  });

  it('redacts on the event that is actually buffered', () => {
    const b = buf();
    b.record('error', 'client_error', 'boom', { code: 'x', notes: 'secret' }, T0);
    expect(b.drain(T0)[0].details).toEqual({ code: 'x' });
  });
});
