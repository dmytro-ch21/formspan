import { AppState } from 'react-native';

import { OfflineError } from '../apiError';
import { countPendingSessions, syncSessions, type SessionSyncResult } from '../sessionStore';
import { request, setSyncIdentity, startSyncOrchestrator, syncNow, syncState } from '../sync';

/**
 * The sync orchestrator.
 *
 * `failures` and the backoff timer are module state that only resets on
 * success, so a test asserting "no retry was scheduled" can pass simply
 * because the ladder had already climbed to five minutes. That happened: the
 * permanent-rejection test below was green with its guard deleted. Every
 * "does not retry" assertion is now paired with a control proving a retry
 * *would* have happened at the same rung.
 */

jest.mock('../sessionStore', () => ({
  syncSessions: jest.fn(),
  countPendingSessions: jest.fn(),
}));

const mockSync = syncSessions as jest.MockedFunction<typeof syncSessions>;
const mockCount = countPendingSessions as jest.MockedFunction<typeof countPendingSessions>;

const ok = (): SessionSyncResult => ({ pushed: 1, pulled: 0, failed: 0, deferred: 0 });
const failed = (kind: SessionSyncResult['errorKind'], error = 'nope'): SessionSyncResult => ({
  pushed: 0,
  pulled: 0,
  failed: 1,
  deferred: 0,
  error,
  errorKind: kind,
});

const token = async () => 'tok';

/**
 * Advance both the clock and the microtask queue.
 *
 * Fake timers throughout: the backoff ladder starts at five seconds, and
 * waiting that in real time blew jest's default timeout AND made the suite
 * slow enough that nobody would run it. `advanceTimersByTimeAsync` also
 * flushes promises, which is what the orchestrator's awaits need.
 */
const settle = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

/** Put the backoff ladder back to rung 0 so a 5s wait means something. */
async function resetLadder() {
  mockSync.mockResolvedValue(ok());
  await syncNow();
}

beforeEach(async () => {
  jest.useFakeTimers();
  setSyncIdentity(null, null);
  mockSync.mockReset();
  mockCount.mockReset();
  mockCount.mockResolvedValue(0);
  mockSync.mockResolvedValue(ok());
});

it('coalesces a burst into the run in flight plus one', async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => {
    release = r;
  });
  mockSync.mockImplementation(async () => {
    await slow;
    return ok();
  });

  setSyncIdentity('user_1', token);
  await settle();
  for (let i = 0; i < 10; i++) request('burst');
  release();
  await settle(20);

  expect(mockSync).toHaveBeenCalledTimes(2);
});

it('reports offline only when the sync could not reach the server', async () => {
  mockCount.mockResolvedValue(1);
  mockSync.mockResolvedValue(failed('offline'));
  setSyncIdentity('user_1', token);
  await settle(20);
  expect(syncState().online).toBe(false);

  mockSync.mockResolvedValue(ok());
  await syncNow();
  expect(syncState().online).toBe(true);
  expect(syncState().lastError).toBeNull();
  expect(syncState().lastSyncAt).toEqual(expect.any(Number));
});

it('treats a server refusal as ONLINE — it answered, it just said no', async () => {
  mockCount.mockResolvedValue(1);
  mockSync.mockResolvedValue(failed('permanent', 'Session already finished.'));
  setSyncIdentity('user_1', token);
  await settle(20);
  expect(syncState().online).toBe(true);
});

describe('retry scheduling', () => {
  it('retries a transient failure', async () => {
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue(failed('transient'));
    await syncNow();

    const before = mockSync.mock.calls.length;
    await settle(5_300); // past BACKOFF_MS[0]
    expect(mockSync.mock.calls.length).toBeGreaterThan(before);
  });

  it('does NOT retry a permanent rejection, which would grind forever', async () => {
    // A refused row keeps dirty = 1, so `pending` never reaches 0 — without
    // this guard the 5-minute tail re-arms for the life of the install.
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue(failed('permanent'));
    await syncNow();

    const before = mockSync.mock.calls.length;
    await settle(5_300);
    expect(mockSync.mock.calls.length).toBe(before);
  });

  it('schedules nothing when there is nothing pending', async () => {
    mockCount.mockResolvedValue(0);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue(failed('transient'));
    await syncNow();

    const before = mockSync.mock.calls.length;
    await settle(5_300);
    expect(mockSync.mock.calls.length).toBe(before);
  });
});

