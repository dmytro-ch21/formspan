import { act, render, screen, waitFor } from '@testing-library/react-native';

import CheckinScreen from '../../app/checkin/[date]';
import { listCheckins } from '@/lib/body';
import { getProfile } from '@/lib/profile';
import { toDisplayWeight } from '@/lib/units';

/**
 * N471 — `load()` had no "latest call wins" guard.
 *
 * This screen never reads `unitsReady`, and the real `UnitsProvider` starts
 * `units` at 'metric' and corrects it a frame later once the stored
 * preference loads. Because `units` is in `load`'s `useCallback` deps, that
 * correction changes `load`'s identity and — via the `useFocusEffect`
 * wrapping it — fires a SECOND `load()` while the first is still in flight.
 * If the two network responses resolve out of order, the older call running
 * last used to clobber state the newer call had already set correctly.
 *
 * `useUnits` is mocked here with a hook that carries real state and flips
 * once, exactly like `UnitsProvider` does, so the two `load()` calls are
 * produced the same way the real app produces them — not synthesised by
 * calling `load()` directly.
 */

jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listCheckins: jest.fn(),
  saveCheckin: jest.fn(),
  deleteCheckin: jest.fn(),
  uploadCheckinPhoto: jest.fn(),
}));
jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getProfile: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ date: '2026-08-20' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    const { useEffect: useEffectReal } = jest.requireActual('react');
    useEffectReal(cb, [cb]);
  },
}));

// A stand-in for `UnitsProvider`'s own cold-start behaviour: starts metric,
// then corrects once — exposing the flip as a module-level function so the
// test can trigger it deliberately, at a chosen moment, instead of racing a
// real timer.
let triggerUnitsCorrection: (() => void) | null = null;
jest.mock('@/lib/useUnits', () => {
  // Declared inside the factory, not referenced from outside it — jest's
  // hoist-check only forbids the latter, and `React` here isn't hoisted.
  const React = jest.requireActual('react');
  return {
    useUnits: () => {
      const [units, setUnits] = React.useState('metric');
      React.useEffect(() => {
        triggerUnitsCorrection = () => setUnits('imperial');
        return () => {
          triggerUnitsCorrection = null;
        };
      }, []);
      return { units, unitsReady: true, setUnits: jest.fn(), unsynced: false };
    },
  };
});

/** Resolves (or rejects) on demand, so the test controls response order directly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody has attached a handler to yet logs an "unhandled
  // rejection" warning the moment it's created, even though `load()`'s own
  // `catch` handles it a tick later — silence that expected, harmless noise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  triggerUnitsCorrection = null;
  (getProfile as jest.Mock).mockResolvedValue({
    user_id: 'u1',
    sex: 'male',
    height_cm: 180,
    unit_system: 'metric',
  });
});

it('keeps the newer load’s result even when the older call’s response arrives last', async () => {
  const first = deferred<unknown[]>();
  const second = deferred<unknown[]>();
  const listCheckinsMock = listCheckins as jest.Mock;
  listCheckinsMock.mockImplementationOnce(() => first.promise);
  listCheckinsMock.mockImplementationOnce(() => second.promise);

  render(<CheckinScreen />);

  // The first `load()` (units='metric') is now in flight.
  await waitFor(() => expect(listCheckinsMock).toHaveBeenCalledTimes(1));

  // Simulate `UnitsProvider` correcting a frame later — this is the same
  // mechanism that fires the second `load()` in the real app, via the
  // changed `useCallback` identity and the `useFocusEffect` re-running.
  act(() => {
    triggerUnitsCorrection?.();
  });
  await waitFor(() => expect(listCheckinsMock).toHaveBeenCalledTimes(2));

  // Resolve the NEWER call first, with the correct/current data...
  await act(async () => {
    second.resolve([
      {
        checkin_date: '2026-08-20',
        weight_kg: 75,
        waist_cm: null,
        hips_cm: null,
        neck_cm: null,
        notes: 'current',
        photo_url: null,
      },
    ]);
    await Promise.resolve();
  });

  // The newer call's `load` closed over 'imperial' (created after the flip),
  // so its own fill converts 75kg to pounds for display — same conversion the
  // real screen applies, computed here rather than hardcoded so the assertion
  // doesn't depend on the rounding rule staying the same.
  const newerDisplayWeight = String(toDisplayWeight(75, 'imperial'));
  await waitFor(() =>
    expect(screen.getByTestId('checkin-weight').props.value).toBe(newerDisplayWeight),
  );
  expect(screen.getByTestId('checkin-notes').props.value).toBe('current');

  // ...then let the OLDER call's response land last, carrying stale data.
  await act(async () => {
    first.resolve([
      {
        checkin_date: '2026-08-20',
        weight_kg: 70,
        waist_cm: null,
        hips_cm: null,
        neck_cm: null,
        notes: 'stale',
        photo_url: null,
      },
    ]);
    await Promise.resolve();
  });

  // The stale, out-of-order response must not have overwritten the newer
  // one — this is the regression the sequence guard exists to prevent.
  expect(screen.getByTestId('checkin-weight').props.value).toBe(newerDisplayWeight);
  expect(screen.getByTestId('checkin-notes').props.value).toBe('current');
});

it('does not let a stale rejection paint an error over a correct result', async () => {
  // Pins the `catch` and `finally` guards specifically — the test above only
  // exercises the success-path guard, since both its calls resolve.
  const first = deferred<unknown[]>();
  const second = deferred<unknown[]>();
  const listCheckinsMock = listCheckins as jest.Mock;
  listCheckinsMock.mockImplementationOnce(() => first.promise);
  listCheckinsMock.mockImplementationOnce(() => second.promise);

  render(<CheckinScreen />);
  await waitFor(() => expect(listCheckinsMock).toHaveBeenCalledTimes(1));

  act(() => {
    triggerUnitsCorrection?.();
  });
  await waitFor(() => expect(listCheckinsMock).toHaveBeenCalledTimes(2));

  // The NEWER call succeeds first...
  await act(async () => {
    second.resolve([
      {
        checkin_date: '2026-08-20',
        weight_kg: 75,
        waist_cm: null,
        hips_cm: null,
        neck_cm: null,
        notes: 'current',
        photo_url: null,
      },
    ]);
    await Promise.resolve();
  });
  const displayWeight = String(toDisplayWeight(75, 'imperial'));
  await waitFor(() =>
    expect(screen.getByTestId('checkin-weight').props.value).toBe(displayWeight),
  );

  // ...then the OLDER call's response lands last, as a rejection. Without the
  // guard in `load`'s `catch`, this stale failure would paint an error banner
  // over the newer call's already-correct result.
  await act(async () => {
    first.reject(new Error('stale network failure'));
    await Promise.resolve();
  });

  expect(screen.queryByTestId('checkin-error')).toBeNull();
  expect(screen.getByTestId('checkin-weight').props.value).toBe(displayWeight);
});
