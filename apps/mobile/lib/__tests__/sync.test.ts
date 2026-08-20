import { AppState } from 'react-native';

import { OfflineError } from '../apiError';
import {
  countPendingSessions,
  countPendingWorkouts,
  syncSessions,
  type SessionSyncResult,
} from '../sessionStore';
import {
  refreshPending,
  request,
  setSyncIdentity,
  startSyncOrchestrator,
  syncNow,
  syncState,
} from '../sync';

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
  // `pending` gates the retry timer and the foreground trigger, and it is the
  // SUM of both outboxes. Omitting this made `refreshPending` throw into its
  // own swallowing catch, leaving pending at 0 — so the ladder and the
  // foreground sync silently stopped, which is what the two tests below
  // caught when workouts joined the count.
  countPendingWorkouts: jest.fn(async () => 0),
}));

// The third outbox, and the third time this mock has had to grow.
//
// `pending` is the SUM across all of them, so a missing count here throws
// inside `refreshPending`'s own swallowing catch and leaves pending at 0 —
// which silently stops the retry ladder and the foreground trigger. That is
// exactly what happened when workouts joined the count (see the note above)
// and it happened again when plans did. The two tests below are what catch it.
jest.mock('../plan', () => ({
  countPendingPlans: jest.fn(async () => 0),
  syncPlans: jest.fn(async () => ({ pushed: 0, pulled: 0, failed: 0, deferred: 0 })),
}));

// The third outbox. Mocked for the same reason as the other two — the real
// module opens SQLite, which jest-expo stubs out, so leaving it real makes
// every test in this file die inside `NativeDatabase` with an error that says
// nothing about the orchestrator. Note it has NO `deferred`: a captured chain
// cannot be waiting on another local row to land first.
jest.mock('../sequences', () => ({
  pendingSequenceCount: jest.fn(async () => 0),
  syncSequences: jest.fn(async () => ({ pushed: 0, failed: 0 })),
}));

// The FOURTH outbox, and this mock has now grown four times. Same reason as
// the other three: the real module opens SQLite, which jest-expo stubs out, so
// leaving it real kills every test in this file inside `NativeDatabase` with an
// error that says nothing about the orchestrator.
//
// Like sequences it has NO `deferred` — a logged meal cannot be waiting on
// another local row to land first.
jest.mock('../foodLog', () => ({
  pendingFoodCount: jest.fn(async () => 0),
  syncFood: jest.fn(async () => ({ pushed: 0, failed: 0 })),
}));

