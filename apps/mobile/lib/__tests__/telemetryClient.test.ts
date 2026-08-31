import {
  capture,
  clearTelemetryForSignOut,
  flush,
  installTelemetry,
  resetTelemetry,
  setRejectionSelfTestTimeoutMsForTests,
} from '../telemetryClient';

/**
 * Every `installTelemetry` call in this file makes the self-test deliberately
 * reject a promise nobody catches — and the REAL
 * `promise/setimmediate/rejection-tracking` schedules a `setTimeout` per
 * rejection it is asked to watch (up to 2000ms for a non-whitelisted error,
 * which our marker always is) that nothing ever explicitly clears. Left
 * un-mocked, every one of the many unrelated tests below that just happen to
 * call `installTelemetry` would each leak one of those, and Jest warns about
 * exactly that at the end of the run.
 *
 * So this file mocks `enable`/`disable` to no-ops by default — which, because
 * the underlying package's own `Promise._C` hook is `null` until `enable()`
 * actually sets it (see `promise/setimmediate/core.js`), makes the self-test's
 * rejection a completely inert operation for every test that does not care
 * about rejection tracking. The two tests that DO care load the REAL,
 * unmocked package via `jest.requireActual` — this project's own rule is to
 * verify an external contract against the real thing at least once, and a
 * mock built from an assumption about the library's own scheduling could not
 * falsify that assumption.
 */
jest.mock('promise/setimmediate/rejection-tracking', () => ({
  enable: jest.fn(),
  disable: jest.fn(),
}));

// The production self-test window is a real 3s wall-clock wait (see
// telemetryClient.ts) — long enough to clear the underlying tracker's own
// worst-case scheduling delay. Every test below that calls `installTelemetry`
// would otherwise carry that wait for real, whether or not it reads
// `rejectionTrackingActive()`. Shrunk once, for the whole file.
setRejectionSelfTestTimeoutMsForTests(20);

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

describe('rejection tracking proves delivery, not just that enable() returned', () => {
  /**
   * The bug this replaces (#463): the old flag went `true` the instant
   * `enable()` returned without throwing. On Hermes — this app's engine on
   * every platform it ships to — that call patches a Promise class
   * `globalThis.Promise` is not, so it always returned cleanly while
   * observing nothing. `enable()` not throwing is exactly what every test
   * below refuses to treat as an answer.
   *
   * The first two tests run against the REAL `promise/setimmediate/rejection-
   * tracking` package — deliberately not a hand-rolled stand-in, and not the
   * file's default no-op mock above (`jest.requireActual` steps around it).
   * This project's own standing rule ("verify an external contract against
   * the real service at least once") applies here precisely because a mock
   * built from an assumption about how the library schedules `onUnhandled`
   * cannot falsify that assumption; only the real package can. The two tests
   * differ only in how long they give it to report: long enough to clear its
   * internal delay, or deliberately not. Each loads `telemetryClient` fresh
   * via `jest.resetModules()`, so its self-test state is its own and this
   * describe block's real (unmocked) tracking module never leaks into the
   * rest of the file's tests, which keep using the top-level, still-mocked
   * import.
   */
  const TRACKING_MODULE = 'promise/setimmediate/rejection-tracking';

  /**
   * `telemetryClient` requires this module LAZILY, inside
   * `installRejectionTracking`, on every call — by design (see that
   * function's doc comment). So the file-level no-op mock above is not a
   * one-time binding baked into the top-level `installTelemetry` import: it
   * is whatever this module resolves to at the moment of the NEXT call,
   * including calls from tests in describe blocks below this one. Restoring
   * the no-op explicitly (rather than `jest.dontMock`, which would leave the
   * REAL package active for everything that runs afterward) is what keeps
   * that true.
   */
  function restoreNoOpTracking(): void {
    jest.doMock(TRACKING_MODULE, () => ({ enable: jest.fn(), disable: jest.fn() }));
    jest.resetModules();
  }

  function loadWithRealTracking(): typeof import('../telemetryClient') {
    jest.doMock(TRACKING_MODULE, () => jest.requireActual(TRACKING_MODULE));
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../telemetryClient') as typeof import('../telemetryClient');
  }

  afterEach(() => {
    restoreNoOpTracking();
  });

  it('reports active once the real tracker actually observes its own rejection', async () => {
    const mod = loadWithRealTracking();
    try {
      // `promise/setimmediate/rejection-tracking` schedules `onUnhandled` at
      // 100ms for TypeError/RangeError/ReferenceError and 2000ms for anything
      // else (see its source) — our marker is a plain object, so it is the
      // slow path. This window has to clear that with margin, which is also
      // why it is not the file's default: every OTHER test in this file
      // would otherwise carry the same wait for a result it never reads.
      mod.setRejectionSelfTestTimeoutMsForTests(2300);
      mod.installTelemetry(token('A'));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(mod.rejectionTrackingActive()).toBe(true);
    } finally {
      mod.resetTelemetry();
    }
  }, 10_000);

  it('reports inactive, and says why, before the real tracker has had time to report', async () => {
    const mod = loadWithRealTracking();
    const localPosted: { body: { events: Record<string, unknown>[] } }[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      localPosted.push({ body: JSON.parse(String(init.body)) });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;

    try {
      // The file's default 20ms window is far short of the real package's
      // 2000ms worst-case delay above — so checking this early is, itself,
      // the failure mode the OLD flag could not see: the require succeeded
      // and `enable()` returned cleanly, and delivery still has not been
      // proven.
      mod.setRejectionSelfTestTimeoutMsForTests(20);
      mod.installTelemetry(token('A'));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mod.rejectionTrackingActive()).toBe(false);

      await mod.flush();
      const messages = localPosted.flatMap((p) => p.body.events.map((e) => e.message));
      // Distinct from the require-throws message in the next test, on
      // purpose — the two failure modes have to read apart in
      // `health_events`.
      expect(messages).toContain('telemetry: rejection tracking installed but not delivering');
    } finally {
      // The real package's own ~2000ms internal timer for THIS install is
      // still pending at this point — `resetTelemetry` clears our own timer
      // but has no handle on the third-party library's. Letting it finish
      // rather than abandoning it is what keeps this file from leaking a
      // background timer past the end of the run.
      await new Promise((resolve) => setTimeout(resolve, 2300));
      globalThis.fetch = savedFetch;
      mod.resetTelemetry();
    }
  }, 10_000);

  it('still reports a boolean, and buffers a DIFFERENT message, when the require itself throws', async () => {
    jest.doMock('promise/setimmediate/rejection-tracking', () => {
      throw new Error('module moved');
    });
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../telemetryClient') as typeof import('../telemetryClient');

    const localPosted: { body: { events: Record<string, unknown>[] } }[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      localPosted.push({ body: JSON.parse(String(init.body)) });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;

    try {
      mod.installTelemetry(token('A'));
      expect(mod.rejectionTrackingActive()).toBe(false);

      await mod.flush();
      const messages = localPosted.flatMap((p) => p.body.events.map((e) => e.message));
      expect(messages).toContain('telemetry: rejection tracking unavailable');
    } finally {
      globalThis.fetch = savedFetch;
      mod.resetTelemetry();
      // The describe-level `afterEach` restores the shared no-op mock.
    }
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
