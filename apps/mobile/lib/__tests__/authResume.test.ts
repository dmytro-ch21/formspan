import { AppState } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { RESUME_GRACE_MS, useResumeSignOutGuard } from '../authResume';

/**
 * N190 / issue #607 — "the app signs the athlete out when the phone locks".
 *
 * The bug this guards against is a RACE, not a static value, so a mock that
 * only ever hands `useResumeSignOutGuard` a fixed `isSignedIn` cannot exercise
 * it — every test below drives the actual sequence: a resume event fires,
 * `isSignedIn` transitions, and time passes (or doesn't) in between. See
 * `lib/authResume.ts`'s doc comment for why the resume window exists and why
 * it is scoped as narrowly as it is.
 *
 * The `AppState.addEventListener` spy is the same pattern `sync.test.ts` uses
 * for the identical reason: mocking the whole of `react-native` breaks Expo's
 * global installation and takes other suites down with it.
 */

let handler: ((s: string) => void) | undefined;
let spy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  handler = undefined;
  spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    fn: (s: string) => void,
  ) => {
    handler = fn;
    return { remove: () => void (handler = undefined) };
  }) as never);
});

afterEach(() => {
  spy.mockRestore();
  jest.useRealTimers();
});

const fire = (s: string) => handler!(s);

test('a false reading is confirmed instantly when it is not preceded by a resume', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result, rerender } = renderHook(
    ({ isSignedIn }: { isSignedIn: boolean }) => useResumeSignOutGuard(true, isSignedIn, getToken),
    { initialProps: { isSignedIn: true } },
  );
  expect(result.current).toBe(false);

  // No AppState event at all — the everyday case: an explicit Settings
  // sign-out, or a remote revoke discovered while the app is already in the
  // foreground. Today's instant behaviour must survive unchanged.
  rerender({ isSignedIn: false });
  expect(result.current).toBe(true);
});

test('a cold start that is already signed out confirms instantly', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result } = renderHook(() => useResumeSignOutGuard(true, false, getToken));
  expect(result.current).toBe(true);
});

test('does nothing while Clerk has not loaded yet', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result } = renderHook(() => useResumeSignOutGuard(false, false, getToken));
  expect(result.current).toBe(false);
});

test('a momentary false right after resume is held, not confirmed, and clears if it self-corrects', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result, rerender } = renderHook(
    ({ isSignedIn }: { isSignedIn: boolean }) => useResumeSignOutGuard(true, isSignedIn, getToken),
    { initialProps: { isSignedIn: true } },
  );

  act(() => {
    fire('background');
    fire('active');
  });

  // The read right after resume: false, but inside the grace window.
  rerender({ isSignedIn: false });
  expect(result.current).toBe(false);

  act(() => {
    jest.advanceTimersByTime(RESUME_GRACE_MS - 500);
  });
  expect(result.current).toBe(false);

  // Clerk corrects itself before the window elapses — this is the race
  // resolving the way it should, and the athlete is never bounced.
  rerender({ isSignedIn: true });
  act(() => {
    jest.advanceTimersByTime(RESUME_GRACE_MS);
  });
  expect(result.current).toBe(false);
});

test('a false reading that outlasts the resume window IS confirmed — a genuine sign-out discovered on resume still redirects', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result, rerender } = renderHook(
    ({ isSignedIn }: { isSignedIn: boolean }) => useResumeSignOutGuard(true, isSignedIn, getToken),
    { initialProps: { isSignedIn: true } },
  );

  act(() => {
    fire('background');
    fire('active');
  });
  rerender({ isSignedIn: false });
  expect(result.current).toBe(false);

  act(() => {
    jest.advanceTimersByTime(RESUME_GRACE_MS);
  });
  expect(result.current).toBe(true);
});

test('a resume nudges Clerk with a real, cache-skipping getToken call', () => {
  const getToken = jest.fn(async () => 'tok');
  renderHook(() => useResumeSignOutGuard(true, true, getToken));

  act(() => {
    fire('background');
    fire('active');
  });

  expect(getToken).toHaveBeenCalledWith({ skipCache: true });
});

test('a transition that is not a return from background does not nudge Clerk', () => {
  const getToken = jest.fn(async () => 'tok');
  renderHook(() => useResumeSignOutGuard(true, true, getToken));

  act(() => {
    // Already active going to active — not a resume.
    fire('active');
  });

  expect(getToken).not.toHaveBeenCalled();
});

