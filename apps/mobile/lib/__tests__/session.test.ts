import * as SecureStore from 'expo-secure-store';

import { OfflineError } from '../apiError';
import { clearSessionToken, getSessionToken } from '../session';

/**
 * The Clerk token broker.
 *
 * The property that matters most — "a still-valid token keeps working when
 * Clerk is unreachable" — is easy to test *vacuously*. The first version of
 * this used a 300-second token, which the broker answers from cache without
 * ever consulting Clerk, so the offline path never ran and deleting the whole
 * feature left the suite green. Every test below that claims to exercise a
 * refresh asserts the getter was actually reached.
 */

/**
 * The stand-in keychain, held on `globalThis`.
 *
 * NOT inside the mock factory: `jest.resetModules()` re-runs that factory, so
 * a handle captured at import time would point at a Map the module under test
 * no longer uses — which is what made the first version of the cold-start
 * tests fail confusingly. `globalThis` survives the registry reset.
 */
const keychain: Map<string, string> = ((globalThis as Record<string, unknown>).__keychain ??=
  new Map<string, string>()) as Map<string, string>;

jest.mock('expo-secure-store', () => {
  const mem = (globalThis as Record<string, unknown>).__keychain as Map<string, string>;
  return {
    getItemAsync: jest.fn(async (k: string) => mem.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void mem.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void mem.delete(k)),
  };
});

const STORE_KEY = 'vola.session.token';

/**
 * A genuinely cold module, with the keychain pre-seeded.
 *
 * `clearSessionToken()` — which every other test uses to reset — sets
 * `restorePromise` to a resolved promise and nothing ever nulls it. That is
 * correct for the app (it stops a later caller re-reading a keychain we just
 * emptied) but it means `restore()`'s body never runs under the normal reset,
 * so the whole persistence half of the broker was **structurally untestable**
 * and four mutations survived: the keychain cross-user check, the
 * expired-stored-token guard, `persist()`, and `clearSessionToken`'s own
 * keychain delete.
 *
 * Resetting the module registry is the only way to get a real cold start.
 */
/**
 * `instanceof` is the wrong check across a module reset.
 *
 * `jest.resetModules()` gives the freshly-required `session` module its own
 * `apiError` too, so the `OfflineError` it throws is a *different class
 * object* from the one this file imported — producing the memorable
 * "Expected constructor: OfflineError / Received constructor: OfflineError".
 * The name is the stable identity across registries.
 */
async function expectOffline(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ name: 'OfflineError' });
}

function coldStart(stored?: string): typeof import('../session') {
  keychain.clear();
  if (stored) keychain.set(STORE_KEY, stored);
  jest.resetModules();
  // `require`, not a dynamic `import()`: jest transforms to CJS, and a real
  // dynamic import needs --experimental-vm-modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../session') as typeof import('../session');
}

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A structurally real JWT for `sub`, expiring in `secs`. */
const jwt = (sub: string, secs: number) =>
  `eyJhbGciOiJSUzI1NiJ9.${b64url({ sub, exp: Math.floor(Date.now() / 1000) + secs })}.sig`;

/**
 * REFRESH_SKEW_MS is 20s, so a 10s token is inside the skew (a refresh is
 * attempted) but not yet expired (the old one is still a valid credential).
 * That window is the only place the offline-grace branch runs.
 */
const EXPIRING = 10;
const FRESH = 300;

beforeEach(async () => {
  await clearSessionToken();
  (SecureStore.getItemAsync as jest.Mock).mockClear();
});

it('costs one Clerk call for many requests', async () => {
  const clerk = jest.fn(async () => jwt('user_1', FRESH));
  for (let i = 0; i < 40; i++) await getSessionToken(clerk, 'user_1');
  expect(clerk).toHaveBeenCalledTimes(1);
});

it('collapses concurrent cold requests into one refresh', async () => {
  const clerk = jest.fn(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return jwt('user_1', FRESH);
  });
  await Promise.all(Array.from({ length: 8 }, () => getSessionToken(clerk, 'user_1')));
  expect(clerk).toHaveBeenCalledTimes(1);
});

