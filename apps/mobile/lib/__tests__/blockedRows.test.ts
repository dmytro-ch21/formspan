import { ApiError } from '../apiError';
import { blockedRows, syncSessions } from '../sessionStore';
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
    { kind: 'session', id: 's1', name: 'Leg Day', lastError: 'Session already finished' },
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
