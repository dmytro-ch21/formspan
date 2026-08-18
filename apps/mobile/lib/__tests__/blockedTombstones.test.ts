import {
  blockedRows,
  deleteLocalSession,
  deleteLocalWorkout,
} from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * What the repair screen is allowed to show — F5.
 *
 * `blockedRows` was the one read in `sessionStore` without `deleted_at IS NULL`,
 * and the cost was worse than "a deleted row lingers for a cycle". The screen's
 * primary action is "Open the session", `readLocalSession` filters tombstones,
 * so a deleted row on this list offered a button that navigated to a screen
 * showing nothing — a row you are told to go and fix, that cannot be opened,
 * about a session you already deleted.
 *
 * The second half is the stale `last_error`: it described the operation that
 * was failing BEFORE the delete, which is not what the row is trying to do any
 * more.
 *
 * Both halves are pinned separately below, because either one alone still hides
 * the row from the screen and would make the other's test pass vacuously —
 * the mistake caught in #271, where a tombstone case was declined by the wrong
 * clause entirely.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const AT = '2026-08-01T10:00:00.000Z';

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

async function blockedSession(id: string) {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json,
        last_error)
     VALUES (?, 'u1', NULL, 'strength', 'Bench', ?, ?, '', '[]', 1, 1, NULL, ?,
             0, NULL, 'the server said no')`,
    id, AT, AT, AT,
  );
}

async function blockedWorkout(id: string) {
  await db.runAsync(
    `INSERT INTO workout_cache
       (id, user_id, sport, name, items_json, dirty, deleted_at, updated_at,
        name_dirty, last_error, cached_at)
     VALUES (?, 'u1', 'strength', 'Push day', '[]', 1, NULL, ?, 0,
             'the server said no', ?)`,
    id, AT, AT,
  );
}

const ids = async () => (await blockedRows('u1')).map((r) => r.id);

describe('the repair screen', () => {
  it('does not list a plan with nothing wrong', async () => {
    // Pins the workouts query's `last_error IS NOT NULL`. Review found it
    // survived the entire repo suite: the only error-free dirty workout in any
    // other test is asserted with `.find`, which does not fail on extra rows.
    await db.runAsync(
      `INSERT INTO workout_cache
         (id, user_id, sport, name, items_json, dirty, deleted_at, updated_at,
          name_dirty, last_error, cached_at)
       VALUES ('w-ok', 'u1', 'strength', 'Fine', '[]', 1, NULL, ?, 0, NULL, ?)`,
      AT, AT,
    );
    expect(await ids()).toEqual([]);
  });

  it('does not list a settled plan that once failed', async () => {
    // Pins the workouts query's `dirty = 1`. Also survived the whole suite —
    // every workout fixture anywhere is dirty, so the clause was free to go.
    await blockedWorkout('w1');
    await db.runAsync(`UPDATE workout_cache SET dirty = 0 WHERE id = 'w1'`);
    expect(await ids()).toEqual([]);
  });

  it('shows a blocked session that is still there', async () => {
    // The control. Without it, every assertion below passes on an empty list
    // whatever the query says.
    await blockedSession('s1');
    expect(await ids()).toEqual(['s1']);
  });

  it('shows a blocked plan that is still there', async () => {
    await blockedWorkout('w1');
    expect(await ids()).toEqual(['w1']);
  });

  it('DROPS a session that was deleted while blocked', async () => {
    // Deleted via the real path, so the test covers what the app does rather
    // than a hand-written tombstone.
    await blockedSession('s1');
    await deleteLocalSession('u1', 's1');
    expect(await ids()).toEqual([]);
  });

  it('DROPS a plan that was deleted while blocked', async () => {
    await blockedWorkout('w1');
    await deleteLocalWorkout('u1', 'w1');
    expect(await ids()).toEqual([]);
  });

  it('drops the tombstone even when the error survives it', async () => {
    // Pins the QUERY clause on its own. `deleteLocalSession` also clears
    // `last_error`, which would hide the row by itself — so this writes the
    // tombstone directly and puts the error back, leaving the filter as the
    // only thing that can drop it. Without that, the next test's fix would
    // make this one pass for the wrong reason.
    await blockedSession('s1');
    await db.runAsync(
      `UPDATE local_sessions SET deleted_at = ?, last_error = 'still failing'
       WHERE id = 's1'`,
      AT,
    );
    expect(await ids()).toEqual([]);
  });

  it('drops a deleted PLAN even when the error survives it', async () => {
    // The workouts half of the isolation above, and it was missing: with only
    // the session version, dropping `deleted_at IS NULL` from the workouts
    // query left all seven tests green, because `deleteLocalWorkout` clears
    // `last_error` and the row falls out of `last_error IS NOT NULL` instead.
    // Two queries, two clauses, two tests. Found by the mutation run.
    await blockedWorkout('w1');
    await db.runAsync(
      `UPDATE workout_cache SET deleted_at = ?, last_error = 'still failing'
       WHERE id = 'w1'`,
      AT,
    );
    expect(await ids()).toEqual([]);
  });

  it('clears the stale error the delete made irrelevant', async () => {
    // Pins the DELETE's own change, independent of the filter above: the error
    // described the push that was failing before, and that is not what this
    // row is trying to do any more.
    await blockedSession('s1');
    await deleteLocalSession('u1', 's1');
    const row = await db.getFirstAsync<{ last_error: string | null; dirty: number }>(
      `SELECT last_error, dirty FROM local_sessions WHERE id = 's1'`,
    );
    expect(row?.last_error).toBeNull();
    // Still queued: clearing the complaint must not clear the work.
    expect(row?.dirty).toBe(1);
  });

  it('clears it on a plan too', async () => {
    await blockedWorkout('w1');
    await deleteLocalWorkout('u1', 'w1');
    const row = await db.getFirstAsync<{ last_error: string | null; dirty: number }>(
      `SELECT last_error, dirty FROM workout_cache WHERE id = 'w1'`,
    );
    expect(row?.last_error).toBeNull();
    expect(row?.dirty).toBe(1);
  });
});
