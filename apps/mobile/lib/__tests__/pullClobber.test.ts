import { syncSessions, upsert, type LocalSession } from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * An edit made while the pull is deciding — T8.
 *
 * The pull already refuses two ways: it skips a row whose local copy is
 * `dirty = 1`, and it refuses to go backwards when the local `updated_at` is
 * newer. Both read a SNAPSHOT. An edit landing after those checks and before
 * the upsert is replaced by the server's older copy **and marked clean**, so it
 * is never pushed — the athlete's change is gone, `pending` reads zero, and the
 * newer-than guard stops the next pull reconciling it.
 *
 * The fix is the clause both siblings already carry — `plan.ts`'s upsert, whose
 * comment describes this exact clobber, and `cacheWorkouts`. Sessions were the
 * outbox missing it.
 *
 * **Why the guard is keyed on `excluded.dirty` and not on a parameter**, stated
 * accurately after review corrected me. It is a BACKSTOP, not the hot path.
 * Athlete edits — `saveLocalSets`, `renameLocalSession`, the delete — are
 * direct `UPDATE`s that never come through this upsert, and the only production
 * caller passing `dirty = 1` is `startLocalSession`, which inserts a fresh uuid
 * and so never conflicts. An unconditional `dirty = 0` would behave identically
 * in the app as it stands today.
 *
 * The disjunct earns its place the way the tombstone clause above it does: by
 * stating which write wins, so a future caller that DOES conflict gets the
 * right answer rather than silently losing an edit. The tests below pin that
 * rule in all four cells of (incoming dirty × existing dirty), because a rule
 * nothing exercises is a rule that decays into whatever the SQL happens to say.
 */

const AT = '2026-08-01T10:00:00.000Z';
const LATER = '2026-08-01T10:00:05.000Z';

const mockList = jest.fn();
jest.mock('../sessions', () => ({
  ...jest.requireActual('../sessions'),
  listSessions: (...a: unknown[]) => mockList(...a),
  startSession: jest.fn(),
  replaceSets: jest.fn(),
  finishSession: jest.fn().mockResolvedValue(undefined),
  renameSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
}));
jest.mock('../bjjSession', () => ({ putDetail: jest.fn() }));
jest.mock('../workouts', () => ({
  createWorkout: jest.fn(),
  replaceItems: jest.fn(),
  renameWorkout: jest.fn(),
  deleteWorkout: jest.fn(),
  listWorkouts: jest.fn(async () => []),
  getWorkout: jest.fn(),
}));

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const token = async () => 'tok';

const local = (over: Partial<LocalSession> = {}): LocalSession =>
  ({
    id: 's1',
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Bench',
    intent: 'normal',
    started_at: '2026-08-01T09:00:00Z',
    ended_at: AT,
    notes: '',
    sets: [],
    dirty: false,
    remote: true,
    updated_at: AT,
    ...over,
  }) as unknown as LocalSession;

const row = async () =>
  (await db.getFirstAsync<{ name: string; dirty: number }>(
    `SELECT name, dirty FROM local_sessions WHERE id = 's1'`,
  ))!;

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockList.mockReset();
  mockList.mockResolvedValue([]);
});

describe('the upsert both callers share', () => {
  it('lets a local edit land on top of an unsent local edit', async () => {
    // The ordinary case, and the one an unconditional `dirty = 0` guard would
    // have broken: type, type again, before anything syncs.
    await upsert(local({ name: 'First' }), 'u1', true, false);
    await upsert(local({ name: 'Second' }), 'u1', true, false);
    expect(await row()).toEqual({ name: 'Second', dirty: 1 });
  });

  it("lets the server's copy land on a row with nothing pending", async () => {
    // The other ordinary case: a clean row is exactly what the pull is for.
    await upsert(local({ name: 'Local' }), 'u1', false, true);
    await upsert(local({ name: 'FromServer' }), 'u1', false, true);
    expect(await row()).toEqual({ name: 'FromServer', dirty: 0 });
  });

  it('lets a local write land on a clean row', async () => {
    // The fourth cell, and the one that was missing: incoming dirty = 1 over
    // existing dirty = 0. Without it `excluded.dirty = local_sessions.dirty`
    // — a mutant that only ever writes when the two AGREE — passed every test
    // in this file. Found by review.
    await upsert(local({ name: 'FromServer' }), 'u1', false, true);
    await upsert(local({ name: 'MyEdit' }), 'u1', true, false);
    expect(await row()).toEqual({ name: 'MyEdit', dirty: 1 });
  });

  it("REFUSES the server's copy over an unsent edit", async () => {
    // T8. Without the clause the row becomes the server's name AND dirty = 0,
    // so the edit is neither on screen nor in the outbox.
    await upsert(local({ name: 'MyEdit' }), 'u1', true, false);
    await upsert(local({ name: 'FromServer' }), 'u1', false, true);
    expect(await row()).toEqual({ name: 'MyEdit', dirty: 1 });
  });

  it('still refuses to write over a tombstone', async () => {
    // The clause that was already there, and a fix for one half must not
    // disarm the other.
    //
    // The row is left CLEAN on purpose. The obvious version of this test
    // deletes a dirty row — and then the T8 clause declines the write, the
    // tombstone clause is never consulted, and the test passes with
    // `deleted_at IS NULL` deleted from the SQL. Mine did exactly that until
    // the mutation run caught it. A clean tombstone is the only state where
    // this clause is the one doing the work.
    await upsert(local({ name: 'Gone' }), 'u1', false, true);
    await db.runAsync(`UPDATE local_sessions SET deleted_at = ? WHERE id = 's1'`, AT);
    await upsert(local({ name: 'FromServer' }), 'u1', false, true);
    expect(await row()).toEqual({ name: 'Gone', dirty: 0 });
  });
});

describe('an edit that lands after the pull has decided', () => {
  it('survives, and stays in the outbox', async () => {
    // The race itself. The pull reads the local row, sees it clean, and is
    // then interrupted — the athlete saves an edit before the upsert runs.
    // Reproduced by dirtying the row from inside the SELECT the pull uses to
    // make that decision, which is the seam the real edit lands in.
    await upsert(local({ name: 'Clean' }), 'u1', false, true);

    mockList.mockResolvedValue([
      { ...local({ name: 'FromServer', updated_at: LATER }), sets: [] },
    ]);

    const realGetFirst = db.getFirstAsync.bind(db);
    let interrupted = false;
    db.getFirstAsync = (async (sql: string, ...args: unknown[]) => {
      const out = await realGetFirst(sql, ...(args as never[]));
      if (!interrupted && /SELECT dirty, updated_at FROM local_sessions/.test(sql)) {
        interrupted = true;
        // The edit the athlete just made, landing in the gap.
        await realGetFirst(`SELECT 1`);
        await db.runAsync(
          `UPDATE local_sessions SET name = ?, dirty = 1, updated_at = ? WHERE id = 's1'`,
          'MyEdit',
          LATER,
        );
      }
      return out;
    }) as typeof db.getFirstAsync;

    await syncSessions('u1', token);
    db.getFirstAsync = realGetFirst;

    expect(interrupted).toBe(true);
    // Both halves matter: the name is the athlete's, and it is still queued.
    // Keeping the name while clearing `dirty` would be the quieter half of the
    // same bug — right on screen, never sent.
    expect(await row()).toEqual({ name: 'MyEdit', dirty: 1 });
  });
});
