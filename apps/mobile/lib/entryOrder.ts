/**
 * Where a food entry sits inside its meal, and what a drag has to write —
 * N553/#1019.
 *
 * ## The problem this exists to solve, stated once
 *
 * The athlete asked twice for press-and-hold to enter an edit mode with rows
 * that move up and down. N531 shipped the drag but not the destination: a
 * meal was listed by `logged_at, id` and there was nowhere to record "the eggs
 * go above the toast", so a within-meal drag would have snapped back on the
 * next pull. `useEntryDrag`'s own doc comment said so and declined the
 * gesture. This file is the arithmetic of the half that was missing.
 *
 * Pure. No SQLite, no clock, no network — `foodLog.ts` applies what this
 * returns. That is what makes the rules below testable at all, and every one
 * of them is a rule you would otherwise only discover on a device.
 *
 * ## Gapped integers, not a dense rank, and not fractions
 *
 * Neighbours are {@link POSITION_STEP} apart. Dropping a row between two
 * others gives it the MIDPOINT of the two, so **a reorder writes exactly one
 * row** — the one that moved. A dense 0,1,2,… would renumber everything after
 * it: a write per entry per drag, and offline that is worse than slow, it is a
 * sync conflict per entry on rows the athlete never touched.
 *
 * Not fractional (0.5, 0.25, …) either, though it is the classic answer:
 * halving a float runs out of mantissa after about 50 moves at one spot and
 * then two rows compare EQUAL with no warning anywhere, and a float also has
 * to survive JSON, SQLite REAL and Postgres NUMERIC agreeing on the same bits.
 * An integer either has room or does not, and {@link needsRebalance} is how it
 * says which.
 *
 * ## The rebalance, and why it is not a failure
 *
 * 1024 gives ten successive drops at the SAME spot before two neighbours are
 * adjacent and there is no integer between them. At that point the meal is
 * renumbered back onto the grid — {@link rebalanced} — and every row in it is
 * written. That is the ONLY operation in this scheme that touches more than
 * one row, it is bounded by a single meal on a single day (four or five rows
 * in practice), and it is correct rather than merely rare.
 *
 * ## What two offline devices converge to, and why it is defined
 *
 * `position` is a per-entry scalar, exactly like `meal` or `kcal`. It is
 * pushed with that entry's own row through the existing outbox, so it inherits
 * the conflict rule this app already has and does not invent a new one:
 *
 * - **Two devices move DIFFERENT rows in one meal**: both moves survive. Each
 *   wrote one row; neither row is the other's.
 * - **Two devices move the SAME row**: the later push wins, whole. Not a
 *   merge, not an average — the same last-writer-wins every other field on
 *   this row already has.
 * - **Two devices happen to compute the SAME number for two different rows**:
 *   {@link compareEntries} breaks the tie by `id`, which is a client-generated
 *   UUID. Every device, and the server's own `ORDER BY`, break it the same
 *   way, so there is no state in which two synced devices show a different
 *   order. This is the part that makes "converges somewhere DEFINED" a
 *   property rather than a hope: the sort key `(position, id)` is a total
 *   order on every device regardless of what the positions are.
 *
 * What is deliberately NOT promised: that a move made offline on device A and
 * a move made offline on device B combine into the arrangement either athlete
 * pictured. Nothing can promise that without a CRDT, and a list CRDT to let
 * one person reorder their own breakfast on two phones is not a trade this
 * project makes. Both devices agree; the later drag wins the row it dragged.
 */

/**
 * The gap left between neighbouring entries.
 *
 * Must equal `PositionStep` in `backend/internal/modules/nutrition/nutrition.go`
 * and the `1024` in `backend/migrations/20260909220933_nutrition_entry_position.up.sql`.
 * The server and the phone each backfill their own copy of this column
 * independently — neither reads the other's answer — so the two backfills only
 * agree if the step does.
 */
export const POSITION_STEP = 1024;

/**
 * The furthest from zero a position may go, matching the server's
 * `PositionBound`. 2^40, far inside 2^53 where a JavaScript number stops being
 * an exact integer and two positions one apart would compare equal.
 */
export const POSITION_BOUND = 2 ** 40;

/** The least a row needs for this file to order it. */
export type Positioned = { id: string; position: number };

/**
 * The sort key, and the whole of the convergence guarantee.
 *
 * `position` first, `id` second. The id tiebreak is not defensive tidiness: it
 * is what makes the order a TOTAL order rather than a partial one, so two
 * devices that independently landed two different rows on the same number
 * still render them in the same sequence. The server's `ORDER BY eaten_on
 * DESC, position, created_at, id` ends the same way for the same reason.
 */
export function compareEntries(a: Positioned, b: Positioned): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A meal's rows, in the order they should be shown. */
export function ordered<T extends Positioned>(rows: readonly T[]): T[] {
  return [...rows].sort(compareEntries);
}

/**
 * The position a brand-new entry gets: one step past whatever is last.
 *
 * `siblings` is the rest of that meal on that day — in any order, since only
 * the maximum matters. An empty meal starts at one step rather than at 0,
 * matching the server's `endOfMeal` and both backfills.
 *
 * 0 is nonetheless an ORDINARY position, never a sentinel: drag the second row
 * of a meal above the first and {@link between}(null, 1024) is exactly 0.
 * Nothing anywhere may read 0 as "unset".
 */
