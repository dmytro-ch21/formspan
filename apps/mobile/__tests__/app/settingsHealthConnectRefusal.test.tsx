import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SettingsScreen from '../../app/settings';

/**
 * N527 (#949) — WHETHER Settings mounts the Health Connect refusal line.
 *
 * The line itself is stubbed here, deliberately: it carries its own iOS guard
 * (`healthConnectRefusalLine.test.tsx`), and rendering the real one would let
 * that guard hide a broken gate in this screen. So these tests see only the
 * screen's decision: Android, Health Connect available, the toggle on, a user.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

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

let mockSupported = true;
let mockImportOn = true;
/** Settled reads, so an absence is asserted only once the screen has its answer. */
let mockImportReads = 0;
let mockSupportReads = 0;
const mockOpen = jest.fn(() => true);

jest.mock('@/lib/healthkit', () => ({ isHealthKitSupported: () => false }));
jest.mock('@/lib/healthkitSync', () => ({
  askHealthKitSteps: async () => {},
  readHealthKitImportEnabled: async () => false,
  triggerHealthKitImportNow: jest.fn(),
  writeHealthKitImportEnabled: async () => {},
}));
jest.mock('@/lib/biometricSync', () => ({
  readBiometricSyncFailureCount: async () => 0,
  triggerBiometricSyncNow: jest.fn(),
}));
jest.mock('@/lib/healthConnect', () => ({
  isHealthConnectSupported: async () => {
    mockSupportReads++;
    return mockSupported;
  },
  openHealthConnectSettingsScreen: () => mockOpen(),
}));
jest.mock('@/lib/healthConnectSync', () => ({
  askHealthConnectSteps: async () => {},
  readHealthConnectImportEnabled: async () => {
    mockImportReads++;
    return mockImportOn;
  },
  triggerHealthConnectSyncNow: jest.fn(),
  writeHealthConnectImportEnabled: async () => {},
}));
jest.mock('@/lib/rest', () => ({ readAutoRest: async () => false, writeAutoRest: async () => {} }));
jest.mock('@/lib/sounds', () => ({
  playSound: jest.fn(),
  readSoundsEnabled: async () => true,
  writeSoundsEnabled: async () => {},
}));
jest.mock('@/lib/voice', () => ({
  readVoiceEnabled: async () => true,
  speak: jest.fn(),
  writeVoiceEnabled: async () => {},
}));
jest.mock('@/lib/useTrackEffort', () => ({
  useTrackEffort: () => ({ trackEffort: true, setTrackEffort: async () => {}, unsynced: false }),
}));
jest.mock('@/lib/profile', () => ({
  getProfile: async () => ({ share_training_with_friends: false, share_training_details: false }),
  updateProfile: async () => ({}),
}));
jest.mock('@/lib/telemetryClient', () => ({ rejectionTrackingActive: () => false }));
jest.mock('@/lib/session', () => ({ clearSessionToken: async () => {} }));
jest.mock('@/components/settings/HealthConnectRefusalLine', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    HealthConnectRefusalLine: ({ userId, onOpen }: { userId: string; onOpen: () => void }) =>
      React.createElement(Pressable, { testID: `refusal-line-${userId}`, onPress: onOpen }),
  };
});
jest.mock('@/components/settings/StepsPermissionRow', () => ({ StepsPermissionRow: () => null }));
jest.mock('@/components/settings/HRMonitorPairing', () => ({ HRMonitorPairing: () => null }));

/** `u1` is the signed-in user `jest.setup.js`'s Clerk mock provides. */
const LINE = 'refusal-line-u1';

beforeEach(() => {
  mockOS = 'android';
  mockSupported = true;
  mockImportOn = true;
  mockImportReads = 0;
  mockSupportReads = 0;
  mockOpen.mockClear();
});

/** Both reads the gate depends on have come back, and their `.then`s have run. */
async function gateSettled(): Promise<void> {
  await waitFor(() => expect(mockImportReads).toBeGreaterThan(0));
  if (mockOS === 'android') await waitFor(() => expect(mockSupportReads).toBeGreaterThan(0));
  await act(async () => {});
}

describe('Settings mounts the Health Connect refusal line only where it can be true (N527, #949)', () => {
  it('Android, Health Connect available, toggle on: mounted for the signed-in athlete, and it opens Health Connect', async () => {
    await render(<SettingsScreen />);

    await fireEvent.press(await screen.findByTestId(LINE));

    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('turning the toggle off hides it at once', async () => {
    await render(<SettingsScreen />);
    await screen.findByTestId(LINE);

    await fireEvent.press(screen.getByTestId('settings-health-connect-import'));

    await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
  });

  it('toggle off: not mounted', async () => {
    mockImportOn = false;

    await render(<SettingsScreen />);
    await gateSettled();

    expect(screen.getByTestId('settings-health-connect-import')).toBeTruthy();
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('no Health Connect on this phone: not mounted', async () => {
    mockSupported = false;

    await render(<SettingsScreen />);
    await gateSettled();

    expect(screen.getByTestId('settings-health-connect-import')).toBeTruthy();
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('iOS: never mounted, even with the Health Connect reads both answering yes', async () => {
    mockOS = 'ios';

    await render(<SettingsScreen />);
    await gateSettled();

    // The screen did render — its iOS Health toggle is there...
    expect(screen.getByTestId('settings-healthkit-import')).toBeTruthy();
    // ...and nothing of Health Connect is.
    expect(screen.queryByTestId('settings-health-connect-import')).toBeNull();
    expect(screen.queryByTestId(LINE)).toBeNull();
  });
});