it('syncNow actually attempts rather than being stolen by a queued re-fire', async () => {
  // run()'s finally re-fires when dirtyAgain is set, occupying `running` in
  // the same microtask that resolves a single `await running` — so a manual
  // sync could hit the in-flight guard, do nothing, and report the previous
  // run's error while stopping the spinner.
  let release!: () => void;
  const slow = new Promise<void>((r) => {
    release = r;
  });
  mockSync.mockImplementationOnce(async () => {
    await slow;
    return ok();
  });

  setSyncIdentity('user_1', token);
  await settle();
  request('queued-during-run');
  const manual = syncNow();
  release();
  await manual;

  expect(mockSync.mock.calls.length).toBeGreaterThanOrEqual(3);
});

describe('after sign-out', () => {
  it('runs nothing', async () => {
    mockCount.mockResolvedValue(3);
    setSyncIdentity('user_1', token);
    await settle(20);
    setSyncIdentity(null, null);

    const before = mockSync.mock.calls.length;
    request('after-signout');
    await settle(20);
    expect(mockSync.mock.calls.length).toBe(before);
  });

  it('does not claim everything is safely synced', async () => {
    mockCount.mockResolvedValue(3);
    setSyncIdentity('user_1', token);
    await settle(20);
    setSyncIdentity(null, null);
    expect(syncState().pending).toBe(0);
    expect(syncState().lastSyncAt).toBeNull();
  });
});

afterAll(() => jest.useRealTimers());

describe('when the sync THROWS rather than reporting a failure count', () => {
  // The mock always resolved before, so this whole catch — including the
  // online classification — was uncovered, and inverting it survived the
  // suite despite a test titled "reports offline only when the sync could not
  // reach the server".
  it('classifies an OfflineError as offline', async () => {
    mockCount.mockResolvedValue(1);
    mockSync.mockRejectedValue(new OfflineError());
    setSyncIdentity('user_1', token);
    await settle(20);
    expect(syncState().online).toBe(false);
    expect(syncState().lastError).toEqual(expect.any(String));
  });

  it('does not claim offline for a thrown error that is not one', async () => {
    mockCount.mockResolvedValue(1);
    mockSync.mockRejectedValue(new Error('something else broke'));
    setSyncIdentity('user_1', token);
    await settle(20);
    expect(syncState().online).toBe(true);
  });

  it('leaves syncing false rather than stuck on', async () => {
    mockSync.mockRejectedValue(new OfflineError());
    setSyncIdentity('user_1', token);
    await settle(20);
    expect(syncState().syncing).toBe(false);
  });
});

describe('the foreground trigger', () => {
  // The module's own comment calls this "the trigger that matters most" — it
  // is what makes "walk out of a basement and open the app" sync — and it had
  // no test at all. Importable AppState was half the reason for jest-expo.
  /**
   * Capture the handler the orchestrator registers, by spying on AppState
   * rather than mocking the whole of react-native — mocking the module wholesale
   * breaks Expo's global installation and takes the other suites down with it.
   */
  let handler: ((s: string) => void) | undefined;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    handler = undefined;
    spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      fn: (s: string) => void,
    ) => {
      handler = fn;
      return { remove: () => void (handler = undefined) };
    }) as never);
  });

  afterEach(() => spy.mockRestore());

  const fire = () => handler!;

  it('syncs when the app returns to the foreground with work pending', async () => {
    mockCount.mockResolvedValue(2);
    setSyncIdentity('user_1', token);
    await settle(20);
    const stop = startSyncOrchestrator();

    const before = mockSync.mock.calls.length;
    fire()('background');
    fire()('active');
    await settle(20);

    expect(mockSync.mock.calls.length).toBeGreaterThan(before);
    stop();
  });

  it('does not sync on a transition that is not a return', async () => {
    mockCount.mockResolvedValue(2);
    setSyncIdentity('user_1', token);
    await settle(20);
    const stop = startSyncOrchestrator();

    const before = mockSync.mock.calls.length;
    fire()('inactive'); // active -> inactive is leaving, not returning
    await settle(20);

    expect(mockSync.mock.calls.length).toBe(before);
    stop();
  });
});
