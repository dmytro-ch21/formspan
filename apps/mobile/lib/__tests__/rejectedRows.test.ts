/**
 * N167/#544 — rows the server refused, and the fact that nothing showed them.
 *
 * Runs against a REAL SQLite database through `migratedFixture()`, like every
 * other outbox test here, so what is asserted is what the shipped schema and
 * queries do rather than what a regex over a query string would suggest.
 *
 * ## The distinction under test
 *
 * `dirty = 1 AND last_error` is BLOCKED — still owed, still retrying, and it
 * should count as pending because it is. `dirty = 0 AND last_error` is
 * REFUSED — the outbox has stopped and nothing further will happen. Both are
 * "something is wrong"; only one is waiting, and the ticket's central defect
 * was that the second silently appeared nowhere at all.
 *
 * Every case below is written so that a query which forgot one half of the
 * predicate — the `dirty = 0`, or the `last_error IS NOT NULL` — produces a
 * visibly wrong answer rather than an accidentally-right one.
 */

import { discardRejectedRow, countRejectedRows, rejectedRows } from '../rejectedRows';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

let db: FixtureDb;
const USER = 'user_me';
const OTHER = 'user_someone_else';

async function entry(
  id: string,
  over: Partial<{ user: string; name: string; dirty: number; error: string | null; deleted: string | null; on: string }> = {},
) {
  const o = { user: USER, name: `Entry ${id}`, dirty: 0, error: 'refused', deleted: null, on: '2026-09-10', ...over };
  await db.runAsync(
    `INSERT INTO food_entries
       (id, user_id, eaten_on, meal, name, servings, serving_label, kcal,
        notes, position, logged_at, updated_at, dirty, remote, deleted_at, last_error)
     VALUES (?, ?, ?, 'lunch', ?, 1, 'serving', 100, '', 0, ?, ?, ?, 0, ?, ?)`,
    id, o.user, o.on, o.name, '2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z', o.dirty, o.deleted, o.error,
  );
}

async function sequence(
  id: string,
  over: Partial<{ user: string; name: string; dirty: number; error: string | null }> = {},
) {
  const o = { user: USER, name: `Seq ${id}`, dirty: 0, error: 'corrupt local copy — could not be sent', ...over };
  await db.runAsync(
    `INSERT INTO sequences (id, user_id, name, description, steps_json, created_at, dirty, remote, last_error)
     VALUES (?, ?, ?, '', '[]', ?, ?, 0, ?)`,
    id, o.user, o.name, '2026-09-10T12:00:00Z', o.dirty, o.error,
  );
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('what counts as refused', () => {
  it('lists a food entry and a sequence the server refused, with the server’s own words', async () => {
    await entry('e1', { name: 'Porridge', error: 'source_food_id does not name a saved food' });
    await sequence('s1', { name: 'Guard passes' });

    const rows = await rejectedRows(USER);
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'food-entry', id: 'e1', name: 'Porridge', reason: 'source_food_id does not name a saved food', on: '2026-09-10' },
        { kind: 'sequence', id: 's1', name: 'Guard passes', reason: 'corrupt local copy — could not be sent', on: null },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('a BLOCKED row is not refused — it is still owed and still being retried', async () => {
    // dirty = 1 with an error. `blockedRows` in sessionStore owns this state;
    // listing it here would double-report it AND tell the athlete something
    // being retried had been refused.
    await entry('e-blocked', { dirty: 1, error: 'timed out' });
    await sequence('s-blocked', { dirty: 1, error: 'timed out' });
    expect(await rejectedRows(USER)).toEqual([]);
    expect(await countRejectedRows(USER)).toBe(0);
  });

  it('a clean synced row is not refused', async () => {
    await entry('e-ok', { dirty: 0, error: null });
    await sequence('s-ok', { dirty: 0, error: null });
    expect(await rejectedRows(USER)).toEqual([]);
  });

  it('a row still queued and never attempted is not refused', async () => {
    await entry('e-queued', { dirty: 1, error: null });
    expect(await rejectedRows(USER)).toEqual([]);
  });

  it('never shows another account’s refused rows', async () => {
    await entry('e-mine', { name: 'Mine' });
    await entry('e-theirs', { user: OTHER, name: 'Theirs' });
    await sequence('s-theirs', { user: OTHER });
    const rows = await rejectedRows(USER);
    expect(rows.map((r) => r.id)).toEqual(['e-mine']);
    expect(await countRejectedRows(USER)).toBe(1);
  });

  it('excludes a refused tombstone, matching every other read of that table', async () => {
    // The honest exception `foodLog.ts` already records: a refused DELETE
    // keeps both flags and is invisible to every read filtering deleted_at.
    // Listing it would offer the athlete a row they already deleted.
    await entry('e-tomb', { deleted: '2026-09-10T13:00:00Z' });
    expect(await rejectedRows(USER)).toEqual([]);
  });
});

describe('the count is not the pending count', () => {
  it('counts both domains together', async () => {
    await entry('e1');
    await entry('e2');
    await sequence('s1');
    expect(await countRejectedRows(USER)).toBe(3);
  });

  it('agrees with the list it summarises', async () => {
    // Two queries answering one question is how they drift. Asserted rather
    // than assumed, because `countRejectedRows` deliberately does not call
    // `rejectedRows`.
    await entry('e1');
    await entry('e-blocked', { dirty: 1, error: 'timed out' });
    await entry('e-tomb', { deleted: '2026-09-10T13:00:00Z' });
    await sequence('s1');
    await sequence('s-ok', { error: null });
    expect(await countRejectedRows(USER)).toBe((await rejectedRows(USER)).length);
  });

  it('is zero on a device with nothing wrong', async () => {
    await entry('e-ok', { dirty: 0, error: null });
    expect(await countRejectedRows(USER)).toBe(0);
  });
});

describe('discarding the local ghost', () => {
  it('removes the row outright rather than tombstoning it', async () => {
    // A tombstone queues a DELETE for an id the server never accepted, turning
    // one refused write into a second one.
    await entry('e1');
    const [row] = await rejectedRows(USER);
    await discardRejectedRow(USER, row);
    const left = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM food_entries WHERE id = 'e1'`,
    );
    expect(left?.n).toBe(0);
    expect(await rejectedRows(USER)).toEqual([]);
  });

  it('discards a sequence the same way', async () => {
    await sequence('s1');
    const [row] = await rejectedRows(USER);
    await discardRejectedRow(USER, row);
    expect(await rejectedRows(USER)).toEqual([]);
  });

  it('will not discard a row that has become owed again since the list was read', async () => {
    // Between the list being read and the button pressed, an edit can
    // re-dirty the row — and discarding it would throw away work that was
    // about to succeed.
    await entry('e1');
    const [row] = await rejectedRows(USER);
    await db.runAsync(`UPDATE food_entries SET dirty = 1 WHERE id = 'e1'`);
    await discardRejectedRow(USER, row);
    const still = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM food_entries WHERE id = 'e1'`,
    );
    expect(still?.n).toBe(1);
  });

  it('cannot discard another account’s row', async () => {
    await entry('e-theirs', { user: OTHER });
    await discardRejectedRow(USER, { kind: 'food-entry', id: 'e-theirs', name: 'Theirs', reason: 'x', on: null });
    const still = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM food_entries WHERE id = 'e-theirs'`,
    );
    expect(still?.n).toBe(1);
  });
});
