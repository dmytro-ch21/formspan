import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SettingsScreen from '../../app/settings';
import { migratedFixture, type FixtureDb } from '@/lib/__tests__/support/sqlite';
import { readRestLockAlertEnabled, writeRestLockAlertEnabled } from '@/lib/restLockAlert';

/**
 * N195 (#612) — the Settings row for the rest timer's lock-screen alert, on
 * the real Settings screen, over real SQLite, with `expo-notifications` mocked
 * at the module boundary.
 *
 * What it guards is the product rule, not the markup: OFF by default, the
 * permission is asked ONLY when the athlete turns it on, and a refusal says
 * where to change it rather than flipping silently back.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

let mockFixture: FixtureDb;
jest.mock('../../lib/db', () => {
  const real = jest.requireActual('../../lib/db');
  return { ...real, getDb: async () => mockFixture };
});

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockCancel = jest.fn(async () => {});
const mockSchedule = jest.fn(async () => 'id');
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  cancelScheduledNotificationAsync: (...a: unknown[]) => mockCancel(...(a as [])),
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...(a as [])),
  setNotificationChannelAsync: async () => null,
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

// The rest of the screen, stubbed the way `settingsSwitch.test.tsx` does.
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

const USER = 'u1'; // jest.setup.js's Clerk mock
const UNDETERMINED = { granted: false, canAskAgain: true, status: 'undetermined' };
const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };
const DENIED = { granted: false, canAskAgain: false, status: 'denied' };
const IOS_REFUSED =
  "Notifications are off for VOLA, so this can't alert you. To change it, open the Settings app, then Notifications, VOLA, and turn on Allow Notifications.";

/** The row, once its preference AND permission have been read — asserting before that measures nothing. */
async function settledRow() {
  const row = await screen.findByTestId('settings-rest-lock-alert');
  await waitFor(() =>
    expect(screen.getByTestId('settings-rest-lock-alert').props.accessibilityState.disabled).toBe(false),
  );
  return row;
}
const checked = () => screen.getByTestId('settings-rest-lock-alert').props.accessibilityState.checked;

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockGetPermissions.mockReset();
  mockRequestPermissions.mockReset();
  mockCancel.mockClear();
  mockSchedule.mockClear();
});

it('is OFF by default, and rendering it asks for nothing', async () => {
  mockGetPermissions.mockResolvedValue(UNDETERMINED);

  await render(<SettingsScreen />);
  await settledRow();

  expect(checked()).toBe(false);
  expect(mockGetPermissions).toHaveBeenCalled(); // the read happened — the absence below means something
  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(screen.queryByTestId('settings-rest-lock-alert-refused')).toBeNull();
  expect(screen.getByText('Rest timer alert when the phone is locked')).toBeTruthy();
});

it('turning it ON is what asks — once — and a yes turns it on and saves it', async () => {
  mockGetPermissions.mockResolvedValue(UNDETERMINED);
  mockRequestPermissions.mockResolvedValue(GRANTED);

  await render(<SettingsScreen />);
  const row = await settledRow();
  await fireEvent.press(row);

  await waitFor(() => expect(checked()).toBe(true));
  expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  expect(await readRestLockAlertEnabled(USER)).toBe(true);
});

it('already allowed: turning it on does not prompt again', async () => {
  mockGetPermissions.mockResolvedValue(GRANTED);

  await render(<SettingsScreen />);
  const row = await settledRow();
  await fireEvent.press(row);

  await waitFor(() => expect(checked()).toBe(true));
  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(await readRestLockAlertEnabled(USER)).toBe(true);
});

it('refused: stays off, says where to change it, and saves off', async () => {
  mockGetPermissions.mockResolvedValue(UNDETERMINED);
  mockRequestPermissions.mockResolvedValue(DENIED);

  await render(<SettingsScreen />);
  const row = await settledRow();
  await fireEvent.press(row);

  await waitFor(() => expect(screen.queryByText(IOS_REFUSED)).not.toBeNull());
  expect(checked()).toBe(false);
  expect(await readRestLockAlertEnabled(USER)).toBe(false);
});

it('refused for good: tapping on shows the line and does not fire a prompt the OS would not show', async () => {
  mockGetPermissions.mockResolvedValue(DENIED);
  // What the OS would answer if it were asked anyway, so a regression that
  // asks completes normally and is caught by the not-called assertion below,
  // rather than by an undefined response breaking the flow first.
  mockRequestPermissions.mockResolvedValue(DENIED);

  await render(<SettingsScreen />);
  const row = await settledRow();
  // Never wanted, so no line yet — no nagging about a switch nobody touched.
  expect(screen.queryByTestId('settings-rest-lock-alert-refused')).toBeNull();

  await fireEvent.press(row);

  await waitFor(() => expect(screen.queryByText(IOS_REFUSED)).not.toBeNull());
  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(checked()).toBe(false);
});

it('on, then permission withdrawn in the OS: shows off with the line, and does not ask on its own', async () => {
  await writeRestLockAlertEnabled(USER, true);
  mockGetPermissions.mockResolvedValue(DENIED);

  await render(<SettingsScreen />);
  await settledRow();

  await waitFor(() => expect(screen.queryByText(IOS_REFUSED)).not.toBeNull());
  expect(checked()).toBe(false);
  expect(mockRequestPermissions).not.toHaveBeenCalled();
});

it('turning it OFF never asks, saves off, and clears any armed alert', async () => {
  await writeRestLockAlertEnabled(USER, true);
  mockGetPermissions.mockResolvedValue(GRANTED);

  await render(<SettingsScreen />);
  const row = await settledRow();
  expect(checked()).toBe(true);

  await fireEvent.press(row);

  await waitFor(() => expect(checked()).toBe(false));
  await waitFor(async () => expect(await readRestLockAlertEnabled(USER)).toBe(false));
  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockCancel).toHaveBeenCalled();
});
