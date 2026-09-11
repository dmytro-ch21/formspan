import { getDb } from './db';

/**
 * Rows the server REFUSED and this phone has stopped sending — N167/#544.
 *
 * ## The state this names, and why it is not `blockedRows`
 *
 * `lib/sessionStore.ts`'s `blockedRows` and this are deliberately different
 * states, and conflating them is the defect this ticket exists to fix:
 *
 * - **blocked** (`dirty = 1 AND last_error IS NOT NULL`, on sessions and
 *   workouts) — refused permanently, but still owed, because those two tables
 *   never clear `dirty` on a refusal. As of N167's second slice it does NOT
 *   count as pending (it used to, forever) and is counted as
 *   `SyncState.needsAttention` instead — see `BLOCKED_ROW` in
 *   `sessionStore.ts`. It is re-sent only when a sync runs for some other
 *   reason, or when an edit clears the refusal.
 *
 *   **Corrected, not silently rewritten.** Slice 1 described this state as "a
 *   transient failure wearing an error" that "SHOULD count as pending, because
 *   it is". Both halves were wrong by the time slice 2 landed: `noteRowError`
 *   only ever records a PERMANENT refusal, and slice 2 stopped counting it.
 *   Found by `frontend-reviewer` — a comment this change falsified in a file it
 *   did not otherwise touch.
 * - **rejected** (`dirty = 0 AND last_error IS NOT NULL`) — the outbox has
 *   stopped. A 4xx will not become a 2xx, so the row is no longer owed. It
 *   must NOT count as pending, because nothing is going to happen to it.
 *
 * Both are "something is wrong with this row", and neither counts as waiting.
 * The difference is whether the phone still owes the row to the server.
 *
 * ## The gap this closes: the reason was kept and nothing read it
 *
 * Both writing domains already record the reason correctly, and both say in
 * their own comments that somebody shows it. Neither sentence was true:
 *
 * - `foodLog.ts`'s permanent branch: *"keep the row and the reason so the
 *   sync screen can explain it."* `app/sync.tsx` imports nothing from
 *   `foodLog`.
 * - `sequences.ts`'s: *"the row stays on the device for the athlete to see."*
 *   Nothing rendered it, anywhere, ever.
 *
 * So a refused food entry or sequence left the pending count (correct), kept
 * its reason (correct), and appeared on no screen in the app (the defect). The
 * athlete's record silently disagreed with the server's, with a local row
 * that looked ordinary.
 *
 * `foods` already had its reader — `foodSyncProblems`, N533/#964 — which is
 * the shape this generalises rather than a fourth invention.
 *
 * ## Why the recovery is DISCARD and not retry
 *
 * Retry is the recovery for a blocked row, and it is meaningless here: the
 * server has already answered, and it will answer the same way forever. The
 * only actions that change anything are editing the row into something the
 * server accepts, or discarding it. Discard is the one that always works and
 * is the one offered here; editing is per-domain and stays where the row is
 * edited today.
 */
export type RejectedRow = {
  kind: 'food-entry' | 'sequence';
  id: string;
  /** What the athlete called it, so the list names a thing they recognise. */
  name: string;
  /** The server's own words. Never paraphrased — see `sync.tsx`. */
  reason: string;
  /** Context that makes the row findable: the day for an entry, null else. */
  on: string | null;
};

/**
 * Every refused row on this device, newest context first.
 *
 * Tombstones are excluded for food entries, matching every other read of that
 * table. A refused DELETE is a real case and an honest gap: the row is
 * invisible to every read that filters `deleted_at IS NULL`, so it cannot be
 * listed here either without showing the athlete a thing they already deleted.
 * `foodLog.ts`'s own comment already records this exception; it is restated
 * rather than quietly inherited.
 */
export async function rejectedRows(userId: string): Promise<RejectedRow[]> {
  const db = await getDb();

  const entries = await db.getAllAsync<{ id: string; name: string; last_error: string; eaten_on: string }>(
    `SELECT id, name, last_error, eaten_on FROM food_entries
      WHERE user_id = ? AND deleted_at IS NULL
        AND dirty = 0 AND last_error IS NOT NULL
      ORDER BY eaten_on DESC, logged_at DESC`,
    userId,
  );

  // `sequences` has no user-scoped soft delete and no `deleted_at` — the table
  // is created and pushed, never tombstoned locally. Scoped by user_id alone,
  // which is what every other read of it does.
  const seqs = await db.getAllAsync<{ id: string; name: string; last_error: string }>(
    `SELECT id, name, last_error FROM sequences
      WHERE user_id = ? AND dirty = 0 AND last_error IS NOT NULL
      ORDER BY created_at DESC`,
    userId,
  );

  return [
    ...entries.map((r) => ({
      kind: 'food-entry' as const,
      id: r.id,
      name: r.name,
      reason: r.last_error,
      on: r.eaten_on,
    })),
    ...seqs.map((r) => ({
      kind: 'sequence' as const,
      id: r.id,
      name: r.name,
      reason: r.last_error,
      on: null,
    })),
  ];
}

/** How many rows are refused — for a badge that must not be confused with
 *  the pending count. Separate function rather than `rejectedRows().length`
 *  so a caller that only needs the number does not read every reason. */
export async function countRejectedRows(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM food_entries
         WHERE user_id = ? AND deleted_at IS NULL AND dirty = 0 AND last_error IS NOT NULL)
     + (SELECT COUNT(*) FROM sequences
         WHERE user_id = ? AND dirty = 0 AND last_error IS NOT NULL) AS n`,
    userId, userId,
  );
  return row?.n ?? 0;
}

/**
 * Throw the local ghost away.
 *
 * A HARD delete, not a tombstone, and the distinction matters: a tombstone is
 * an instruction to the server to remove something, and the server never
 * accepted this row in the first place. Tombstoning it would queue a delete
 * for an id the server has never heard of — turning one refused write into a
 * second one.
 *
 * Scoped by `user_id` as well as `id` so a stale row belonging to a previously
 * signed-in account cannot be removed by whoever is signed in now.
 */
export async function discardRejectedRow(userId: string, row: RejectedRow): Promise<void> {
  const db = await getDb();
  const table = row.kind === 'food-entry' ? 'food_entries' : 'sequences';
  // The `dirty = 0 AND last_error IS NOT NULL` predicate is carried into the
  // DELETE deliberately. Between the list being read and the button being
  // pressed, a sync pass may have made this row owed again (an edit re-dirties
  // it) — and discarding a row the phone has started sending again would throw
  // away work that was about to succeed. The same compare-and-swap discipline
  // `foodLog.ts`'s push paths already use, for the same reason.
  await db.runAsync(
    `DELETE FROM ${table}
      WHERE id = ? AND user_id = ? AND dirty = 0 AND last_error IS NOT NULL`,
    row.id, userId,
  );
}
