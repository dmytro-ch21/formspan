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
 * carries the same state, and since N565/#1108 `rejectedRows.ts` reads it with
 * this constant rather than its own hand-written copy.
 */
export const REFUSED_ROW = 'last_error IS NOT NULL AND dirty = 0 AND deleted_at IS NULL';

/**
 * REFUSED, on `sequences` — N565/#1108.
 *
 * `REFUSED_ROW` minus the tombstone clause, because `sequences` has no
 * `deleted_at`: it is created and pushed, never tombstoned locally. Before
 * this it was a hand-written copy inside `rejectedRows.ts`; it lives here now
 * so the repair list, the attention count and the stuck-row report read one
 * definition.
 */
export const REFUSED_SEQUENCE_ROW = 'last_error IS NOT NULL AND dirty = 0';

/** The athlete-facing name of each outbox that can hold a stuck row. */
export type StuckDomain = 'session' | 'workout' | 'plan' | 'food_entry' | 'sequence';
/** Blocked is still owed; refused is not. See the two predicates above. */
export type StuckState = 'blocked' | 'refused';
export type StuckTable = 'local_sessions' | 'workout_cache' | 'planned_sessions' | 'food_entries' | 'sequences';

/**
 * Every (domain, state) that feeds `SyncState.needsAttention`, and the
 * predicate that defines it — N565/#1108.
 *
 * ONE list, read by two things that must agree: the stuck-row report
 * (`stuckRows.ts`), and the SQLite triggers in `db.ts` that stamp
 * `stuck_since` when a row enters one of these states. Each entry mirrors the
 * counter that already counts it:
 *
 * - sessions and workouts: `countBlockedRows` (`BLOCKED_ROW` only — neither
 *   table clears `dirty` on a refusal, so neither has a refused state);
 * - plans: `countRefusedPlans` (`BLOCKED_ROW` OR `REFUSED_ROW`);
 * - food entries and sequences: `countRejectedRows` (refused only — both clear
 *   `dirty` on a permanent refusal).
 *
 * `stuckRows.test.ts` pins that the report's totals equal those three counters
 * on the same rows, so an entry added here without a counter, or a counter
 * widened without an entry, fails there.
 */
export const STUCK_ROW_SOURCES: readonly {
  domain: StuckDomain;
  state: StuckState;
  table: StuckTable;
  predicate: string;
}[] = [
  { domain: 'session', state: 'blocked', table: 'local_sessions', predicate: BLOCKED_ROW },
  { domain: 'workout', state: 'blocked', table: 'workout_cache', predicate: BLOCKED_ROW },
  { domain: 'plan', state: 'blocked', table: 'planned_sessions', predicate: BLOCKED_ROW },
  { domain: 'plan', state: 'refused', table: 'planned_sessions', predicate: REFUSED_ROW },
  { domain: 'food_entry', state: 'refused', table: 'food_entries', predicate: REFUSED_ROW },
  { domain: 'sequence', state: 'refused', table: 'sequences', predicate: REFUSED_SEQUENCE_ROW },
];

/** The tables that can hold a stuck row, each once. */
export const STUCK_ROW_TABLES: readonly StuckTable[] = [...new Set(STUCK_ROW_SOURCES.map((s) => s.table))];

/**
 * "Is this row stuck in ANY state" on one table: the OR of its sources.
 *
 * A plan moving from blocked to refused is still stuck, so it must not restart
 * its clock — which is why the trigger reads this union rather than one state.
 */
export function stuckPredicateFor(table: StuckTable): string {
  const parts = STUCK_ROW_SOURCES.filter((s) => s.table === table).map((s) => `(${s.predicate})`);
  if (parts.length === 0) throw new Error(`no stuck-row source for ${table}`);
  return parts.join(' OR ');
}
