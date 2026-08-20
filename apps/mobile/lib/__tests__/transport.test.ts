/**
 * The transport's error taxonomy (N55).
 *
 * ## What this suite is defending
 *
 * `netFetch` used to convert every `fetch` rejection except an abort into
 * `OfflineError`. An athlete with four bars was told *"Try again when you have
 * signal"* while a photo upload was being dropped for its size, and no screen
 * could tell the two apart because by the time any of them saw it, a dead
 * radio and a dropped upload were the same object.
 *
 * So **every test here is written to fail if its branch is folded back into
 * `OfflineError`**, which is the mutation that recreates the bug. That is the
 * property worth having; asserting "a rejection produces some error" would
 * pass against the code this replaces.
 *
 * ## What the stubs here can and cannot prove
 *
 * These stubs are honest about a `Promise` contract — `fetch` either resolves
 * with a `Response` or rejects — and that half is safe to stub. What they
 * cannot establish is **which real-world cause produces which rejection**,
 * because React Native does not tell JS: the native error string that would
 * separate "offline" from "an SSL error occurred" is dropped before it reaches
 * `fetch` (measured; see `authedFetch.ts`). That is exactly why the code under
 * test does not classify by inspecting the error, and why these tests do not
 * pretend to know what `TypeError('Network request failed')` meant. The one
 * string that IS matched, `'Network request timed out'`, is `whatwg-fetch`'s
 * own literal, taken from the installed module and reproduced by driving RN's
 * real `XMLHttpRequest` with the payload iOS sends.
 */

import {
  OfflineError,
  RequestDroppedError,
  TimeoutError,
  isOffline,
  isTransportFailure,
  transportDiagnosis,
} from '../apiError';
import { API_BASE, netFetch, resetReachabilityCache } from '../authedFetch';

const realFetch = global.fetch;

/** Every probe the transport made, by URL. */
let probes: string[];
/** Every non-probe request. */
let calls: string[];

type Responder = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Stand in for the network.
 *
 * `probe` is answered separately from `request` because the whole design turns
 * on asking VOLA a second question after the first one failed — a stub that
 * answered both alike could not tell the two classifications apart.
 */
function stubNetwork(opts: { request: Responder; probe?: Responder }) {
  global.fetch = jest.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `${API_BASE}/healthz`) {
      probes.push(url);
      if (!opts.probe) throw new TypeError('Network request failed');
      return opts.probe(url, init);
    }
    calls.push(url);
    return opts.request(url, init);
  }) as unknown as typeof fetch;
}

const response = (status = 200) => ({ status, ok: status < 400 }) as Response;

/** An `AbortError` shaped the way `whatwg-fetch` raises one. */
function abortError(): Error {
  // It throws a `DOMException('Aborted', 'AbortError')`; what the code under
  // test reads is the name, and `DOMException` is not reliably a global here.
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A `fetch` that answers nothing until it is aborted.
 *
 * **It has to honour the signal**, and the first version of it did not — every
 * deadline test then hung for the full jest timeout rather than measuring
 * anything, which is how the omission was caught. Real `fetch` does honour it:
 * `whatwg-fetch@3.6.20` registers `signal.addEventListener('abort', abortXhr)`
 * and its `xhr.onabort` rejects with `AbortError`. A stub that swallowed the
 * abort would be asserting against a `fetch` that does not exist.
 */
const hangs: Responder = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(abortError()));
  });

/**
 * A request that succeeds after `ms`, unless it is aborted first.
 *
 * **It has to honour the signal for the same reason `hangs` does**, and this
 * one was caught by mutation rather than by a hanging test: with a stub that
 * ignored the abort, replacing the whole deadline with a hardcoded 30ms
 * changed nothing observable, because the stub resolved on its own timer no
 * matter what the transport did. The deadline tests were measuring the stub.
 */
const slow =
  (ms: number): Responder =>
  (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(200)), ms);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortError());
      });
    });

beforeEach(() => {
  probes = [];
  calls = [];
  resetReachabilityCache();
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('a request that gets an answer', () => {
  it('passes the response through, whatever the status', async () => {
    stubNetwork({ request: async () => response(503) });
    const res = await netFetch('https://api.test/v1/nutrition/estimate');
    expect(res.status).toBe(503);
    // A status is an answer. Classifying it is the caller's job, and asking
    // whether the network is up would be absurd — we just heard from it.
    expect(probes).toHaveLength(0);
  });
});

describe('no route to the API', () => {
  it('is OfflineError when the probe cannot reach VOLA either', async () => {
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      // No probe responder: the probe fails too.
    });

    await expect(netFetch('https://api.test/v1/exercises')).rejects.toBeInstanceOf(OfflineError);
    expect(probes).toHaveLength(1);
  });

  it('says so without claiming the athlete has been signed out', async () => {
    // The clause this project will not give up: Clerk returns null offline,
    // and nine modules once read that as "Not signed in."
    expect(new OfflineError().message).toContain('still signed in');
  });
});

