import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { HealthConnectRefusalLine } from '@/components/settings/HealthConnectRefusalLine';
import { recordHealthConnectPassRefusals } from '@/lib/healthConnectRefusals';
import { migratedFixture, type FixtureDb } from '@/lib/__tests__/support/sqlite';

/**
 * N527 (#949) — the line under Settings' Health Connect toggle, rendered over
 * real SQLite: shown after a pass that was refused, gone after one that was
 * not, per user, and never on iOS.
 *
 * WHEN a pass writes is `lib/__tests__/healthConnectSync.test.ts`'s job, and
 * whether Settings mounts this at all (toggle off, no Health Connect) is
 * `settingsHealthConnectRefusal.test.tsx`'s. This file is the row itself.
 */

/**
 * jest-expo runs as iOS. `Platform.OS` is a getter there, so the module is
 * replaced rather than reassigned — the same approach as
 * `lib/__tests__/healthConnectReads.test.ts`, with a getter so one file can
 * render both platforms.
 */
let mockOS: 'ios' | 'android' = 'android';
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const base = {
    select: (spec: Record<string, unknown>) => (mockOS in spec ? spec[mockOS] : spec.default),
    Version: 35,
    isTV: false,
    isTesting: true,
    constants: {},
  };
  const platform = { ...base };
  Object.defineProperty(platform, 'OS', { get: () => mockOS, enumerable: true });
  const mod = { __esModule: true, default: platform, ...base };
  Object.defineProperty(mod, 'OS', { get: () => mockOS, enumerable: true });
  return mod;
});

let mockFixture: FixtureDb;
jest.mock('../../lib/db', () => {
  const real = jest.requireActual('../../lib/db');
  return { ...real, getDb: async () => mockFixture };
});

/** Which users' reads have SETTLED, so an absence is asserted only after the
 *  read that would have produced the line has actually come back. */
const mockSettledReads: string[] = [];
jest.mock('@/lib/healthConnectRefusals', () => {
  const real = jest.requireActual('@/lib/healthConnectRefusals');
  return {
    ...real,
    readHealthConnectRefusals: async (userID: string) => {
      const value = await real.readHealthConnectRefusals(userID);
      mockSettledReads.push(userID);
      return value;
    },
  };
});
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]) };
});
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#5B8CFF', ink: '#8FB0FF', on: '#FFFFFF' }) }));
jest.mock('@/components/ui/PressableScale', () => {
  const { Pressable } = jest.requireActual('react-native');
  return { PressableScale: Pressable };
});

const USER = 'u1';
const OTHER = 'u2';
const LINE = 'settings-health-connect-refused';

/** Let a settled read's `.then` run before asserting that nothing appeared. */
const flush = () => act(async () => {});

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockOS = 'android';
  mockSettledReads.length = 0;
});

describe('HealthConnectRefusalLine (N527, #949)', () => {
  it('names what Health Connect refused in the athlete\'s words, and its button opens Health Connect', async () => {
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession', 'HeartRate']);
    const onOpen = jest.fn();

    await render(<HealthConnectRefusalLine userId={USER} onOpen={onOpen} />);

    expect(
      await screen.findByText(
        "Health Connect isn't sharing exercise sessions or heart rate with VOLA, so walks and hikes won't appear on Today, and sessions won't get heart-rate zones or load. To change it, open Health Connect, then App permissions, then VOLA.",
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-health-connect-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('goes away when the next pass is refused nothing — it reflects the last pass, not a sticky flag', async () => {
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession']);
    await render(<HealthConnectRefusalLine userId={USER} onOpen={jest.fn()} />);
    expect(await screen.findByTestId(LINE)).toBeTruthy();

    // The foreground pass after allowing the grant in Health Connect.
    await act(async () => {
      await recordHealthConnectPassRefusals(USER, []);
    });

    await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
  });

  it('says nothing when the only refusal was Steps — the Steps row reports that one', async () => {
    await recordHealthConnectPassRefusals(USER, ['Steps']);

    await render(<HealthConnectRefusalLine userId={USER} onOpen={jest.fn()} />);
    await waitFor(() => expect(mockSettledReads).toContain(USER));
    await flush();

    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('is per user: another account on the same phone never sees this athlete\'s line', async () => {
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession']);

    const { rerender } = await render(<HealthConnectRefusalLine userId={OTHER} onOpen={jest.fn()} />);
    await waitFor(() => expect(mockSettledReads).toContain(OTHER));
    await flush();
    expect(screen.queryByTestId(LINE)).toBeNull();

    // Control: the same store, read as the athlete it belongs to, does show it.
    await rerender(<HealthConnectRefusalLine userId={USER} onOpen={jest.fn()} />);
    expect(await screen.findByTestId(LINE)).toBeTruthy();
  });

  it('renders nothing on iOS, and never reads the store there', async () => {
    mockOS = 'ios';
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession']);

    const { rerender } = await render(<HealthConnectRefusalLine userId={USER} onOpen={jest.fn()} />);
    await flush();
    expect(screen.queryByTestId(LINE)).toBeNull();
    expect(mockSettledReads).toEqual([]);

    // Control: the same stored refusal on Android is shown.
    mockOS = 'android';
    await rerender(<HealthConnectRefusalLine userId={USER} onOpen={jest.fn()} />);
    expect(await screen.findByTestId(LINE)).toBeTruthy();
  });
});