describe('when Clerk is unreachable', () => {
  it('keeps serving a token that is expiring but still valid', async () => {
    const acquired = await getSessionToken(async () => jwt('user_1', EXPIRING), 'user_1');
    // Clerk RETURNS NULL offline rather than throwing — verified in clerk-js.
    const offline = jest.fn(async () => null);

    const served = await getSessionToken(offline, 'user_1');

    // Guards against the vacuous version of this test.
    expect(offline).toHaveBeenCalledTimes(1);
    expect(served).toBe(acquired);
  });

  it('also survives Clerk throwing rather than returning null', async () => {
    const acquired = await getSessionToken(async () => jwt('user_1', EXPIRING), 'user_1');
    const offline = jest.fn(async () => {
      throw new Error('Network request failed');
    });
    expect(await getSessionToken(offline, 'user_1')).toBe(acquired);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('reports OfflineError when there is no usable token at all', async () => {
    await expect(getSessionToken(async () => null, 'user_1')).rejects.toBeInstanceOf(OfflineError);
  });

  it('never claims the athlete is signed out', async () => {
    await expect(getSessionToken(async () => null, 'user_1')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/not signed in/i) }),
    );
  });

  it('refuses an expired token rather than sending one that will 401', async () => {
    await getSessionToken(async () => jwt('user_1', -10), 'user_1').catch(() => {});
    await expect(getSessionToken(async () => null, 'user_1')).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('shared device', () => {
  it("refuses athlete A's cached token for athlete B", async () => {
    await getSessionToken(async () => jwt('user_A', FRESH), 'user_A');
    await expect(getSessionToken(async () => null, 'user_B')).rejects.toBeInstanceOf(OfflineError);
  });

  it('does not let a refresh straddling sign-out repopulate the cache', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = getSessionToken(async () => {
      await slow;
      return jwt('user_A', FRESH);
    }, 'user_A');

    await clearSessionToken(); // sign-out lands mid-refresh
    release();
    await inFlight.catch(() => {});

    await expect(getSessionToken(async () => null, 'user_A')).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('cold start from the keychain', () => {
  it('uses a stored token without asking Clerk at all', async () => {
    // The point of persisting: a relaunch in a dead spot can still reach our
    // API until that token genuinely expires.
    const stored = jwt('user_1', FRESH);
    const { getSessionToken: fresh } = coldStart(stored);
    const clerk = jest.fn(async () => null);

    expect(await fresh(clerk, 'user_1')).toBe(stored);
    expect(clerk).not.toHaveBeenCalled();
  });

  it('ignores a stored token that has already expired', async () => {
    // Sending it would earn a 401 that reads as an auth problem rather than
    // a stale cache.
    const { getSessionToken: fresh } = coldStart(jwt('user_1', -10));
    await expectOffline(fresh(async () => null, 'user_1'));
  });

  it("discards a stored token belonging to a different athlete", async () => {
    const { getSessionToken: fresh } = coldStart(jwt('user_A', FRESH));
    await expectOffline(fresh(async () => null, 'user_B'));
    // And removes it, so it can't be offered again.
    expect(keychain.get(STORE_KEY)).toBeUndefined();
  });

  it('persists a freshly minted token for the next cold start', async () => {
    const { getSessionToken: fresh } = coldStart();
    const minted = jwt('user_1', FRESH);
    await fresh(async () => minted, 'user_1');
    expect(keychain.get(STORE_KEY)).toBe(minted);
  });

  it('clears the keychain on sign-out', async () => {
    const { getSessionToken: fresh, clearSessionToken: clear } = coldStart();
    await fresh(async () => jwt('user_1', FRESH), 'user_1');
    expect(keychain.get(STORE_KEY)).toBeDefined();

    await clear();
    expect(keychain.get(STORE_KEY)).toBeUndefined();
  });
});