describe('a request that failed while VOLA was reachable', () => {
  it('is RequestDroppedError, not OfflineError', async () => {
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: async () => response(200),
    });

    const err = await netFetch('https://api.test/v1/nutrition/estimate', {
      method: 'POST',
      body: 'a-big-photo',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RequestDroppedError);
    // The assertion that carries the bug report: this athlete must never be
    // sent to look for signal.
    expect(isOffline(err)).toBe(false);
    expect(err.message).not.toMatch(/signal/i);
  });

  it('counts any answer as reachable, including a 500', async () => {
    // The probe asks whether packets reach VOLA, not whether VOLA is well. A
    // 500 came back, so there is a route — and a request that failed against a
    // reachable host did not fail for want of a network.
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: async () => response(500),
    });

    await expect(netFetch('https://api.test/v1/exercises')).rejects.toBeInstanceOf(
      RequestDroppedError,
    );
  });

  it('probes the API the app talks to, not the failed URL', async () => {
    // `body.ts` uploads to Cloudflare through this same function. The question
    // worth answering there is still "does this phone reach VOLA".
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: async () => response(200),
    });

    await netFetch('https://uploads.cloudflare.test/put').catch(() => {});
    expect(probes).toEqual([`${API_BASE}/healthz`]);
  });
});

describe('a timeout', () => {
  it('is TimeoutError when our own deadline fires', async () => {
    stubNetwork({ request: hangs, probe: async () => response(200) });

    const err = await netFetch('https://api.test/v1/exercises', {}, { timeoutMs: 20 }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(TimeoutError);
    // Not an AbortError leaking out, which is what the deadline actually
    // raises underneath.
    expect(err.name).toBe('TimeoutError');
    // And no probe: we know why this failed, we caused it.
    expect(probes).toHaveLength(0);
  });

  it('is TimeoutError when the runtime reports its own', async () => {
    // whatwg-fetch@3.6.20's literal, reached from RN's `timeout` event, which
    // iOS raises only for kCFURLErrorTimedOut.
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request timed out');
      },
      probe: async () => response(200),
    });

    await expect(netFetch('https://api.test/v1/exercises')).rejects.toBeInstanceOf(TimeoutError);
    expect(probes).toHaveLength(0);
  });

  it('does not fire before its deadline', async () => {
    // Guards the direction a too-eager deadline would break: a slow request
    // that would have succeeded.
    stubNetwork({ request: slow(30) });
    const res = await netFetch('https://api.test/v1/exercises', {}, { timeoutMs: 500 });
    expect(res.status).toBe(200);
  });

  it('honours a longer deadline for an upload', async () => {
    // The upload routes ask for more time than a JSON read. If the override
    // were ignored, a photo estimate would be cut off at the default.
    // 300ms is comfortably over any default a mutation could hardcode in place
    // of the override, and comfortably under the real one.
    stubNetwork({ request: slow(300) });
    const res = await netFetch('https://api.test/v1/nutrition/estimate', {}, { timeoutMs: 3_000 });
    expect(res.status).toBe(200);
  });
});

