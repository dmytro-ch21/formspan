import type { Countdown } from '../countdown';
import { adjusted, toggledPause } from '../countdown';
import { migratedFixture, type FixtureDb } from './support/sqlite';
// Above the `jest.mock` calls in the source, and still bound to the mocks:
// babel-jest hoists every `jest.mock` above the imports, and each factory
// reaches its `mock*` variables only when called.
import {
  MIN_LEAD_SECONDS,
  REST_ALERT_CHANNEL,
  REST_ALERT_ID,
  askAlertPermission,
  cancelRestLockAlert,
  isAway,
  lockAlertCopy,
  lockAlertPlan,
  permissionOf,
  readAlertPermission,
  readRestLockAlertEnabled,
  refusedLineFor,
  scheduleRestLockAlert,
  writeRestLockAlertEnabled,
} from '../restLockAlert';

/**
 * N195 (#612) — the rest timer's lock-screen alert, as decisions.
 *
 * `lockAlertPlan` is where every "schedule / don't" lives, so it is tested
 * one guard at a time: each `clear` case differs from a scheduling input in
 * exactly ONE field, and asserts the REASON, so no guard can stand in for
 * another. The adapter below it is tested against `expo-notifications`
 * mocked at the module boundary — what is asserted is what VOLA asks the OS
 * for, which is all a jest run can know.
 */

let mockOS: 'ios' | 'android' = 'ios';
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

const mockSchedule = jest.fn(async (..._args: unknown[]) => 'id');
const mockCancel = jest.fn(async (..._args: unknown[]) => {});
const mockChannel = jest.fn(async (..._args: unknown[]) => null);
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  cancelScheduledNotificationAsync: (...a: unknown[]) => mockCancel(...a),
  setNotificationChannelAsync: (...a: unknown[]) => mockChannel(...a),
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const NOW = 1_800_000_000_000;

function rest(overrides: Partial<Countdown> = {}): Countdown {
  return {
    kind: 'rest',
    endsAt: NOW + 90_000,
    pausedWith: null,
    total: 90,
    label: 'Bench Press',
    exerciseID: 'e1',
    ...overrides,
  };
}

/** The one input set that schedules. Every `clear` case below changes ONE field of it. */
const scheduling = { appState: 'background', timer: rest(), enabled: true, now: NOW };

beforeEach(() => {
  mockOS = 'ios';
  mockSchedule.mockClear();
  mockCancel.mockClear();
  mockChannel.mockClear();
  mockGetPermissions.mockReset();
  mockRequestPermissions.mockReset();
});

describe('lockAlertPlan — when an alert is scheduled', () => {
  it('schedules for the rest left, backgrounded', () => {
    expect(lockAlertPlan(scheduling)).toEqual({
      kind: 'schedule',
      seconds: 90,
      title: "Rest's up",
      body: 'Rest after Bench Press is over. Your next set is ready when you are.',
    });
  });

  it('schedules when inactive too — the moment of locking passes through it', () => {
    expect(lockAlertPlan({ ...scheduling, appState: 'inactive' }).kind).toBe('schedule');
  });

  it('schedules for what is LEFT, not what the rest started at', () => {
    const plan = lockAlertPlan({ ...scheduling, now: NOW + 30_000 });
    expect(plan).toMatchObject({ kind: 'schedule', seconds: 60 });
  });

  it('a rest adjusted by +15 schedules for the new end', () => {
    const plan = lockAlertPlan({ ...scheduling, timer: adjusted(rest(), 15, NOW) });
    expect(plan).toMatchObject({ kind: 'schedule', seconds: 105 });
  });

  it('a restarted rest schedules for the new rest, not the old one', () => {
    const restarted = rest({ endsAt: NOW + 180_000, total: 180, label: 'Squat' });
    expect(lockAlertPlan({ ...scheduling, timer: restarted })).toMatchObject({
      kind: 'schedule',
      seconds: 180,
      body: 'Rest after Squat is over. Your next set is ready when you are.',
    });
  });

  it('rounds to whole seconds', () => {
    expect(lockAlertPlan({ ...scheduling, now: NOW + 400 })).toMatchObject({ seconds: 90 });
    expect(lockAlertPlan({ ...scheduling, now: NOW + 600 })).toMatchObject({ seconds: 89 });
  });
});