test('a network failure on resume is swallowed rather than thrown', async () => {
  const getToken = jest.fn(async () => {
    throw new Error('offline');
  });
  renderHook(() => useResumeSignOutGuard(true, true, getToken));

  // If the rejection escaped unhandled, this act() block would surface it as
  // a test failure.
  await act(async () => {
    fire('background');
    fire('active');
    await Promise.resolve();
    await Promise.resolve();
  });
});

/**
 * The whole reason `getToken` is funnelled through a ref inside the hook
 * rather than listed directly in the subscription effect's dependencies:
 * `@clerk/clerk-expo`'s real `getToken` is a bare arrow rebuilt every render
 * (see `useAuthToken.ts`'s doc comment). Without the ref, each render would
 * tear down and re-register the `AppState` listener, and each re-registration
 * recaptures `previous` from `AppState.currentState` — silently losing
 * whatever transition history it was tracking. Mutate the `useCallback(...,
 * [])` in authResume.ts to depend on `getToken` directly and this goes red.
 */
test('the AppState subscription is registered once, even as getToken is rebuilt every render', () => {
  const { rerender } = renderHook(
    ({ getToken }: { getToken: () => Promise<string> }) =>
      useResumeSignOutGuard(true, true, getToken),
    { initialProps: { getToken: jest.fn(async () => 'tok1') } },
  );

  expect(spy).toHaveBeenCalledTimes(1);

  rerender({ getToken: jest.fn(async () => 'tok2') });
  rerender({ getToken: jest.fn(async () => 'tok3') });

  expect(spy).toHaveBeenCalledTimes(1);
});

/**
 * `expect(...).not.toThrow()` alone is decorative here — found in review.
 * React 18 silently no-ops a `setState` on an unmounted component, so a
 * leaked timer calling `setConfirmed` after unmount would not throw either;
 * deleting the effect's `clearTimeout` cleanup entirely still leaves this
 * green. Spying on `clearTimeout` itself is what actually distinguishes
 * "cleaned up" from "never ran, or fired harmlessly into the void".
 */
test('the confirm timer is cleared on unmount, so it cannot fire against an unmounted guard', () => {
  const getToken = jest.fn(async () => 'tok');
  const clearSpy = jest.spyOn(global, 'clearTimeout');
  const { rerender, unmount } = renderHook(
    ({ isSignedIn }: { isSignedIn: boolean }) => useResumeSignOutGuard(true, isSignedIn, getToken),
    { initialProps: { isSignedIn: true } },
  );

  act(() => {
    fire('background');
    fire('active');
  });
  rerender({ isSignedIn: false });

  const before = clearSpy.mock.calls.length;
  unmount();
  expect(clearSpy.mock.calls.length).toBeGreaterThan(before);

  clearSpy.mockRestore();
});

/**
 * The corner review found: a timer suspended mid-wait (iOS pauses JS timers
 * in the background) must not fire against a window a LATER resume already
 * moved. `isSignedIn` never changes across this whole sequence, so the
 * confirm effect itself never re-runs to arm a fresh window — the ONLY thing
 * that can react to the second resume is this same timer waking up and
 * re-checking `resumedAt.current`, which is exactly what it is for.
 */
test('a timer that wakes after a later resume reschedules instead of confirming or hanging forever', () => {
  const getToken = jest.fn(async () => 'tok');
  const { result, rerender } = renderHook(
    ({ isSignedIn }: { isSignedIn: boolean }) => useResumeSignOutGuard(true, isSignedIn, getToken),
    { initialProps: { isSignedIn: true } },
  );

  // First resume, then the false reading that starts the original window.
  act(() => {
    fire('background');
    fire('active');
  });
  rerender({ isSignedIn: false });

  // Most of the original window elapses (simulating the phone being locked
  // again, which is where a real device would suspend the timer — jest's
  // fake timers have no such concept, so this is simulated by advancing
  // time without letting the ORIGINAL timer's target be reached).
  act(() => {
    jest.advanceTimersByTime(RESUME_GRACE_MS - 200);
  });
  expect(result.current).toBe(false);

  // A second resume moves the goalposts — `resumedAt` jumps forward — while
  // `isSignedIn` stays false throughout, so no new effect run occurs.
  act(() => {
    fire('background');
    fire('active');
  });

  // The ORIGINAL timer now fires (its 200ms remaining). Without the fix,
  // this would read `resumedAt` as barely-elapsed relative to the FIRST
  // window and still confirm — the exact premature bounce review found.
  act(() => {
    jest.advanceTimersByTime(200);
  });
  expect(result.current).toBe(false);

  // The rescheduled timer now completes the SECOND window in full.
  act(() => {
    jest.advanceTimersByTime(RESUME_GRACE_MS);
  });
  expect(result.current).toBe(true);
});
