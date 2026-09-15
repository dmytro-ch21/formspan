import { act, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { Countdown } from '../countdown';
import { adjusted } from '../countdown';
import { migratedFixture, type FixtureDb } from './support/sqlite';
// Bound to the mocks below despite sitting above them: babel-jest hoists
// `jest.mock`, and each factory reads its `mock*` variable only when called.
import { REST_ALERT_ID, writeRestLockAlertEnabled } from '../restLockAlert';
import { useRestLockAlert } from '../useRestLockAlert';

/**
 * N195 (#612) — WHEN the rest alert is scheduled and cancelled, against the
 * app's lifecycle. `restLockAlert.test.ts` holds the decisions; this holds the
 * wiring: which AppState changes and countdown changes reach them, in what
 * order, and that the foreground never reaches the native module at all.
 *
 * `expo-notifications` is mocked at the module boundary; preferences are real
 * SQLite. Every "nothing was scheduled" assertion is paired with a positive
 * control in the same test, so a harness that could not schedule anything
 * cannot pass them.
 */

const mockSchedule = jest.fn(async (..._a: unknown[]) => 'id');
const mockCancel = jest.fn(async (..._a: unknown[]) => {});
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  cancelScheduledNotificationAsync: (...a: unknown[]) => mockCancel(...a),
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  setNotificationChannelAsync: async () => null,
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'u1';
const NOW = 1_800_000_000_000;
const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };

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

function Harness({ timer, userId = USER }: { timer: Countdown | null; userId?: string | null }) {
  useRestLockAlert(timer, userId);
  return null;
}

let appState = 'active';
let listener: ((s: string) => void) | undefined;
/** `AppState.currentState` is a plain value, not a getter, so it is redefined — and put back after each test. */
const originalCurrentState = Object.getOwnPropertyDescriptor(AppState, 'currentState');

/** Let the hook's serialised chain (SQLite read, permission read, native call) run out. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** The app moves to `next`, exactly as React Native reports it: state first, then the event. */
async function moveTo(next: string) {
  appState = next;
  await act(async () => {
    listener?.(next);
  });
  await settle();
}

const scheduledSeconds = () =>
  mockSchedule.mock.calls.map((c) => (c[0] as { trigger: { seconds: number } }).trigger.seconds);

beforeEach(async () => {
  mockFixture = await migratedFixture();
  await writeRestLockAlertEnabled(USER, true);
  appState = 'active';
  listener = undefined;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  Object.defineProperty(AppState, 'currentState', { get: () => appState, configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
    listener = fn;
    return { remove: () => void (listener = undefined) };
  }) as never);
  mockSchedule.mockClear();
  mockCancel.mockClear();
  mockGetPermissions.mockReset().mockResolvedValue(GRANTED);
  mockRequestPermissions.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalCurrentState) Object.defineProperty(AppState, 'currentState', originalCurrentState);
});