describe('lockAlertPlan — every guard, one at a time', () => {
  it('the foreground schedules nothing', () => {
    expect(lockAlertPlan({ ...scheduling, appState: 'active' })).toEqual({ kind: 'clear', reason: 'foreground' });
  });

  it('an unknown app state is not "away"', () => {
    expect(lockAlertPlan({ ...scheduling, appState: 'unknown' })).toEqual({ kind: 'clear', reason: 'foreground' });
  });

  it('off (preference or permission) schedules nothing', () => {
    expect(lockAlertPlan({ ...scheduling, enabled: false })).toEqual({ kind: 'clear', reason: 'off' });
  });

  it('a skipped or stopped rest — no countdown — schedules nothing', () => {
    expect(lockAlertPlan({ ...scheduling, timer: null })).toEqual({ kind: 'clear', reason: 'no-countdown' });
  });

  it('a work countdown schedules nothing: "Rest\'s up" over a plank would be wrong', () => {
    expect(lockAlertPlan({ ...scheduling, timer: rest({ kind: 'work', setIndex: 0 }) })).toEqual({
      kind: 'clear',
      reason: 'not-rest',
    });
  });

  it('a count-in schedules nothing', () => {
    expect(lockAlertPlan({ ...scheduling, timer: rest({ kind: 'ready' }) })).toEqual({
      kind: 'clear',
      reason: 'not-rest',
    });
  });

  it('a paused rest has no end to schedule for', () => {
    expect(lockAlertPlan({ ...scheduling, timer: toggledPause(rest(), NOW) })).toEqual({
      kind: 'clear',
      reason: 'paused',
    });
  });

  it('a rest already over schedules nothing', () => {
    expect(lockAlertPlan({ ...scheduling, now: NOW + 90_000 })).toEqual({ kind: 'clear', reason: 'over' });
  });

  it('under the minimum lead the in-app completion owns it', () => {
    const justUnder = NOW + 90_000 - (MIN_LEAD_SECONDS * 1000 - 1);
    expect(lockAlertPlan({ ...scheduling, now: justUnder })).toEqual({ kind: 'clear', reason: 'over' });
    const exactly = NOW + 90_000 - MIN_LEAD_SECONDS * 1000;
    expect(lockAlertPlan({ ...scheduling, now: exactly })).toMatchObject({ kind: 'schedule', seconds: 1 });
  });
});

describe('isAway', () => {
  it('is background and inactive, nothing else', () => {
    expect(['active', 'background', 'inactive', 'unknown', 'extension'].filter(isAway)).toEqual([
      'background',
      'inactive',
    ]);
  });
});

describe('lockAlertCopy', () => {
  it('names what the athlete rested FROM', () => {
    expect(lockAlertCopy('Romanian Deadlift')).toEqual({
      title: "Rest's up",
      body: 'Rest after Romanian Deadlift is over. Your next set is ready when you are.',
    });
  });

  it('never says "Rest after Rest" when no exercise name was at hand', () => {
    expect(lockAlertCopy('Rest').body).toBe('Your next set is ready when you are.');
  });

  it('a blank label is not a name', () => {
    expect(lockAlertCopy('   ').body).toBe('Your next set is ready when you are.');
  });
});

describe('permissionOf', () => {
  it('granted wins', () => {
    expect(permissionOf({ granted: true, canAskAgain: true, status: 'granted' })).toBe('granted');
  });
  it('never asked is undetermined', () => {
    expect(permissionOf({ granted: false, canAskAgain: true, status: 'undetermined' })).toBe('undetermined');
  });
  it('refused but askable (Android 13+ after one refusal)', () => {
    expect(permissionOf({ granted: false, canAskAgain: true, status: 'denied' })).toBe('denied-can-ask');
  });
  it('refused for good', () => {
    expect(permissionOf({ granted: false, canAskAgain: false, status: 'denied' })).toBe('denied');
  });
});