describe("the caller's own cancellation", () => {
  it('is rethrown untouched, not turned into a network failure', async () => {
    // A superseded search or an unmounted screen is not a connectivity
    // problem, and screens return early on it.
    const controller = new AbortController();
    stubNetwork({ request: hangs, probe: async () => response(200) });

    const pending = netFetch('https://api.test/v1/exercises', { signal: controller.signal });
    controller.abort();

    const err = await pending.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(isTransportFailure(err)).toBe(false);
    expect(probes).toHaveLength(0);
  });

  it('wins even when the deadline has also fired', async () => {
    // Both conditions true at once, forced rather than raced: the caller
    // cancels immediately, the deadline fires at 5ms, and the underlying
    // request does not reject until 40ms — so by the time the classification
    // runs, `caller.aborted` and `deadlineFired` are both true.
    //
    // This is the test for the ORDER of those two checks. Swap them and it
    // goes red with `TimeoutError`, which is a timeout reported for a screen
    // the athlete had already left.
    const controller = new AbortController();
    stubNetwork({
      request: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            setTimeout(() => reject(abortError()), 40);
          });
        }),
    });

    const pending = netFetch(
      'https://api.test/v1/exercises',
      { signal: controller.signal },
      { timeoutMs: 5 },
    );
    controller.abort();

    const err = await pending.catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('is never converted, even with no caller signal to attribute it to', async () => {
    // The defensive branch: an `AbortError` that is neither our deadline nor a
    // signal the caller handed us. Nothing in `whatwg-fetch` raises one today,
    // which is exactly why it needs its own test — without it the guard looks
    // like dead code, and "the tests still pass without it" is a persuasive
    // argument for deleting something that keeps a cancellation from being
    // reported to an athlete as a network failure.
    stubNetwork({
      request: async () => {
        throw abortError();
      },
      probe: async () => response(200),
    });

    const err = await netFetch('https://api.test/v1/exercises').catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(isTransportFailure(err)).toBe(false);
    expect(probes).toHaveLength(0);
  });

  it('is honoured when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    stubNetwork({
      request: async () => {
        throw abortError();
      },
    });

    const err = await netFetch('https://api.test/v1/x', { signal: controller.signal }).catch(
      (e) => e,
    );
    expect(err.name).toBe('AbortError');
  });
});

describe('the reachability probe', () => {
  it('is asked once for a burst of failures, not once per row', async () => {
    // The outbox drains row by row. Without this, one outage means one probe
    // per pending activity.
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: async () => response(200),
    });

    await Promise.all(
      [1, 2, 3, 4].map((n) => netFetch(`https://api.test/v1/activities/${n}`).catch((e) => e)),
    );

    expect(calls).toHaveLength(4);
    expect(probes).toHaveLength(1);
  });

  it('classifies every request in that burst, not just the one that probed', async () => {
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: async () => response(200),
    });

    const errs = await Promise.all(
      [1, 2, 3].map((n) => netFetch(`https://api.test/v1/activities/${n}`).catch((e) => e)),
    );

    for (const err of errs) expect(err).toBeInstanceOf(RequestDroppedError);
  });

  it('cannot hang the classification forever', async () => {
    // A probe that never answers must not leave the original failure
    // unreported — the athlete would be looking at a spinner over a request
    // that is already dead.
    stubNetwork({
      request: async () => {
        throw new TypeError('Network request failed');
      },
      probe: hangs,
    });

    const err = await netFetch('https://api.test/v1/exercises').catch((e) => e);
    expect(err).toBeInstanceOf(OfflineError);
  }, 10_000);
});

describe('the family the sentinels belong to', () => {
  it('reads as one failure to callers that only mean "I could not ask"', () => {
    // Four modules degrade to the outbox on this. Before N55 every dead
    // request WAS an OfflineError, so all three have to keep answering true or
    // a timeout starts surfacing as a hard error where it used to be quiet.
    for (const err of [new OfflineError(), new TimeoutError(), new RequestDroppedError()]) {
      expect(isTransportFailure(err)).toBe(true);
    }
    expect(isTransportFailure(new Error('nope'))).toBe(false);
  });

  it('keeps them distinguishable from each other', () => {
    // The mutation this whole suite exists to catch: collapsing two of these
    // into one class.
    const messages = [
      new OfflineError().message,
      new TimeoutError().message,
      new RequestDroppedError().message,
    ];
    expect(new Set(messages).size).toBe(3);

    expect(isOffline(new OfflineError())).toBe(true);
    expect(isOffline(new TimeoutError())).toBe(false);
    expect(isOffline(new RequestDroppedError())).toBe(false);
  });

  it('offers a diagnosis a screen can pair with its own action', () => {
    // What keeps the wording central while the actions stay local.
    const diagnosis = transportDiagnosis(new TimeoutError());
    expect(diagnosis).toBe('VOLA took too long to answer.');
    // The message is the diagnosis plus a default action, so a screen that
    // appends its own is not repeating the description.
    expect(new TimeoutError().message.startsWith(diagnosis as string)).toBe(true);
    expect(transportDiagnosis(new Error('server said no'))).toBeNull();
  });

  it('says none of them is about the athlete being signed out', () => {
    for (const err of [new OfflineError(), new TimeoutError(), new RequestDroppedError()]) {
      expect(err.message).not.toMatch(/sign in|signed out/i);
    }
  });

  it('keeps the copy to one line and an action', () => {
    // The athlete's verdict on the old three-sentence version was "the error
    // itself is ugly", read one-handed over a plate.
    for (const err of [new OfflineError(), new TimeoutError(), new RequestDroppedError()]) {
      expect(err.message.length).toBeLessThanOrEqual(70);
    }
  });
});