// The FIFTH outbox, and this mock has now grown five times — which is itself
// the finding: every feature that logs something adds one, and the orchestrator
// is the one place that has to know about all of them. Same reason as the other
// four: the real module opens SQLite, which jest-expo stubs out.
//
// Like sequences and food it has NO `deferred` — a tapped cup cannot be waiting
// on another local row to land first. (Its own internal ordering, definitions
// before entries, is `trackers.ts`'s business and is tested there.)
jest.mock('../trackers', () => ({
  pendingTrackerCount: jest.fn(async () => 0),
  syncTrackers: jest.fn(async () => ({ pushed: 0, failed: 0 })),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock above
import { pendingFoodCount, syncFood } from '../foodLog';
// eslint-disable-next-line import/first -- must follow the jest.mock above
import { pendingTrackerCount, syncTrackers } from '../trackers';
// eslint-disable-next-line import/first -- must follow the jest.mock above
import { countPendingPlans } from '../plan';
// eslint-disable-next-line import/first -- must follow the jest.mock above
import { pendingSequenceCount, syncSequences } from '../sequences';

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

it('reports deferred rows without calling them a failure', async () => {
  // A session whose workout has not reached the server is waiting on a
  // dependency, not broken — and since the FK error is a 4xx, and 4xx
  // classifies as permanent, calling it a failure would make the
  // orchestrator give up retrying perfectly good training.
  mockCount.mockResolvedValue(1);
  mockSync.mockResolvedValue({ pushed: 0, pulled: 0, failed: 0, deferred: 2 });
  setSyncIdentity('user_1', token);
  await settle(20);

  expect(syncState().deferred).toBe(2);
  expect(syncState().lastError).toBeNull();
  expect(syncState().online).toBe(true);
});

describe('the pending count', () => {
  it('includes dirty WORKOUTS, not just sessions', async () => {
    // `pending` is not a badge number — it gates `schedule()` (which refuses
    // to set a retry timer at 0) and the foreground trigger. Counting
    // sessions only meant an edited plan that failed transiently got no
    // backoff retry and no foreground retry, and could sit on the device
    // indefinitely.
    (countPendingSessions as jest.Mock).mockResolvedValue(0);
    (countPendingWorkouts as jest.Mock).mockResolvedValue(3);

    setSyncIdentity('u1', async () => 'tok');
    await refreshPending();

    expect(syncState().pending).toBe(3);
  });

  it('sums both outboxes', async () => {
    (countPendingSessions as jest.Mock).mockResolvedValue(2);
    (countPendingWorkouts as jest.Mock).mockResolvedValue(3);

    setSyncIdentity('u1', async () => 'tok');
    await refreshPending();

    expect(syncState().pending).toBe(5);
  });

  it('includes captured SEQUENCES, not just sessions and workouts', async () => {
    // Added after review pointed out that NOTHING here failed if sequences
    // were unwired from the orchestrator — the mocks returned 0 and every
    // assertion summed the other two, so deleting `pendingSequenceCount` from
    // `refreshPending` kept the suite green. Same consequence as the workouts
    // case above: a chain captured in a gym dead-spot would get no backoff
    // retry and no foreground retry, and would sit on the device while the
    // screen reported nothing owed.
    (countPendingSessions as jest.Mock).mockResolvedValue(1);
    (countPendingWorkouts as jest.Mock).mockResolvedValue(1);
    (pendingSequenceCount as jest.Mock).mockResolvedValue(4);

    setSyncIdentity('u1', async () => 'tok');
    await refreshPending();

    expect(syncState().pending).toBe(6);
  });

  it('includes logged FOOD, not just the other three', async () => {
    // The fourth time this has needed writing, and for the fourth identical
    // reason: every mock returns 0, so every other assertion here sums the
    // other three and stays green with `pendingFoodCount` unwired from
    // `refreshPending`.
    //
    // The consequence is the worst of the four. A meal logged in a restaurant
    // basement would get no backoff retry and no foreground retry, and would
    // sit on the device while the screen reported nothing owed — and unlike a
    // session, the athlete has no way to notice, because the day screen reads
    // the local row and looks perfectly correct.
    // Every count set explicitly, including the ones this test is not about.
    // The suite does not reset these between cases, so relying on a default of
    // 0 makes the expected sum depend on which test ran before this one.
    (countPendingSessions as jest.Mock).mockResolvedValue(1);
    (countPendingWorkouts as jest.Mock).mockResolvedValue(1);
    (countPendingPlans as jest.Mock).mockResolvedValue(0);
    (pendingSequenceCount as jest.Mock).mockResolvedValue(0);
    (pendingFoodCount as jest.Mock).mockResolvedValue(5);
    (pendingTrackerCount as jest.Mock).mockResolvedValue(0);

    setSyncIdentity('u1', async () => 'tok');
    await refreshPending();

    expect(syncState().pending).toBe(7);
  });

  it('includes tapped TRACKERS, not just the other four', async () => {
    // The fifth time this has needed writing, and for the fifth identical
    // reason: every mock returns 0, so every other assertion here sums the
    // other four and stays green with `pendingTrackerCount` unwired from
    // `refreshPending`.
    //
    // The consequence is the quietest of the five. `schedule()` refuses a retry
    // timer when it reads 0 pending, so a cup tapped in a gym with no signal
    // would get no backoff retry and no foreground retry — and the card reads
    // the local row, so it looks perfectly correct while the sync screen
    // reports nothing owed. That reads as "it saved", which is exactly the
    // reassurance that must not be false.
    (countPendingSessions as jest.Mock).mockResolvedValue(1);
    (countPendingWorkouts as jest.Mock).mockResolvedValue(0);
    (countPendingPlans as jest.Mock).mockResolvedValue(0);
    (pendingSequenceCount as jest.Mock).mockResolvedValue(0);
    (pendingFoodCount as jest.Mock).mockResolvedValue(0);
    (pendingTrackerCount as jest.Mock).mockResolvedValue(3);

    setSyncIdentity('u1', async () => 'tok');
    await refreshPending();

    expect(syncState().pending).toBe(4);
  });
});

describe('trackers in the merge', () => {
  it('surfaces a tracker failure the way it surfaces every other one', async () => {
    // Mirrors the food case above. Without the tracker terms in the merged
    // result, a tap that failed to send reports nothing at all: the banner
    // stays clean and the athlete has no way to know, because the card reads
    // the local row and looks perfectly correct.
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue({ pushed: 0, pulled: 0, failed: 0, deferred: 0 });
    (syncTrackers as jest.Mock).mockResolvedValue({
      pushed: 0,
      failed: 1,
      error: 'cup refused',
      errorKind: 'transient',
    });
    await syncNow();

    expect(syncState().lastError).toBe('cup refused');
    expect(syncState().online).toBe(true);

    (syncTrackers as jest.Mock).mockResolvedValue({ pushed: 0, failed: 0 });
  });

  it('reports OFFLINE when only the tracker push could not reach the server', async () => {
    // `rankKind` rather than `??`: offline outranks everything, whichever of
    // the five outboxes noticed it. With `??` the answer would depend on
    // position, and `online: true` while the phone is in a basement is the
    // claim that makes the sync screen useless.
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue({ pushed: 0, pulled: 0, failed: 0, deferred: 0 });
    (syncTrackers as jest.Mock).mockResolvedValue({
      pushed: 0,
      failed: 1,
      error: 'no signal',
      errorKind: 'offline',
    });
    await syncNow();

    expect(syncState().online).toBe(false);

    (syncTrackers as jest.Mock).mockResolvedValue({ pushed: 0, failed: 0 });
  });
});

describe('food in the merge', () => {
  it('surfaces a food failure the way it surfaces every other one', async () => {
    // Mirrors the sequences case immediately above. Without food's three terms
    // in the merged result, a meal that failed to send reports nothing at all:
    // the banner stays clean and the athlete has no way to know, because the
    // day screen reads the local row and looks perfectly correct.
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue({ pushed: 0, pulled: 0, failed: 0, deferred: 0 });
    (syncFood as jest.Mock).mockResolvedValue({
      pushed: 0,
      failed: 1,
      error: 'meal refused',
      errorKind: 'transient',
    });
    await syncNow();

    expect(syncState().lastError).toBe('meal refused');
    expect(syncState().online).toBe(true);
  });
});

describe('sequences in the three-way merge', () => {
  it('a permanently-refused session must not stop a sequence being retried', async () => {
    // THE CASE THAT DISTINGUISHES `rankKind` FROM `??`, and the reason the
    // merge ranks rather than coalesces. With `??` the session's `permanent`
    // wins by position, `retry = kind !== 'permanent'` is false, and a chain
    // that failed on a perfectly retryable 5xx never goes again — for the life
    // of the install. Ranked, transient outranks permanent and the ladder
    // stays alive.
    //
    // My first attempt asserted `syncState().errorKind`, which is not a field
    // — and would have been satisfied by `??` anyway, since both arms give
    // 'transient' when only one is set. The observable difference is whether a
    // retry is scheduled.
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue(failed('permanent'));
    (syncSequences as jest.Mock).mockResolvedValue({
      pushed: 0,
      failed: 1,
      error: 'later',
      errorKind: 'transient',
    });
    await syncNow();

    const before = mockSync.mock.calls.length;
    await settle(5_300); // past BACKOFF_MS[0]
    expect(mockSync.mock.calls.length).toBeGreaterThan(before);
  });

  it('reports a sequence failure as ONLINE — the server answered', async () => {
    mockCount.mockResolvedValue(1);
    setSyncIdentity('user_1', token);
    await resetLadder();
    mockSync.mockResolvedValue({ pushed: 0, pulled: 0, failed: 0, deferred: 0 });
    (syncSequences as jest.Mock).mockResolvedValue({
      pushed: 0,
      failed: 1,
      error: 'chain refused',
      errorKind: 'transient',
    });
    await syncNow();

    expect(syncState().lastError).toBe('chain refused');
    expect(syncState().online).toBe(true);
  });
});
