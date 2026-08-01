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
      if (/SET deleted_at/.test(sql)) {
        const [deletedAt, , id, user] = args as string[];
        const row = rows.find((r) => r.id === id && r.user_id === user);
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

it('hard-deletes a session the server has never seen', async () => {
  // Nothing to tell the server about; a tombstone here would be an outbox
  // entry that can never be satisfied, so `pending` would never reach 0.
  seed({ remote: 0 });
  await deleteLocalSession('u1', 's1');
  expect(rows).toHaveLength(0);
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