export function appendPosition(siblings: readonly Positioned[]): number {
  if (siblings.length === 0) return POSITION_STEP;
  let max = siblings[0].position;
  for (const s of siblings) if (s.position > max) max = s.position;
  return max + POSITION_STEP;
}

/**
 * One row's new position, computed from the two rows it landed between.
 *
 * `before`/`after` are the neighbours at the destination — null at the top or
 * the bottom of the meal. Returns null when there is no integer strictly
 * between them, which is the rebalance signal; {@link plan} is what acts on
 * it, and no caller should be doing this arithmetic itself.
 *
 * Dropping at the TOP is `first - step`, which is why positions may go
 * negative. That is deliberate: the alternative — renumbering so that "first"
 * can be a positive number — makes the single most common reorder an
 * every-row write, which is the thing this scheme exists to avoid.
 */
export function between(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return (after as number) - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  // Math.floor, not a round: with before=1 and after=2 this gives 1, which is
  // NOT strictly between, and the guard below is what catches that rather
  // than a rounding rule that silently ties.
  const mid = Math.floor((before + after) / 2);
  if (mid <= before || mid >= after) return null;
  return mid;
}

/** Whether a computed position has run out of room, or out of range. */
export function needsRebalance(p: number | null): boolean {
  return p === null || p <= -POSITION_BOUND || p >= POSITION_BOUND;
}

/**
 * A whole meal renumbered back onto the grid: 1024, 2048, 3072, …
 *
 * Takes the rows in the order they should END UP in, and returns one write per
 * row — including rows whose number happens to be unchanged, because a partial
 * renumber is how a gap gets left in the middle of a rebalance and the next
 * move fails again in the same place.
 */
export function rebalanced<T extends Positioned>(inOrder: readonly T[]): { id: string; position: number }[] {
  return inOrder.map((r, i) => ({ id: r.id, position: (i + 1) * POSITION_STEP }));
}

/** What a drag decided: which rows have to be written, and where each goes. */
export type OrderPlan = {
  /** The rows to write. ONE entry for an ordinary move. */
  writes: { id: string; position: number }[];
  /**
   * True when the gap ran out and the whole meal was renumbered. Not an error
   * — the caller writes the list either way; this is here so a test can assert
   * that the ordinary case is one write, and so `foodLog` can say which
   * happened in a log line.
   */
  rebalanced: boolean;
};

/**
 * Put `id` at index `at` among `others`, and say what to write.
 *
 * `others` is the destination meal in display order, WITHOUT the row being
 * moved — which is what an index into a reordered list means, and what the
 * caller's own animation is already showing. The moved row always gets a
 * write; nothing else does unless the gap ran out.
 *
 * The single primitive under both {@link plan} (a move inside one meal) and
 * {@link planInto} (a move onto another one). One function because the two
 * are the same question — "what number goes between these two rows" — and
 * writing it twice is how a rebalance ends up implemented in one of them.
 */
export function insertAt<T extends Positioned>(
  others: readonly T[],
  id: string,
  at: number,
): OrderPlan {
  const i = Math.max(0, Math.min(at, others.length));
  const before = i > 0 ? others[i - 1].position : null;
  const after = i < others.length ? others[i].position : null;
  const p = between(before, after);
  if (!needsRebalance(p)) return { writes: [{ id, position: p as number }], rebalanced: false };

  // No room between the neighbours. Renumber the meal AS IT WILL LOOK, so the
  // moved row lands where the athlete put it and every other row keeps its
  // relative place. The moved row is a bare id here — its own fields do not
  // matter, only where it sits.
  const settled: Positioned[] = [...others];
  settled.splice(i, 0, { id, position: 0 });
  return { writes: rebalanced(settled), rebalanced: true };
}

/**
 * Move `id` to index `to` within `rows` — one meal reordering itself.
 *
 * `rows` is that meal in the order currently shown; `to` is the index the row
 * should occupy afterwards, in the list with the row removed.
 *
 * Returns an empty plan for a move that changes nothing. That is a guard, not
 * an optimisation: a write marks the row `dirty`, and a dirty row is one
 * `entrySyncState` reports as `owed`, which disables sharing with "Save your
 * changes first". A finger that lifted where it started must not cost the
 * athlete a share for nothing — the same reasoning `moveEntry`'s same-meal
 * no-op already carries.
 */
export function plan<T extends Positioned>(rows: readonly T[], id: string, to: number): OrderPlan {
  const current = rows.findIndex((r) => r.id === id);
  if (current === -1) return { writes: [], rebalanced: false };
  const others = rows.filter((r) => r.id !== id);
  const at = Math.max(0, Math.min(to, others.length));
  if (at === current) return { writes: [], rebalanced: false };
  return insertAt(others, id, at);
}

/**
 * Where a row dropped onto ANOTHER meal should land in it.
 *
 * The cross-meal drag N531 shipped is now a case of the same gesture rather
 * than a rival to it (see the history entry), so it goes through the same
 * arithmetic: `target` is the destination meal in display order — the moved
 * row is not in it, by definition — and `to` is the slot the finger was over.
 *
 * `to` of `target.length` is the append case, which is what a finger that
 * landed on a card's header or its "Add Food" row resolves to. Appending is
 * the honest answer there: the athlete said which meal, not where in it.
 */
export function planInto<T extends Positioned>(
  target: readonly T[],
  id: string,
  to: number,
): OrderPlan {
  return insertAt(target, id, to);
}
