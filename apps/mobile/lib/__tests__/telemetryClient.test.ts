import {
  capture,
  clearTelemetryForSignOut,
  flush,
  installTelemetry,
  rejectionTrackingActive,
  resetTelemetry,
} from '../telemetryClient';

/**
 * The transport half, which had no tests at all — and which is where four of
 * review's five blocking findings lived.
 *
 * That is not a coincidence and it is the lesson worth keeping: the pure buffer
 * was well covered and correspondingly correct, while the file with the timer
 * and the fetch in it had the cross-account flush, the evaporating loss tally
 * and the unchained handler. None of those need a device — a stubbed `fetch`
 * and a fake `ErrorUtils` reach all of them.
 */

type Posted = { url: string; body: { events: Record<string, unknown>[] }; token: string };

let posted: Posted[] = [];
let respondOk = true;
let throwOnFetch = false;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  respondOk = true;
  throwOnFetch = false;
  resetTelemetry();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (throwOnFetch) throw new Error('network down');
    posted.push({
      url,
      body: JSON.parse(String(init.body)),
      token: String((init.headers as Record<string, string>).Authorization),
    });
    return { ok: respondOk, status: respondOk ? 202 : 400 } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetTelemetry();
  globalThis.fetch = originalFetch;
});

const token = (v: string) => async () => v;

describe('batching, not per-occurrence sending', () => {
  it('sends nothing on an occurrence', async () => {
    installTelemetry(token('A'));
    capture('error', 'client_error', 'boom');
    expect(posted).toHaveLength(0);
  });

  it('sends ONE request for a burst of the same error', async () => {
    installTelemetry(token('A'));
    // The requirement in the user's own words: not thousands of writes. A
    // render loop throwing 60 times must not be 60 POSTs.
    for (let i = 0; i < 60; i++) capture('error', 'client_error', 'boom');
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.events).toHaveLength(1);
    expect(posted[0].body.events[0].details).toMatchObject({ occurrences: 60 });
  });

  it('carries many distinct problems in one request', async () => {
    installTelemetry(token('A'));
    // Genuinely different messages. `problem 1` / `problem 2` would NOT do:
    // digits normalise to `<n>`, so those are one problem by design, and the
    // first version of this test asserted against the fingerprinter working.
    for (const m of ['network down', 'cannot parse', 'token expired', 'disk full']) {
      capture('error', 'client_error', m);
    }
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.events.length).toBeGreaterThan(1);
  });

  it('does nothing when there is nothing buffered', async () => {
    installTelemetry(token('A'));
    await flush();
    expect(posted).toHaveLength(0);
  });
});

describe('the loss tally must not evaporate', () => {
  /**
   * Build a tally across CONSECUTIVE failed flushes.
   *
   * The obvious version — overflow the ring — does not work here and finding
   * that out mattered: `capture` auto-flushes at `flushAtCount`, so filling
   * past capacity drains along the way and never evicts anything.
   *
   * The first version of these two tests failed a single event and asserted
   * `lost_events >= 1`, which passes WITH the bug present: the tally was zero
   * at the failing flush, so `batch.length` alone happened to be right. Both
   * were green against the exact defect they are named for, and the mutation
   * is what said so — reading them did not.
   */
  async function failThreeThenThree(fail: () => void, unfail: () => void) {
    installTelemetry(token('A'));
    fail();
    capture('error', 'client_error', 'network down');
    capture('error', 'client_error', 'cannot parse');
    capture('error', 'client_error', 'token expired');
    await flush(); // 3 lost

    capture('error', 'client_error', 'disk full');
    capture('error', 'client_error', 'clock skewed');
    capture('error', 'client_error', 'socket closed');
    await flush(); // takes the 3, fails, must give back 3 + 3

    unfail();
    capture('error', 'client_error', 'something later');
    await flush();
  }

  it('carries an EARLIER tally forward when a send is rejected', async () => {
    await failThreeThenThree(
      () => {
        respondOk = false;
      },
      () => {
        respondOk = true;
      },
    );
    const details = posted[posted.length - 1].body.events[0].details as Record<string, number>;
    // Six, not three. Three means the tally taken before the fetch was thrown
    // away with the batch that failed to carry it.
    expect(details.lost_events).toBe(6);
  });

  it('carries an earlier tally forward when the fetch throws', async () => {
    await failThreeThenThree(
      () => {
        throwOnFetch = true;
      },
      () => {
        throwOnFetch = false;
      },
    );
    const details = posted[posted.length - 1].body.events[0].details as Record<string, number>;
    expect(details.lost_events).toBe(6);
  });

  it('reports lost_events on ONE event, not stamped on every one', async () => {
    installTelemetry(token('A'));
    capture('error', 'client_error', 'alpha');
    throwOnFetch = true;
    await flush();
    throwOnFetch = false;

    for (let i = 0; i < 4; i++) capture('error', 'client_error', `later problem ${i} here`);
    await flush();
    const withLost = posted[0].body.events.filter(
      (e) => (e.details as Record<string, unknown>).lost_events !== undefined,
    );
    // Stamped on every event, a sum over the batch multiplies it by the batch
    // size — a made-up number in the field whose entire job is to be honest.
    expect(withLost).toHaveLength(1);
  });
});

