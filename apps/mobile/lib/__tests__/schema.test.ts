import { migratedFixture } from './support/sqlite';

/**
 * The migrations, run for real.
 *
 * `db.ts` carries a hard-won comment: the fresh-install path runs **every**
 * branch from v0, which is why each `ADD COLUMN` is guarded — a v5-shaped
 * assumption once produced an ALTER that failed on a fresh install. Nothing
 * exercised that until this fixture existed.
 */

it('a fresh install ends up at the current schema version', async () => {
  const db = await migratedFixture();
  const row = db.raw.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(row.user_version).toBe(7);
});

it('local_sessions has the tombstone column', async () => {
  const db = await migratedFixture();
  const cols = (db.raw.prepare('PRAGMA table_info(local_sessions)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toEqual(expect.arrayContaining(['deleted_at', 'dirty', 'remote', 'updated_at']));
});

it('running every branch twice is idempotent', async () => {
  // A crash between an ALTER and the version stamp re-runs the branches; they
  // must not throw the second time.
  const db = await migratedFixture();
  await expect(migratedFixture()).resolves.toBeDefined();
  expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
});
