/**
 * What "waiting on a person" means for an outbox row — N167/#544, N564/#1106.
 *
 * ONE definition per state, interpolated into every list that shows those rows
 * and every counter that counts them. The sharing is the point: a pending
 * counter and a repair list answer halves of one question — is this row
 * waiting, or waiting on a person — and two hand-written copies of a predicate
 * is how a row ends up in both answers or in neither.
 *
 * ## Why this is one SQL string and not a function of the table
 *
 * The text is identical on every table listed in {@link OUTBOX_PREDICATE_TABLES}
 * because the three columns mean the same thing on each of them: `dirty = 1`
 * is owed to the server, `deleted_at IS NOT NULL` is a tombstone, and
 * `last_error` is written ONLY for a permanent refusal (every `noteRowError`
 * returns early for anything else). A `blockedRow(table)` that returned the
 * same string whatever it was given would look table-aware and be nothing of
 * the sort.
 *
 * The table-awareness lives in the list instead. A table joins it only when
 * its columns carry those meanings, and `outboxPredicates.test.ts` runs both
 * predicates against every listed table on the real migrated schema — so a
 * table that lacks a column, or names it differently, fails there rather than
 * at runtime on a device. What a predicate MEANS on each table is pinned by
 * that table's own partition test, because a clause that parses can still
 * match the wrong rows.
 *
 * ## Interpolation rule
 *
 * The column names are unqualified. Interpolate these only into a query whose
 * FROM names exactly one table — joined to `workout_cache`, for instance,
 * `last_error` becomes ambiguous and SQLite refuses the statement. Wrap them in
 * parentheses when combining (`NOT (${BLOCKED_ROW})`), since each contains
 * `AND`.
 */

/** Tables on which both predicates below are valid, by schema and by meaning. */
export const OUTBOX_PREDICATE_TABLES = ['local_sessions', 'workout_cache', 'planned_sessions'] as const;

/**
 * BLOCKED: refused permanently, still owed, and not a tombstone.
 *
 * Pending is "owed AND NOT blocked", so pending + blocked covers every owed row
 * exactly once. A refused TOMBSTONE stays pending, on every table: it has
 * nothing to open, and it goes out on its own. Per-table consequences are
 * recorded where each table's counters use it (`sessionStore.ts`, `plan.ts`).
 */
export const BLOCKED_ROW = 'last_error IS NOT NULL AND dirty = 1 AND deleted_at IS NULL';

/**
 * REFUSED: refused permanently, NO LONGER owed, and not a tombstone.
 *
 * The outbox has stopped for this row: nothing will send it again, so it is
 * not pending, and without a list reading this it would be shown nowhere.
 * Plans are the table that uses it today: a plan whose delete the server
 * refused is put back (`plan.ts`'s `pushRow`) and lands here. `food_entries`
 * carries the same state with its own hand-written copy in `rejectedRows.ts`,
 * which predates this module and is not listed above.
 */
export const REFUSED_ROW = 'last_error IS NOT NULL AND dirty = 0 AND deleted_at IS NULL';
