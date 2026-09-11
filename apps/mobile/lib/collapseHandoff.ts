import { rekeyCollapsedAcross, type GroupKey } from './sessionCollapse';
import type { LoggedSet } from './sessions';

/**
 * The correspondence an OFF-screen set writer hands the strength session
 * screen, so its fold state survives the write (F35/#999).
 *
 * ## Why this exists
 *
 * The session screen's per-exercise **Done** folds are keyed by occurrence —
 * `squat#0`, `bench#0`, `squat#1` — and a set has no id, so any change to how
 * many blocks of an exercise precede a block RENAMES its key (see `groupKeys`).
 * N543 made every on-screen mutator rebuild the fold state across that rename
 * with the correspondence it knows.
 *
 * Two writers are not on that screen. The exercise picker
 * (`app/session/[id]/add.tsx`) and photo identify (`app/session/[id]/identify.tsx`)
 * both swap or append an exercise and write the result **straight to SQLite**,
 * then navigate back. The screen's `load` re-reads the sets on focus, but hydrates
 * the fold state only once per session, so the old keys were left describing
 * rows that had been relabelled: a folded block re-opened, a swapped block could
 * be folded shut by a neighbour's fold, and a set appended into a folded block
 * rendered hidden.
 *
 * The writer knows the correspondence exactly — identity for a swap, the old
 * prefix for an append — so it records it here, and the screen applies it.
 *
 * ## Why a handoff, and not the three obvious alternatives
 *
 * - **Diff the old and new sets in `load`.** N543 declined exactly this: with no
 *   set ids, a same-length list could be a swap or a sync-pulled reorder, and
 *   those need different answers. A guessed correspondence is the silent rename
 *   this whole mechanism exists to prevent.
 * - **Have the picker return the swap for the screen to apply through `commit`.**
 *   That moves the write off SQLite, so an app killed between the picker and
 *   the screen would lose the swap ITSELF — trading a durability guarantee for a
 *   one-tap view-state bug.
 * - **Have the picker write `collapsed_json` too.** That breaks N543's "exactly
 *   one writer", and would not even work: the screen hydrates once per session
 *   and its in-memory fold state would overwrite the picker's write on the next
 *   change.
 *
 * ## What it deliberately does not cover
 *
 * **It is in memory.** An app kill between the write and the screen's next focus
 * loses the handoff, and the screen re-hydrates the pre-swap keys — the
 * behaviour before F35, and one tap on Done to fix. Persisting it would need a
 * second writer of fold state, which is the thing ruled out above.
 *
 * **Two writes before the screen consumes one are CHAINED, not replaced.**
 * The screen's fold state still describes the rows before the FIRST write, so a
 * second handoff alone — whose `before` is the first write's `after` — would be
 * applied to keys it does not describe. {@link recordSetsHandoff} composes the
 * two when they meet, and refuses a correspondence when they do not (found by
 * `frontend-reviewer` on F35: a second swap started before the first `load` ran).
 *
 * **Nothing else records one.** A change underneath the screen from anywhere
 * else — a sync pull, say — has no correspondence to offer, and
 * {@link handoffStillApplies} makes the screen discard a handoff whose rows are
 * no longer what SQLite holds, rather than applying it to rows it does not
 * describe.
 */

export type SetsHandoff = {
  /** `exercise_id` of each row the writer READ, in order. */
  before: string[];
  /** `exercise_id` of each row the writer WROTE, in order. */
  after: string[];
  /** `sourceOf[j]` is the index in `before` that `after[j]` came from, or `null` for a new row. */
  sourceOf: (number | null)[];
};

type Rows = readonly Pick<LoggedSet, 'exercise_id'>[];

const pending = new Map<string, SetsHandoff>();
const keyOf = (userId: string, sessionId: string) => `${userId}:${sessionId}`;
const ids = (rows: Rows) => rows.map((r) => r.exercise_id);

/**
 * A swap: every row stays where it was, and only exercises change.
 *
 * Identity is the correspondence ONLY if nothing was added or removed. A length
 * change would mean the writer did something other than a swap, and then no
 * correspondence is honest — so every row reads as new, and nothing stays folded.
 */
export function handoffForSwap(before: Rows, after: Rows): SetsHandoff {
  const identity = before.length === after.length;
  return {
    before: ids(before),
    after: ids(after),
    sourceOf: after.map((_, j) => (identity ? j : null)),
  };
}

/**
 * An append: the old rows are an untouched prefix, and the rest are new.
 *
 * The prefix is checked rather than assumed. If it was not preserved, the same
 * refusal as {@link handoffForSwap}: every row reads as new.
 */
export function handoffForAppend(before: Rows, after: Rows): SetsHandoff {
  const prefix =
    after.length >= before.length && before.every((r, i) => r.exercise_id === after[i].exercise_id);
  return {
    before: ids(before),
    after: ids(after),
    sourceOf: after.map((_, j) => (prefix && j < before.length ? j : null)),
  };
}

/**
 * Record the correspondence for this session's next `load`.
 *
 * If one is still unconsumed, the two are chained — see {@link chainHandoffs} —
 * because the screen has applied neither and its fold state still describes the
 * rows before the first.
 */
export function recordSetsHandoff(userId: string, sessionId: string, handoff: SetsHandoff): void {
  const key = keyOf(userId, sessionId);
  const prior = pending.get(key);
  pending.set(key, prior ? chainHandoffs(prior, handoff) : handoff);
}

/**
 * One handoff equivalent to applying `first` and then `second`.
 *
 * They chain only if `second` started from exactly the rows `first` wrote. If
 * not, something else changed the list in between, and there is no honest
 * correspondence: every row reads as new, so nothing stays folded — the same
 * refusal the builders make.
 */
export function chainHandoffs(first: SetsHandoff, second: SetsHandoff): SetsHandoff {
  const meets =
    first.after.length === second.before.length &&
    first.after.every((exercise, i) => exercise === second.before[i]);
  return {
    before: first.before,
    after: second.after,
    sourceOf: second.sourceOf.map((src) => (meets && src != null ? (first.sourceOf[src] ?? null) : null)),
  };
}

/** Take this session's pending handoff, if any. Returns a given handoff at most once. */
export function takeSetsHandoff(userId: string, sessionId: string): SetsHandoff | null {
  const key = keyOf(userId, sessionId);
  const handoff = pending.get(key) ?? null;
  pending.delete(key);
  return handoff;
}

/**
 * Whether SQLite still holds exactly the rows the writer wrote.
 *
 * A correspondence about rows that no longer exist is not a correspondence. If
 * anything changed the set list between the write and this read, the handoff
 * describes a list that is gone, and applying it would be the guess N543 declined
 * to make — so the screen drops it and leaves the fold state as it was.
 */
export function handoffStillApplies(handoff: SetsHandoff, current: Rows): boolean {
  return (
    current.length === handoff.after.length &&
    current.every((r, i) => r.exercise_id === handoff.after[i])
  );
}

/** Rebuild the fold state across the write a handoff describes. */
export function applySetsHandoff(collapsed: ReadonlySet<GroupKey>, handoff: SetsHandoff): Set<GroupKey> {
  const row = (exercise_id: string) => ({ exercise_id });
  return rekeyCollapsedAcross(
    collapsed,
    handoff.before.map(row),
    handoff.after.map(row),
    handoff.sourceOf,
  );
}
