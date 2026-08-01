import { readFileSync } from 'fs';
import { join } from 'path';

import { deleteLocalSession, hydrateSession, tombstonedIDs } from '../sessionStore';

/**
 * Deleting a session offline must not undo itself.
 *
 * The bug: `deleteLocalSession` hard-deleted the row. The server still held
 * the session, so the next pull fetched it straight back — and with the row
 * gone there was nothing left carrying "this needs deleting", so the intent
 * was lost the moment the fire-and-forget DELETE failed. Offline, it always
 * failed.
 *
 * These tests run against an in-memory stand-in for the rows table rather than
 * real SQLite. That is a deliberate limit and it is worth naming: it exercises
 * the *decisions* (tombstone vs hard delete, what reads and pulls skip) and
 * not the SQL. A schema or query mistake would slip through — the migration
 * itself is covered by the app booting, and the query shapes by the reviewer.
 */

type Row = { id: string; user_id: string; remote: number; dirty: number; deleted_at: string | null };
const rows: Row[] = [];

jest.mock('../db', () => ({
  getDb: async () => ({
    getFirstAsync: async (sql: string, ...args: unknown[]) => {
      if (/SELECT remote FROM/.test(sql)) {
        const [id, user] = args as string[];
        return rows.find((r) => r.id === id && r.user_id === user) ?? null;
      }
      if (/deleted_at IS NOT NULL/.test(sql)) {
        const [id, user] = args as string[];
        const hit = rows.find((r) => r.id === id && r.user_id === user && r.deleted_at !== null);
        return hit ? { id: hit.id } : null;
      }
      return null;
    },
    getAllAsync: async (sql: string, ...args: unknown[]) => {
      if (/deleted_at IS NOT NULL/.test(sql)) {
        const [user] = args as string[];
        return rows.filter((r) => r.user_id === user && r.deleted_at !== null).map((r) => ({ id: r.id }));
      }
      return [];
    },
    runAsync: async (sql: string, ...args: unknown[]) => {
      if (/^\s*DELETE FROM local_sessions/.test(sql)) {
        const [id, user] = args as string[];
        const i = rows.findIndex((r) => r.id === id && r.user_id === user);
        if (i >= 0) rows.splice(i, 1);
        return;
      }
      if (/SET deleted_at = \?/.test(sql)) {
        const [deletedAt, , id, user] = args as string[];
        // Mirrors the query's own `AND deleted_at IS NULL`.
        const row = rows.find((r) => r.id === id && r.user_id === user && r.deleted_at === null);
        if (row) {
          row.deleted_at = deletedAt;
          row.dirty = 1;
        }
      }
    },
  }),
}));

const seed = (over: Partial<Row> = {}) => {
  rows.length = 0;
  rows.push({ id: 's1', user_id: 'u1', remote: 1, dirty: 0, deleted_at: null, ...over });
};

it('marks a synced session rather than removing it', async () => {
  seed({ remote: 1 });
  await deleteLocalSession('u1', 's1');

  // The row must survive — it is the only thing carrying the intent to delete.
  expect(rows).toHaveLength(1);
  expect(rows[0].deleted_at).toEqual(expect.any(String));
});

it('marks the tombstone dirty so the ordinary push path carries it out', async () => {
  seed({ remote: 1, dirty: 0 });
  await deleteLocalSession('u1', 's1');
  expect(rows[0].dirty).toBe(1);
});

it('tombstones a never-pushed session too, rather than deciding here', async () => {
  // It used to hard-delete when `remote === 0`. That read is racy: a first
  // push sets remote = 1 partway through, so deleting in that window
  // hard-deletes locally while the push it raced CREATES the session on the
  // server — and the next pull brings it straight back. The decision belongs
  // in the push, which runs inside the serialised sync.
  seed({ remote: 0 });
  await deleteLocalSession('u1', 's1');
  expect(rows).toHaveLength(1);
  expect(rows[0].deleted_at).toEqual(expect.any(String));
});

it('does not re-stamp a session already tombstoned', async () => {
  // Deleting twice must not move updated_at, which would defeat the CAS a
  // push in flight relies on.
  seed({ remote: 1 });
  await deleteLocalSession('u1', 's1');
  const first = rows[0].deleted_at;
  await deleteLocalSession('u1', 's1');
  expect(rows[0].deleted_at).toBe(first);
});

it('reports the tombstone so the pull can skip it', async () => {
  // Without this the pull writes the server's copy straight back — the
  // resurrection the whole feature exists to stop.
  seed({ remote: 1 });
  await deleteLocalSession('u1', 's1');
  expect(await tombstonedIDs('u1')).toEqual(new Set(['s1']));
});

it('does not report another athlete tombstones as this one’s', async () => {
  seed({ remote: 1 });
  rows.push({ id: 's2', user_id: 'u2', remote: 1, dirty: 0, deleted_at: 'x' });
  await deleteLocalSession('u1', 's1');
  expect(await tombstonedIDs('u1')).toEqual(new Set(['s1']));
});

it('is a no-op for a session this device does not have', async () => {
  seed();
  await deleteLocalSession('u1', 'missing');
  expect(rows).toHaveLength(1);
  expect(rows[0].deleted_at).toBeNull();
});

it('refuses to hydrate a session this device deleted', async () => {
  // Reads filter tombstones, so a screen opened on a deleted id finds nothing
  // locally and falls through to hydrate. Without this guard it would fetch
  // the server's copy and upsert it with dirty = 0 — leaving the row hidden
  // but the tombstone unpushable, so the delete silently never happens.
  seed({ remote: 1 });
  await deleteLocalSession('u1', 's1');

  const pull = jest.fn();
  expect(await hydrateSession('u1', 's1', pull as never)).toBeNull();
  // The point is that it never even asks the server.
  expect(pull).not.toHaveBeenCalled();
});

it('the upsert SQL refuses to write over a tombstone', async () => {
  // Asserted on the query text rather than behaviour, because this mock does
  // not execute SQL — a real SQLite fixture is what would test the effect.
  // Still worth pinning: the SET list clobbers `dirty`, so without this
  // clause any upsert onto a deleted row leaves the tombstone in place but
  // marks it clean, and the delete silently never happens. Two callers
  // currently guard against reaching it; this makes the row immune regardless.
  const src = readFileSync(join(__dirname, '..', 'sessionStore.ts'), 'utf8');
  const upsertSql = src.slice(src.indexOf('INSERT INTO local_sessions'));
  expect(upsertSql.slice(0, upsertSql.indexOf('`'))).toMatch(
    /WHERE local_sessions\.deleted_at IS NULL/,
  );
});
