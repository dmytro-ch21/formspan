import {
  acquireLocationPermissionOnce,
  freshPermissionLatch,
  type LocationPermissionAPI,
} from '../runningLocationPermission';

/**
 * N486/#841 — the location-permission dialog looping regardless of the
 * choice tapped. Pure functions over a fake `expo-location`-shaped API, no
 * React, no native module — see the file's own doc comment for why this
 * shape was chosen and exactly what bug it pins.
 */

function fakeApi(overrides: Partial<LocationPermissionAPI> = {}): LocationPermissionAPI & {
  getForegroundPermissionsAsync: jest.Mock;
  requestForegroundPermissionsAsync: jest.Mock;
} {
  return {
    getForegroundPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
    requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true })),
    ...overrides,
  } as LocationPermissionAPI & {
    getForegroundPermissionsAsync: jest.Mock;
    requestForegroundPermissionsAsync: jest.Mock;
  };
}

/**
 * A STATEFUL fake, unlike the plain one above: `getForegroundPermissionsAsync`
 * actually reflects whatever `requestForegroundPermissionsAsync` last
 * decided, the way the real OS does. Needed for the "second call reads
 * current status honestly" cases below — a static fake would report
 * `granted: false` forever regardless of what the athlete tapped on the
 * first (and only) real request, which would make those assertions pass or
 * fail for the wrong reason.
 */
function statefulFakeApi(initialGranted: boolean): LocationPermissionAPI & {
  getForegroundPermissionsAsync: jest.Mock;
  requestForegroundPermissionsAsync: jest.Mock;
} {
  let granted = initialGranted;
  return {
    getForegroundPermissionsAsync: jest.fn(async () => ({ granted, canAskAgain: true })),
    requestForegroundPermissionsAsync: jest.fn(async () => {
      granted = true;
      return { granted };
    }),
  };
}

describe('acquireLocationPermissionOnce', () => {
  it('requests when not yet granted and canAskAgain is true', async () => {
    const api = fakeApi();
    const latch = freshPermissionLatch();

    const result = await acquireLocationPermissionOnce(latch, api);

    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ granted: true });
  });

  it('never requests when already granted', async () => {
    const api = fakeApi({
      getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    });
    const latch = freshPermissionLatch();

    const result = await acquireLocationPermissionOnce(latch, api);

    expect(api.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toEqual({ granted: true });
  });

  it('never requests once canAskAgain is false (permanently denied)', async () => {
    const api = fakeApi({
      getForegroundPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
    });
    const latch = freshPermissionLatch();

    const result = await acquireLocationPermissionOnce(latch, api);

    expect(api.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toEqual({ granted: false });
  });

  /**
   * The bug itself: a SECOND call on the same latch — the shape of React
   * Strict Mode's dev-only double-invoke of an effect's mount (this
   * codebase already guards the identical pattern elsewhere: see the
   * comments in `components/nutrition/MacroDonut.tsx` and
   * `lib/useTodayBoard.ts`), or any other cause of the mount effect body
   * running twice — must not ask the OS a second time. Two SEPARATE
   * `await`ed calls, one after the other, so each one fully resolves before
   * the next starts; the overlapping-calls case below is the sharper one.
   */
  it('does not re-request on a second call against the same latch', async () => {
    const api = statefulFakeApi(false);
    const latch = freshPermissionLatch();

    const first = await acquireLocationPermissionOnce(latch, api);
    const second = await acquireLocationPermissionOnce(latch, api);

    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    // The second call still answers honestly from a fresh status read,
    // rather than silently returning nothing — and, because the first
    // call's request already resolved to granted, that fresh read agrees.
    expect(api.getForegroundPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ granted: true });
    expect(second).toEqual({ granted: true });
  });

  /**
   * The sharper version of the same case: two calls issued back-to-back,
   * NEITHER awaited before the second starts — `Promise.all`, not two
   * separate `await`s. This is what actually distinguishes "the latch is
   * set before the first `await`" from "the latch is set after the first
   * `await`" (or not at all): if the flag flipped anywhere other than
   * synchronously at the top of the function, both calls would still see
   * `requested: false` at the moment they each check it, and both would
   * call `requestForegroundPermissionsAsync` — which is exactly the
   * mechanism the ticket describes (a second system alert queued directly
   * behind the first, regardless of what the athlete tapped on it).
   */
  it('only ever issues one request across two overlapping calls on one latch', async () => {
    const api = fakeApi();
    const latch = freshPermissionLatch();

    const [first, second] = await Promise.all([
      acquireLocationPermissionOnce(latch, api),
      acquireLocationPermissionOnce(latch, api),
    ]);

    // The one guarantee this test exists for: however many callers land on
    // the same latch before either has resolved, the OS is asked AT MOST
    // ONCE — which is exactly the "second system alert queued directly
    // behind the first" bug this fixes. (The second caller's own answer can
    // legitimately be a beat behind the first's — it read status before the
    // first caller's request had resolved, the same honest staleness a real
    // concurrent status check would have — so this does not assert a value
    // for it, only that no second `request` call happened.)
    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(first.granted).toBe(true);
    expect(typeof second.granted).toBe('boolean');
  });

  it('a fresh latch for a new mount asks again, independently of an old one', async () => {
    const api = fakeApi();
    const oldLatch = freshPermissionLatch();
    await acquireLocationPermissionOnce(oldLatch, api);
    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);

    const newLatch = freshPermissionLatch();
    await acquireLocationPermissionOnce(newLatch, api);
    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(2);
  });
});
