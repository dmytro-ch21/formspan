import { configure, render, screen } from '@testing-library/react-native';

import SettingsScreen from '../../app/settings';

/**
 * The environment instrument's new home (N529/#960).
 *
 * `lib/__tests__/environmentLabel.test.ts` pins the DECISION — which values
 * show and which do not. This pins that the decision reaches the Settings
 * screen at all: the `DEV` pill that used to float over every screen is gone
 * from the root layout, and a label nobody wired in anywhere would leave the
 * pure function green and the athlete with no way to tell a dev build from a
 * release. Both arms, because a footer line that rendered on production
 * would be the one failure this instrument exists to prevent.
 *
 * `process.env.EXPO_PUBLIC_APP_ENV` is read at render (see the comment in
 * `settings.tsx`), so a test can set it per case; on a device it is inlined
 * at bundle time and this is moot.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

// Everything the Settings screen touches that reaches SQLite, HealthKit or
// the network — none of it is what this file is about.
jest.mock('@/lib/healthkit', () => ({ isHealthKitSupported: () => false }));
jest.mock('@/lib/healthkitSync', () => ({
  readHealthKitImportEnabled: async () => false,
  triggerHealthKitImportNow: jest.fn(),
  writeHealthKitImportEnabled: async () => {},
}));
jest.mock('@/lib/biometricSync', () => ({
  readBiometricSyncFailureCount: async () => 0,
  triggerBiometricSyncNow: jest.fn(),
}));
jest.mock('@/lib/healthConnect', () => ({ isHealthConnectSupported: async () => false }));
jest.mock('@/lib/healthConnectSync', () => ({
  readHealthConnectImportEnabled: async () => false,
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

// Static key every time — `expo/no-dynamic-env-var` refuses `process.env[k]`
// because Metro inlines `EXPO_PUBLIC_*` by literal name and a dynamic read is
// undefined on a device. Here it would only be jest, but the rule is right.
const original = process.env.EXPO_PUBLIC_APP_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = original;
});

it('names a non-production build in the footer', async () => {
  process.env.EXPO_PUBLIC_APP_ENV = 'development';
  await render(<SettingsScreen />);
  const line = await screen.findByTestId('settings-environment');
  expect(line).toHaveTextContent(/Build environment: DEVELOPMENT/);
  expect(line).toHaveTextContent(/not a production build/);
});

it('says DEV when nothing set the variable at all', async () => {
  delete process.env.EXPO_PUBLIC_APP_ENV;
  await render(<SettingsScreen />);
  expect(await screen.findByTestId('settings-environment')).toHaveTextContent(
    /Build environment: DEV\./,
  );
});

it('renders NOTHING on production', async () => {
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
  await render(<SettingsScreen />);
  // Wait for the screen to be up before asserting the absence, or an
  // unmounted screen would pass this for the wrong reason.
  await screen.findByTestId('settings-diagnostics');
  expect(screen.queryByTestId('settings-environment')).toBeNull();
  expect(screen.queryByText(/Build environment/)).toBeNull();
});
