import { ApiError } from '../apiError';
import { blockedRows, retryBlockedRow, syncSessions } from '../sessionStore';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * A row the server refuses forever must say so, by name, and survive a
 * relaunch.
 *
 * Before this, a permanent rejection was one screen-level message for the
 * whole run that vanished on the next attempt — so a session the server will
 * never accept looked exactly like one that simply had not been tried yet.
 * Stored per row (schema v11) because the moment someone goes looking is
 * usually a launch or two later.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const mockPushSets = jest.fn();
jest.mock('../sessions', () => ({
  // Spread the real module FIRST. This factory replaces `../sessions`
  // wholesale, and `sessionStore` imports pure helpers from it as well as the
  // API calls — `repairSet` among them, which every parsed set now passes
  // through. Listing only the calls left those undefined, and the suite passed
  // solely because every fixture here stores `'[]'`: the first test with a set
  // in it would have crashed on a mock that looked complete.
  ...jest.requireActual('../sessions'),
  renameSession: jest.fn(),
  startSession: jest.fn(),
  replaceSets: (...a: unknown[]) => mockPushSets(...a),
  finishSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  listSessions: jest.fn(async () => []),
}));
jest.mock('../workouts', () => ({
  createWorkout: jest.fn(),
  replaceItems: jest.fn(),
  deleteWorkout: jest.fn(),
  listWorkouts: jest.fn(),
  getWorkout: jest.fn(),
}));

const token = async () => 'tok';

const seedSession = async (id = 's1', name = 'Leg Day') => {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at)
     VALUES (?, 'u1', NULL, 'strength', ?, '2026-08-01T10:00:00Z', NULL, '',
             '[]', 1, 1, NULL, '2026-08-01T10:00:00Z')`,
    id,
    name,
  );
};

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockPushSets.mockReset().mockResolvedValue(undefined);
});

it('records a permanent refusal against the row, with what the server said', async () => {
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('Session already finished', 'invalid_input', 400));

  await syncSessions('u1', token);

  expect(await blockedRows('u1')).toEqual([
    {
      kind: 'session',
      id: 's1',
      name: 'Leg Day',
      lastError: 'Session already finished',
      // Carried so the repair screen can open the right screen — a BJJ class
      // and a strength session are different ones.
      sport: 'strength',
    },
  ]);
});

it('does NOT record a transient failure', async () => {
  // Being in a basement is the ordinary state, not a repair item. Listing it
  // would turn the repair screen into a list of everything ever logged
  // offline, none of which needs a person.
  await seedSession();
  mockPushSets.mockRejectedValue(new Error('Network request failed'));

  await syncSessions('u1', token);

  expect(await blockedRows('u1')).toEqual([]);
});

it('clears the error once the row finally goes through', async () => {
  // A row refused because its workout had not landed yet, then accepted.
  // Keeping the old message would report a fixed row as still broken.
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('unknown workout', 'invalid_input', 400));
  await syncSessions('u1', token);
  expect(await blockedRows('u1')).toHaveLength(1);

  await db.runAsync(`UPDATE local_sessions SET dirty = 1 WHERE id = 's1'`);
  mockPushSets.mockResolvedValue(undefined);
  await syncSessions('u1', token);

  // Asserted on the COLUMN, not via blockedRows. A successful push also
  // clears `dirty`, and blockedRows filters on that — so checking the list
  // would pass whether or not the message was cleared, which is exactly what
  // the first version of this test did. The stale message matters because the
  // row can go dirty again later and would then reappear wearing an error
  // that has already been resolved.
  const row = await db.getFirstAsync<{ last_error: string | null }>(
    `SELECT last_error FROM local_sessions WHERE id = 's1'`,
  );
  expect(row?.last_error).toBeNull();
});

it('survives a relaunch — the message is on the row, not in memory', async () => {
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('refused', 'invalid_input', 400));
  await syncSessions('u1', token);

  // A fresh read with no sync run in between is what a relaunch looks like.
  expect((await blockedRows('u1'))[0].lastError).toBe('refused');
});

it('keeps one athlete off another athlete repair list', async () => {
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('refused', 'invalid_input', 400));
  await syncSessions('u1', token);

  expect(await blockedRows('u2')).toEqual([]);
});

it('drops a row from the list once it is no longer owed', async () => {
  // `dirty = 1` is part of the query on purpose: a stale error on a clean row
  // is history, not a repair item.
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('refused', 'invalid_input', 400));
  await syncSessions('u1', token);

  await db.runAsync(`UPDATE local_sessions SET dirty = 0 WHERE id = 's1'`);

  expect(await blockedRows('u1')).toEqual([]);
});

/*
 * "I press Try again, the row disappears, and then it comes back."
 *
 * `retryBlockedRow` cleared the stored message BEFORE pushing and never wrote
 * one back, so a retry that failed left a still-dirty, still-doomed row with no
 * error against it. The repair screen reloads straight after the retry, finds
 * nothing, and renders **"Nothing is stuck"** — until the next background sync
 * pushes the same row, fails the same way, records the message again and brings
 * it back.
 *
 * Both halves are asserted because either alone is satisfiable by doing nothing:
 * never clearing passes the first, never retrying passes the second.
 */
it('keeps a row on the list when the retry is refused again', async () => {
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('set 10: weight must be greater than 0', 'invalid_input', 400));
  await syncSessions('u1', token);
  const [row] = await blockedRows('u1');

  await expect(retryBlockedRow('u1', row, token)).rejects.toThrow();

  const after = await blockedRows('u1');
  expect(after).toHaveLength(1);
  expect(after[0].lastError).toBe('set 10: weight must be greater than 0');
});

it('drops a row from the list when the retry goes through', async () => {
  await seedSession();
  mockPushSets.mockRejectedValue(new ApiError('refused', 'invalid_input', 400));
  await syncSessions('u1', token);
  const [row] = await blockedRows('u1');

  // The obstacle moved — which is the case "Try again" exists for.
  await db.runAsync(`UPDATE local_sessions SET dirty = 1 WHERE id = 's1'`);
  mockPushSets.mockResolvedValue(undefined);
  await retryBlockedRow('u1', row, token);

  expect(await blockedRows('u1')).toEqual([]);
  // On the COLUMN as well, for the reason the clearing test above states: the
  // list filters on `dirty`, so it would go empty either way.
  const stored = await db.getFirstAsync<{ last_error: string | null }>(
    `SELECT last_error FROM local_sessions WHERE id = 's1'`,
  );
  expect(stored?.last_error).toBeNull();
});

it('keeps the message when a retry pushes nothing at all', async () => {
  // A session whose workout has not reached the server is DEFERRED:
  // `pushSession` returns early, resolving without having sent a request. That
  // is neither success nor failure, and treating it as success is the second
  // way the old code emptied the repair list without repairing anything.
  await db.runAsync(
    `INSERT INTO workout_cache (id, user_id, sport, name, goal, items_json, dirty, remote, cached_at)
     VALUES ('w1', 'u1', 'strength', 'Leg Day', NULL, '[]', 1, 0, '2026-08-01T10:00:00Z')`,
  );
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, last_error)
     VALUES ('s2', 'u1', 'w1', 'strength', 'Leg Day', '2026-08-01T10:00:00Z', NULL, '',
             '[]', 1, 1, NULL, '2026-08-01T10:00:00Z', 'set 10: weight must be greater than 0')`,
  );
  const row = (await blockedRows('u1')).find((r) => r.id === 's2')!;

  await retryBlockedRow('u1', row, token);

  expect(mockPushSets).not.toHaveBeenCalled();
  const after = await blockedRows('u1');
  expect(after.map((r) => r.id)).toContain('s2');
  expect(after.find((r) => r.id === 's2')?.lastError).toBe(
    'set 10: weight must be greater than 0',
  );
});

