/**
 * The shared outbox predicates are valid on every table they are listed for —
 * N564/#1106.
 *
 * `BLOCKED_ROW` and `REFUSED_ROW` are SQL fragments with unqualified column
 * names, interpolated into queries on several tables. If a listed table lacks a
 * column, or names it differently, the interpolated query either fails at
 * runtime on a device or — on a table with a same-named column of another
 * meaning — compiles and matches the wrong rows. This file catches the first
 * against the REAL migrated schema; each table's partition test
 * (`sessionsPendingPartition.test.ts`, `planRefused.test.ts`) pins the second.
 */

import { BLOCKED_ROW, OUTBOX_PREDICATE_TABLES, REFUSED_ROW } from '../outboxPredicates';
import { migratedFixture } from './support/sqlite';

describe.each(OUTBOX_PREDICATE_TABLES)('%s', (table) => {
  it('has the three columns both predicates name, as the types they assume', async () => {
    const db = await migratedFixture();
    const cols = await db.getAllAsync<{ name: string; type: string; notnull: number }>(
      `PRAGMA table_info(${table})`,
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    // `dirty` is compared to 0 and 1, so it must be a non-null integer — a NULL
    // `dirty` would be neither blocked nor refused nor pending.
    expect(byName.get('dirty')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(byName.get('last_error')).toMatchObject({ type: 'TEXT' });
    expect(byName.get('deleted_at')).toMatchObject({ type: 'TEXT' });
  });

  it.each([
    ['BLOCKED_ROW', BLOCKED_ROW],
    ['REFUSED_ROW', REFUSED_ROW],
  ])('%s runs against it', async (_name, predicate) => {
    const db = await migratedFixture();
    await expect(
      db.getFirstAsync(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`),
    ).resolves.toEqual({ n: 0 });
  });
});

it('the two predicates can never both hold for one row', () => {
  // They differ on `dirty` and on nothing else. If that ever stops being true
  // a plan could be listed twice on the repair screen and counted twice in
  // `needsAttention`. A text check is enough here because the property IS the
  // text: same other clauses, opposite `dirty`.
  expect(BLOCKED_ROW.replace('dirty = 1', 'dirty = ?')).toBe(REFUSED_ROW.replace('dirty = 0', 'dirty = ?'));
});