describe('refusedLineFor', () => {
  it('iOS names where the switch is', () => {
    expect(refusedLineFor('ios', 'denied')).toBe(
      "Notifications are off for VOLA, so this can't alert you. To change it, open the Settings app, then Notifications, VOLA, and turn on Allow Notifications.",
    );
  });
  it('Android, refused for good, names where the switch is', () => {
    expect(refusedLineFor('android', 'denied')).toBe(
      "Notifications are off for VOLA, so this can't alert you. To change it, open the Settings app, then Apps, VOLA, Notifications.",
    );
  });
  it('Android, still askable, says turning it on asks again', () => {
    expect(refusedLineFor('android', 'denied-can-ask')).toBe(
      "Notifications are off for VOLA, so this can't alert you. Turn it on again to be asked, or open the Settings app, then Apps, VOLA, Notifications.",
    );
  });
  it('says nothing for any state that is not a refusal', () => {
    expect(refusedLineFor('ios', 'granted')).toBeNull();
    expect(refusedLineFor('ios', 'undetermined')).toBeNull();
    expect(refusedLineFor('android', null)).toBeNull();
  });
});

describe('the preference', () => {
  beforeEach(async () => {
    mockFixture = await migratedFixture();
  });

  it('is off until written', async () => {
    expect(await readRestLockAlertEnabled('u1')).toBe(false);
  });

  it('round-trips, per user', async () => {
    await writeRestLockAlertEnabled('u1', true);
    expect(await readRestLockAlertEnabled('u1')).toBe(true);
    expect(await readRestLockAlertEnabled('u2')).toBe(false);
    await writeRestLockAlertEnabled('u1', false);
    expect(await readRestLockAlertEnabled('u1')).toBe(false);
  });
});

describe('the adapter — what VOLA asks the OS for', () => {
  it('schedules ONE identified alert, on the rest channel, for the planned seconds, with the default sound', async () => {
    await scheduleRestLockAlert({ seconds: 42, title: "Rest's up", body: 'b' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith({
      identifier: REST_ALERT_ID,
      content: expect.objectContaining({ title: "Rest's up", body: 'b', sound: 'default' }),
      trigger: { type: 'timeInterval', seconds: 42, channelId: REST_ALERT_CHANNEL },
    });
  });

  it('on iOS creates no channel', async () => {
    await scheduleRestLockAlert({ seconds: 5, title: 't', body: 'b' });
    expect(mockChannel).not.toHaveBeenCalled();
  });

  it('on Android creates the channel first: high importance, public on the lock screen, default sound, no DND bypass', async () => {
    mockOS = 'android';
    await scheduleRestLockAlert({ seconds: 5, title: 't', body: 'b' });
    expect(mockChannel).toHaveBeenCalledTimes(1);
    const [id, input] = mockChannel.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe(REST_ALERT_CHANNEL);
    expect(input).toMatchObject({ importance: 6, lockscreenVisibility: 1, bypassDnd: false, enableVibrate: true });
    // Absent, not 'default': a string is looked up as a res/raw file.
    expect('sound' in input).toBe(false);
    expect(mockChannel.mock.invocationCallOrder[0]).toBeLessThan(mockSchedule.mock.invocationCallOrder[0]);
  });

  it('cancels by the same identifier', async () => {
    await cancelRestLockAlert();
    expect(mockCancel).toHaveBeenCalledWith(REST_ALERT_ID);
  });

  it('a failing cancel never throws into its caller', async () => {
    mockCancel.mockRejectedValueOnce(new Error('native'));
    await expect(cancelRestLockAlert()).resolves.toBeUndefined();
  });

  it('reading the permission never prompts', async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true, status: 'undetermined' });
    expect(await readAlertPermission()).toBe('undetermined');
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('asking requests alert and sound, no badge — and on Android makes the channel first', async () => {
    mockOS = 'android';
    mockRequestPermissions.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' });
    expect(await askAlertPermission()).toBe('granted');
    expect(mockRequestPermissions).toHaveBeenCalledWith({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    expect(mockChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequestPermissions.mock.invocationCallOrder[0],
    );
  });
});
