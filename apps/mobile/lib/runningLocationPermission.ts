/**
 * Foreground location permission acquisition for a live GPS run (N460/#771),
 * pulled out of `app/running/[id].tsx`'s mount effect as a pure function
 * (N486/#841) — no React, no `expo-location` import, the same shape as
 * `runningAutoPause.ts` and for the same reason: what broke here was NOT the
 * permission logic's happy path (that was always correct — check current
 * status, request only when `canAskAgain`, never re-prompt once denied
 * outright), it was the effect's memory of "have I already asked this
 * mount", which lived nowhere and is exactly the kind of state a fixture
 * test over plain data can pin without a device, a Simulator, or a rendered
 * component at all.
 *
 * ## The bug (N486/#841): the request had no per-mount latch
 *
 * `app/running/[id].tsx`'s mount effect called `expo-location`'s two
 * functions directly, trusting the OS's own `canAskAgain` flag as the only
 * guard against asking twice:
 *
 * ```
 * const perm = await Location.getForegroundPermissionsAsync();
 * if (!perm.granted && perm.canAskAgain) {
 *   await Location.requestForegroundPermissionsAsync();
 * }
 * ```
 *
 * That is correct against a SINGLE call. It is not correct against a SECOND
 * call landing before the first has resolved, or before the OS's own
 * authorization store has flushed the first call's answer — and this
 * codebase already has two comments (`components/nutrition/MacroDonut.tsx`,
 * `lib/useTodayBoard.ts`) recording that React's Strict Mode double-invokes
 * an effect's mount (mount → cleanup → mount again, same hook state, same
 * refs) in development, which is exactly the environment a freshly built
 * dev-client install runs in. Two effect invocations racing the same two
 * `await`s is indistinguishable, from either invocation's own point of view,
 * from a single well-behaved call — each one independently sees
 * `canAskAgain: true` (the first call's answer has not landed yet) and each
 * one calls `requestForegroundPermissionsAsync()`, so the system queues a
 * second alert directly behind the first regardless of what the athlete
 * tapped on it. Nothing about that requires a running screen to be reopened
 * or a second tap — it reproduces from the ordinary act of the effect firing
 * more than once for the SAME mount, which is precisely the "effect whose
 * dependency array re-fires the request every render" and "a permission-
 * check ref that never gets set after the first request" shapes the ticket
 * named as the likely mechanism.
 *
 * ## The fix: a latch this app owns, not the OS's own async state
 *
 * `acquireLocationPermissionOnce` takes a `PermissionLatch` — one created
 * per screen mount (`useRef(freshPermissionLatch())` in the component) — and
 * sets `latch.requested = true` SYNCHRONOUSLY, before the first `await`. A
 * second call on the SAME latch (whether from a genuine re-render, a Strict
 * Mode double-invoke, or two callers racing) sees `requested: true`
 * immediately and never reaches `requestForegroundPermissionsAsync` again —
 * it answers from a fresh `getForegroundPermissionsAsync` read instead, so a
 * second caller still gets an honest answer rather than silently doing
 * nothing. Because the flag flips before anything is awaited, this holds
 * even when both calls are issued back-to-back with neither having yielded
 * yet (`runningLocationPermission.test.ts`'s "two overlapping calls on one
 * latch" case pins exactly this, via `Promise.all` rather than two separate
 * `await`s, which is what makes it capable of catching a version of this
 * function that set the flag AFTER the first await instead of before).
 */

/** The subset of `expo-location`'s module this function calls — narrowed to
 *  the two functions it actually uses, the same "narrow to what's called"
 *  shape `lib/healthkit.ts`'s `HealthKitModule` type uses for its own native
 *  boundary. Lets a test pass a plain object with two `jest.fn()`s instead
 *  of mocking the whole `expo-location` package. */
export type LocationPermissionAPI = {
  getForegroundPermissionsAsync: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
  requestForegroundPermissionsAsync: () => Promise<{ granted: boolean }>;
};

/** One screen mount's memory of "have I already asked". Plain data, not a
 *  `useRef` itself, so this file never imports React — the component holds
 *  one of these in a ref and passes it in. */
export type PermissionLatch = { requested: boolean };

/** A fresh latch for a new mount. Call once per `useRef` initializer. */
export function freshPermissionLatch(): PermissionLatch {
  return { requested: false };
}

/**
 * Resolve whether this screen currently has foreground location permission,
 * asking the OS at most once per `latch` — see this file's doc comment for
 * the bug this guards against.
 *
 * - Already granted: returns `true` without ever calling `request`.
 * - Not granted, `canAskAgain` false (already permanently denied): returns
 *   `false` without calling `request` — unchanged from the effect's original
 *   behaviour, and still the right answer: asking again would do nothing but
 *   burn a native round trip, since iOS itself won't show a dialog either.
 * - Not granted, `canAskAgain` true, and this is the FIRST call on this
 *   latch: asks once, returns whatever the athlete decided.
 * - Any call after the first on the SAME latch: never asks again — reads
 *   current status fresh and returns that, honestly reflecting whatever the
 *   first call's request already resolved to (or is still resolving to, in
 *   which case this reads the pre-request status, which is the same
 *   "undetermined → treated as not granted yet" answer the caller would get
 *   from checking a moment later).
 */
export async function acquireLocationPermissionOnce(
  latch: PermissionLatch,
  api: LocationPermissionAPI,
): Promise<{ granted: boolean }> {
  if (latch.requested) {
    const perm = await api.getForegroundPermissionsAsync();
    return { granted: perm.granted };
  }

  // Set BEFORE the first `await`, deliberately — see this file's doc
  // comment on why the ordering, not merely the flag's existence, is what
  // makes this safe against two overlapping calls on the same latch.
  latch.requested = true;

  const perm = await api.getForegroundPermissionsAsync();
  if (perm.granted) return { granted: true };
  if (!perm.canAskAgain) return { granted: false };

  const requested = await api.requestForegroundPermissionsAsync();
  return { granted: requested.granted };
}