describe('the foreground', () => {
  it('a running rest — started, adjusted, skipped — reaches the native module not once', async () => {
    const { rerender } = await render(<Harness timer={rest()} />);
    await rerender(<Harness timer={adjusted(rest(), 15, NOW)} />);
    await rerender(<Harness timer={null} />);
    await rerender(<Harness timer={rest()} />);
    await settle();

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockGetPermissions).not.toHaveBeenCalled();

    // Positive control: the same mount, locked, does schedule.
    await moveTo('background');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});

describe('locking and unlocking', () => {
  it('backgrounding with a rest running schedules one alert for the time left — and never prompts', async () => {
    await render(<Harness timer={rest()} />);
    await moveTo('background');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0]).toMatchObject({
      identifier: REST_ALERT_ID,
      content: { title: "Rest's up" },
      trigger: { seconds: 90 },
    });
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('inactive schedules too — it is the state a lock passes through', async () => {
    await render(<Harness timer={rest()} />);
    await moveTo('inactive');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('returning to active cancels it', async () => {
    await render(<Harness timer={rest()} />);
    await moveTo('background');
    expect(mockCancel).not.toHaveBeenCalled();

    await moveTo('active');

    expect(mockCancel).toHaveBeenCalledWith(REST_ALERT_ID);
    expect(mockCancel.mock.invocationCallOrder[0]).toBeGreaterThan(mockSchedule.mock.invocationCallOrder[0]);
  });

  it('a work countdown backgrounded schedules nothing', async () => {
    const { rerender } = await render(<Harness timer={rest({ kind: 'work', setIndex: 0 })} />);
    await moveTo('background');
    expect(mockSchedule).not.toHaveBeenCalled();

    // Positive control: a rest, the same way.
    await moveTo('active');
    await rerender(<Harness timer={rest()} />);
    await moveTo('background');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});

describe('nothing stale', () => {
  it('skip early: lock, unlock, skip — and nothing is left to fire', async () => {
    const { rerender } = await render(<Harness timer={rest()} />);
    await moveTo('background');
    await moveTo('active');
    // The athlete skips: a tap, so the app is active.
    await rerender(<Harness timer={null} />);
    await settle();
    // And locks again with no rest running.
    await moveTo('background');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    // The LAST thing asked of the OS was the cancel.
    expect(mockCancel.mock.invocationCallOrder[0]).toBeGreaterThan(mockSchedule.mock.invocationCallOrder[0]);
  });

  it('stop, then a new rest: the next lock schedules for the NEW rest', async () => {
    const { rerender } = await render(<Harness timer={rest()} />);
    await moveTo('background');
    await moveTo('active');
    await rerender(<Harness timer={null} />);
    await rerender(<Harness timer={rest({ endsAt: NOW + 180_000, total: 180, label: 'Squat' })} />);
    await moveTo('background');

    expect(scheduledSeconds()).toEqual([90, 180]);
  });

  it('a countdown that changes while away is re-planned: stopped clears, restarted reschedules', async () => {
    const { rerender } = await render(<Harness timer={rest()} />);
    await moveTo('inactive');
    expect(scheduledSeconds()).toEqual([90]);

    await rerender(<Harness timer={null} />);
    await settle();
    expect(mockCancel).toHaveBeenCalledTimes(1);

    await rerender(<Harness timer={rest({ endsAt: NOW + 60_000, total: 60 })} />);
    await settle();
    expect(scheduledSeconds()).toEqual([90, 60]);
  });

  it('leaving the session screen while armed cancels it', async () => {
    const { unmount } = await render(<Harness timer={rest()} />);
    await moveTo('background');
    await unmount();
    await settle();
    expect(mockCancel).toHaveBeenCalledWith(REST_ALERT_ID);
  });

  it('serialised: unlocking before the schedule has finished still ends cancelled', async () => {
    let release!: (v: unknown) => void;
    mockGetPermissions.mockReset().mockImplementation(() => new Promise((r) => (release = r)));

    await render(<Harness timer={rest()} />);
    // Lock, and unlock straight away, while the lock's permission read is still pending.
    appState = 'background';
    await act(async () => {
      listener?.('background');
    });
    await settle();
    appState = 'active';
    await act(async () => {
      listener?.('active');
    });
    await settle();
    expect(mockSchedule).not.toHaveBeenCalled();

    await act(async () => {
      release(GRANTED);
    });
    await settle();

    // The schedule landed, and the cancel waited for it rather than running first.
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.invocationCallOrder[0]).toBeGreaterThan(mockSchedule.mock.invocationCallOrder[0]);
  });
});

describe('opt-in', () => {
  it('preference off: locking schedules nothing', async () => {
    await writeRestLockAlertEnabled(USER, false);
    const { rerender } = await render(<Harness timer={rest()} />);
    await moveTo('background');
    expect(mockSchedule).not.toHaveBeenCalled();

    // Positive control: turned on, the next lock schedules.
    await moveTo('active');
    await writeRestLockAlertEnabled(USER, true);
    await rerender(<Harness timer={rest()} />);
    await moveTo('background');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('permission not granted: locking schedules nothing, and does not ask', async () => {
    mockGetPermissions.mockReset().mockResolvedValue({ granted: false, canAskAgain: true, status: 'undetermined' });
    await render(<Harness timer={rest()} />);
    await moveTo('background');
    expect(mockGetPermissions).toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();

    // Positive control: granted, the next lock schedules.
    mockGetPermissions.mockReset().mockResolvedValue(GRANTED);
    await moveTo('active');
    await moveTo('background');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('no signed-in user: schedules nothing', async () => {
    const { rerender } = await render(<Harness timer={rest()} userId={null} />);
    await moveTo('background');
    expect(mockSchedule).not.toHaveBeenCalled();

    await moveTo('active');
    await rerender(<Harness timer={rest()} userId={USER} />);
    await moveTo('background');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two call sites, read from source.
 *
 * Everything above tests the hook and the adapter. What no render test here
 * reaches is whether the app CALLS them. The session screen is ~4,000 lines
 * behind a dozen mocks, and the root layout's launch-time cancel has no
 * observable output. Same approach `components/__tests__/timerContinuity.test.tsx`
 * takes for what a render cannot show. Comment lines are dropped first, so a
 * call left only inside a comment does not count.
 */
describe('wiring', () => {
  const { readFileSync } = jest.requireActual<typeof import('fs')>('fs');
  const { join } = jest.requireActual<typeof import('path')>('path');
  const code = (rel: string) =>
    readFileSync(join(__dirname, '..', '..', rel), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('the session screen keeps the alert in step with its countdown', () => {
    expect(code('app/session/[id].tsx')).toMatch(/^\s*useRestLockAlert\(timerState\.timer, userId\);$/m);
  });

  it('the root layout clears an alert left by a previous process, at launch', () => {
    expect(code('app/_layout.tsx')).toMatch(/^\s*void cancelRestLockAlert\(\);$/m);
  });
});
