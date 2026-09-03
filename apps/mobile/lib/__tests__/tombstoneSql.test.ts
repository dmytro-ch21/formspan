import {
  countPendingSessions,
  deleteLocalSession,
  listLocalSessions,
  readLocalSession,
  upsert,
} from '../sessionStore';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The tombstone behaviour that only real SQL can prove.
 *
 * The array-mock suite covers the *decisions*; these cover the statements.
 * Two guards previously had to be pinned by asserting on query TEXT — which
 * shows a clause is present, not that SQLite honours it. These execute it.
 */

let db: FixtureDb;
// `mock`-prefixed so the jest.mock factory may close over it.
let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const seedSession = async (over: Record<string, unknown> = {}) => {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at)
     VALUES (?, ?, NULL, 'strength', 'Back', '2026-08-01T10:00:00Z', NULL, '',
             '[]', ?, ?, ?, ?)`,
    (over.id as string) ?? 's1',
    'u1',
    (over.dirty as number) ?? 0,
    (over.remote as number) ?? 1,
    (over.deleted_at as string | null) ?? null,
    (over.updated_at as string) ?? '2026-08-01T10:00:00Z',
  );
};

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

it('the upsert genuinely refuses to write over a tombstone', async () => {
  // Calls the APP's upsert, not a hand-written copy of its SQL. The first
  // version of this test inlined its own INSERT ... ON CONFLICT with the
  // WHERE clause included, so it passed with the production clause deleted —
  // it was testing the test. Caught by mutating and watching nothing fail.
  await seedSession({ remote: 1, dirty: 0 });
  await deleteLocalSession('u1', 's1');

  await upsert(
    {
      id: 's1',
      user_id: 'u1',
      workout_id: null,
      sport: 'strength',
      name: 'Back',
      intent: 'normal',
      started_at: '2026-08-01T10:00:00Z',
      ended_at: null,
      notes: '',
      sets: [],
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-09T00:00:00Z',
      dirty: false,
    },
    'u1',
    false,
    true,
  );

  const row = await db.getFirstAsync<{ dirty: number; deleted_at: string | null }>(
    `SELECT dirty, deleted_at FROM local_sessions WHERE id = 's1'`,
  );
  // Still buried, and still owed to the server.
  expect(row?.deleted_at).toEqual(expect.any(String));
  expect(row?.dirty).toBe(1);
});

it('deleteLocalSession marks the row dirty in the actual database', async () => {
  await seedSession({ remote: 1, dirty: 0 });
  await deleteLocalSession('u1', 's1');

  const row = await db.getFirstAsync<{ dirty: number; deleted_at: string | null }>(
    `SELECT dirty, deleted_at FROM local_sessions WHERE id = 's1'`,
  );
  expect(row?.dirty).toBe(1);
  expect(row?.deleted_at).toEqual(expect.any(String));
});

it('listLocalSessions really hides a tombstoned session', async () => {
  await seedSession({ id: 's1' });
  await seedSession({ id: 's2' });
  await deleteLocalSession('u1', 's1');

  const ids = (await listLocalSessions('u1')).map((s) => s.id);
  expect(ids).toEqual(['s2']);
});

it('readLocalSession really returns null for one', async () => {
  await seedSession();
  await deleteLocalSession('u1', 's1');
  expect(await readLocalSession('u1', 's1')).toBeNull();
});

it('countPendingSessions really counts a pending delete', async () => {
  // Load-bearing: schedule() refuses to arm the backoff at pending === 0, so
  // if this excluded tombstones a device whose only dirty row is a delete
  // would never retry it.
  await seedSession({ remote: 1, dirty: 0 });
  expect(await countPendingSessions('u1')).toBe(0);

  await deleteLocalSession('u1', 's1');
  expect(await countPendingSessions('u1')).toBe(1);
});

it('deleting twice does not re-stamp the row', async () => {
  // Deterministic by backdating. The first version compared two
  // `new Date().toISOString()` values taken microseconds apart — measured at
  // 999/1000 sharing the millisecond — so removing `AND deleted_at IS NULL`
  // produced an identical string and the test passed. A guard that catches a
  // bug by coin-flip is not a guard.
  await seedSession({ remote: 1 });
  await deleteLocalSession('u1', 's1');

  const OLD = '2026-07-01T00:00:00.000Z';
  await db.runAsync(
    `UPDATE local_sessions SET deleted_at = ?, updated_at = ? WHERE id = 's1'`,
    OLD,
    OLD,
  );

  await deleteLocalSession('u1', 's1');

  // Unchanged — the second delete must find nothing to do. The CAS that a
  // push in flight relies on keys off updated_at, so re-stamping it here
  // would silently strand that push's completion.
  const row = await db.getFirstAsync<{ deleted_at: string; updated_at: string }>(
    `SELECT deleted_at, updated_at FROM local_sessions WHERE id = 's1'`,
  );
  expect(row?.updated_at).toBe(OLD);
  expect(row?.deleted_at).toBe(OLD);
});

it('upsert still updates a LIVE row', async () => {
  // Companion to the tombstone test above, whose expected outcome is
  // "nothing happened" — indistinguishable from an upsert that no longer
  // works at all, or an over-broad WHERE that blocks every update. In
  // production that would mean pulled server changes silently never landing.
  await seedSession({ remote: 1, dirty: 0 });
  await upsert(
    {
      id: 's1', user_id: 'u1', workout_id: null, sport: 'strength',
      name: 'Renamed', intent: 'normal', started_at: '2026-08-01T10:00:00Z', ended_at: null,
      notes: '', sets: [], created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-09T00:00:00Z', dirty: false,
    },
    'u1', false, true,
  );

  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM local_sessions WHERE id = 's1'`,
  );
  expect(row?.name).toBe('Renamed');
});