/*
 * The set that stranded a whole session.
 *
 * The set editor stores whatever is typed, so a `0` in the weight field is
 * stored as `0` — and the API refuses any measure that is present and not
 * greater than zero, with a 400, which classifies as PERMANENT. One keystroke
 * therefore parks an entire session on the phone forever: dirty, listed on the
 * repair screen, and retried identically every time.
 *
 * The repair runs at the read, so it covers the rows already stuck rather than
 * only the ones logged after the fix. Asserted on what actually goes out —
 * checking the stored blob would prove nothing about the request that failed.
 */
it('never sends a measure the server refuses, and unsticks a row that has one', async () => {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, last_error)
     VALUES ('s3', 'u1', NULL, 'strength', 'Workout 1', '2026-08-01T10:00:00Z', NULL, '',
             ?, 1, 1, NULL, '2026-08-01T10:00:00Z', 'set 10: weight must be greater than 0')`,
    JSON.stringify([
      { exercise_id: 'squat', position: 0, set_type: 'working', reps: 5, weight_kg: 100,
        seconds: null, distance_m: null, rir: 0, rpe: 8, notes: '', completed: true },
      { exercise_id: 'squat', position: 1, set_type: 'working', reps: 5, weight_kg: 0,
        seconds: null, distance_m: null, rir: null, rpe: 0, notes: '', completed: true },
    ]),
  );

  await syncSessions('u1', token);

  const sent = mockPushSets.mock.calls[0][2] as { weight_kg: number | null; rpe: number | null; rir: number | null }[];
  expect(sent[1].weight_kg).toBeNull();
  // Out of range at the bottom of its scale, so as unstorable as the zero
  // weight — RPE starts at 1.
  expect(sent[1].rpe).toBeNull();
  // NOT nulled. 0 RIR is a real answer — nothing left in the tank — and the
  // server accepts it. Nulling it would delete data to fix a different bug.
  expect(sent[0].rir).toBe(0);
  expect(sent[0].weight_kg).toBe(100);

  // And the row is no longer on the repair list, which is the whole point:
  // the session the athlete could not get off their phone is now off it.
  expect(await blockedRows('u1')).toEqual([]);
});