describe('one athlete’s events must never be sent under another’s token', () => {
  it('drops the buffer on sign-out', async () => {
    installTelemetry(token('A-token'));
    capture('error', 'client_error', 'A had a problem');

    clearTelemetryForSignOut();
    installTelemetry(token('B-token'));
    await flush();

    // Nothing at all should go: A's event is gone, and B has nothing yet.
    expect(posted).toHaveLength(0);
  });

  it('sends B’s own events under B’s token', async () => {
    installTelemetry(token('A-token'));
    capture('error', 'client_error', 'A had a problem');
    clearTelemetryForSignOut();
    installTelemetry(token('B-token'));

    capture('error', 'client_error', 'B had a different problem');
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].token).toBe('Bearer B-token');
    expect(posted[0].body.events[0].message).toContain('B had');
  });

  it('sends nothing at all when there is no token', async () => {
    installTelemetry(async () => null);
    capture('error', 'client_error', 'boom');
    await flush();
    expect(posted).toHaveLength(0);
  });
});

describe('the global handler observes, it does not intercept', () => {
  it('always calls the previous handler', () => {
    const seen: unknown[] = [];
    const g = globalThis as unknown as { ErrorUtils?: unknown };
    let current: (e: unknown, isFatal?: boolean) => void = (e) => {
      seen.push(e);
    };
    g.ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: (e: unknown, f?: boolean) => void) => {
        current = h;
      },
    };

    installTelemetry(token('A'));
    const err = new Error('boom');
    current(err);
    expect(seen).toEqual([err]);
  });

  it('still calls the previous handler when describing the error throws', () => {
    const seen: unknown[] = [];
    const g = globalThis as unknown as { ErrorUtils?: unknown };
    let current: (e: unknown, isFatal?: boolean) => void = (e) => {
      seen.push(e);
    };
    g.ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: (e: unknown, f?: boolean) => void) => {
        current = h;
      },
    };
    installTelemetry(token('A'));

    // An Error whose `message` getter throws. `describe` runs as an ARGUMENT,
    // outside `capture`'s own try/catch, so before the `finally` this skipped
    // the chain — swallowing the red box in development and the runtime's
    // fatal handling in production, for exactly the strange errors most worth
    // seeing.
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(() => current(hostile)).not.toThrow();
    // Identity, not deep equality: `toEqual` walks the object and would touch
    // the very getter that throws, failing the test for the test's own reason
    // rather than the code's.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(hostile);
  });

  it('installs only once even if called again', () => {
    let installs = 0;
    const g = globalThis as unknown as { ErrorUtils?: unknown };
    let current: (e?: unknown, isFatal?: boolean) => void = () => {};
    g.ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: () => void) => {
        installs += 1;
        current = h;
      },
    };
    installTelemetry(token('A'));
    installTelemetry(token('A'));
    installTelemetry(token('A'));
    // Stacked wrappers would capture every error two and three times, and the
    // counts this feature exists to report would be wrong.
    expect(installs).toBe(1);
  });
});

describe('rejection tracking is either live or says it is not', () => {
  it('reports its own state rather than leaving it unknown', () => {
    installTelemetry(token('A'));
    // The first version hooked `addEventListener('unhandledrejection')`, which
    // React Native does not have — so it installed nothing, silently, and the
    // half of the feature that matters most did not exist. Whatever the answer
    // is here, it is an answer: a `false` buffers a `client_error` saying so.
    expect(typeof rejectionTrackingActive()).toBe('boolean');
  });
});

describe('nothing here may throw into a caller', () => {
  it('survives a capture with hostile input', () => {
    installTelemetry(token('A'));
    expect(() => capture('error', 'client_error', undefined as unknown as string)).not.toThrow();
  });

  it('survives a flush with no telemetry installed', async () => {
    await expect(flush()).resolves.toBeUndefined();
  });
});

describe('privacy', () => {
  it('scrubs quoted content out of the outbound message', async () => {
    installTelemetry(token('A'));
    capture('error', 'client_error', 'failed to save "felt awful, shoulder again"');
    await flush();
    const message = String(posted[0].body.events[0].message);
    // `redact` guards details; the message had no guard at all, and app code
    // interpolating athlete content into a thrown error would ship prose on
    // the crash path, unprompted.
    expect(message).not.toContain('shoulder');
    expect(message).toContain('<str>');
  });

  it('drops detail keys that are not allowlisted', async () => {
    installTelemetry(token('A'));
    capture('error', 'client_error', 'boom', { code: 'x', notes: 'private prose' });
    await flush();
    const details = posted[0].body.events[0].details as Record<string, unknown>;
    expect(details.code).toBe('x');
    expect(details.notes).toBeUndefined();
  });
});
