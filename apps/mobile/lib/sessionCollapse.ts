import type { DurationUnit } from './duration';
import { describeSet, groupSets, type LoggedSet } from './sessions';
import type { UnitSystem } from './units';

/**
 * Per-exercise "Done" on the strength session screen (N530/#961).
 *
 * The user's words: *"Sets should be collapsable with done button - this
 * exercise is done."* Tapping Done folds an exercise's rows down to one
 * summary line; tapping the header opens it back up.
 *
 * **Done is VIEW STATE. It writes nothing to any set.** The tempting version
 * marks every row `completed: true` on the way down, and that fabricates
 * performed sets — the exact thing N473 spent a ticket preventing. So an
 * unticked set under a collapsed header stays unticked, and the summary says
 * so ("2 of 3 done"). Everything in this module is a pure function over the
 * set list; nothing here can reach a `completed` flag, by construction.
 *
 * The state is a set of group keys, persisted per session in
 * `local_sessions.collapsed_json` (see `sessionStore.ts`'s
 * `readCollapsedGroups`/`saveCollapsedGroups`) so it survives an app kill,
 * and deliberately NOT part of `Session` — it never goes over the wire.
 */

/** One collapsed group. Opaque to callers; built by {@link groupKeys}. */
export type GroupKey = string;

/**
 * A stable key for each group in render order.
 *
 * Groups are runs of adjacent same-exercise rows (`groupSets`), and they have
 * no id: a set has no stable id either, and the group's first index moves
 * every time a set is added above it. So the key is the exercise plus WHICH
 * occurrence of that exercise this is — `squat#0`, `bench#0`, `squat#1` for a
 * squat / bench / squat session. That survives every index shift, and it
 * keeps the two squat blocks of a circuit independently collapsible, which
 * keying on the exercise alone would not.
 *
 * **The key is POSITIONAL, and saying only what it survives is how N543/#981
 * happened.** So, explicitly:
 *
 * STABLE against — a set added or removed WITHIN a block, a set added to any
 * other block, and any edit to a row's numbers, ticks, type or notes. None of
 * those changes how many blocks of an exercise exist or in what order.
 *
 * NOT STABLE against — anything that changes HOW MANY blocks of an exercise
 * PRECEDE this one. Three separate gestures do, and they are one mechanism
 * wearing three faces: **removing a block**, **removing a block's last set**,
 * and **anything that makes two same-exercise blocks adjacent, so `groupSets`
 * welds them into one** — which is both deleting the row between them AND
 * moving that row's block out from between them with the reorder arrows.
 * Drop the first squat and `squat#1` becomes `squat#0`; move the bench down
 * one in squat/bench/squat/deadlift/squat and `squat#2` becomes `squat#1`.
 * A `collapsed` set carried unchanged across any of those lands on a
 * different block — the fold jumps to a block nobody tapped, or the tapped
 * block loses it.
 *
 * **The third face is the one that was missed.** N543's first draft argued a
 * reorder was safe because two ADJACENT same-exercise blocks have already
 * merged, which is true and answers the wrong question: the reorder makes
 * them adjacent. `frontend-reviewer` reproduced it against these functions.
 * If you find yourself reasoning that some new mutator cannot rename a key,
 * write the circuit down and run it — the argument is easy to get right about
 * a case that is not the one that bites.
 *
 * **And two faces that happen OFF this screen (F35/#999).** Swapping an
 * exercise rewrites `exercise_id` on every row of it, so it renames every
 * block of BOTH the exercise swapped away from and the one swapped to, and can
 * weld a swapped block into a same-exercise neighbour. Appending an exercise
 * that matches the last block welds the new row into that block. Both are
 * written straight to SQLite by the exercise picker (`session/[id]/add.tsx`)
 * and by photo identify (`session/[id]/identify.tsx`) — never through the
 * session screen's `commit` — so the screen learns of them only when `load`
 * re-reads the sets on focus.
 *
 * Nothing here can prevent any of it, because a set carries no id to key on
 * instead. The caller must rebuild the fold state with {@link rekeyCollapsed}
 * or {@link rekeyCollapsedAcross}. The session screen does at every site that
 * removes or reorders — `removeSet`, `removeGroup`, `moveGroup` — and in
 * `load`, from the correspondence the off-screen writer recorded in
 * `lib/collapseHandoff.ts`, which is the one place that actually knows it.
 */
export function groupKeys(groups: readonly { exerciseID: string }[]): GroupKey[] {
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const n = seen.get(g.exerciseID) ?? 0;
    seen.set(g.exerciseID, n + 1);
    return `${g.exerciseID}#${n}`;
  });
}

/**
 * Carry the fold state across a change to the set list (N543/#981).
 *
 * **This is what makes an occurrence-numbered key safe.** The keys are
 * recomputed from scratch on every render, so a removal RENAMES every later
 * block of the same exercise — `squat#1` becomes `squat#0` the moment the
 * first squat goes. A `collapsed` set left alone across that rename does not
 * stay still; it silently moves to a different block. Found by review on
 * N530/#961: fold one squat of a circuit, remove the other, and the survivor
 * either folds itself or loses the fold the athlete gave it.
 *
 * `survivingOldIndices` is the correspondence, and only the caller has it:
 * `survivingOldIndices[j]` is the index, in `before`, of the set now at index
 * `j`. For a removal it is one `filter`; identity for anything that only
 * edits rows in place. Passing it rather than diffing is deliberate — a set
 * has no id (see `groupKeys`), so nothing here could recover the mapping
 * from the two lists alone, and a guess would be exactly the silent rename
 * this function exists to prevent.
 *
 * A merged block — deleting the bench out of squat/bench/squat welds the two
 * squats into one — reads as folded only if EVERY block feeding it was
 * folded. Folding rows the athlete never folded hides work they still owe;
 * leaving them open costs one tap.
 *
 * Keys naming blocks that no longer exist are DROPPED, so `collapsed_json`
 * cannot accumulate the debris of a long session's edits.
 */
export function rekeyCollapsed(
  collapsed: ReadonlySet<GroupKey>,
  before: readonly Pick<LoggedSet, 'exercise_id'>[],
  survivingOldIndices: readonly number[],
): Set<GroupKey> {
  // Out-of-range entries are dropped HERE and nowhere later, because the
  // correspondence below is positional: filtering the mapped rows instead
  // would shift `after`'s indices out of step with `surviving`'s, which is a
  // silent wrong answer rather than a missing one.
  const surviving = survivingOldIndices.filter((i) => i >= 0 && i < before.length);
  // A removal or a reorder keeps every surviving row's exercise, so the rows
  // after the change ARE the surviving rows and each one's source is the index
  // it came from. That is the special case of `rekeyCollapsedAcross` in which
  // nothing is relabelled — so this delegates, rather than keeping a second
  // copy of the grouping logic that could drift away from the first.
  return rekeyCollapsedAcross(collapsed, before, surviving.map((i) => before[i]), surviving);
}

/**
 * The general form of {@link rekeyCollapsed}: carry the fold state across a
 * change that can RELABEL rows, not only drop or reorder them (F35/#999).
 *
 * `rekeyCollapsed` builds the after-grouping from `before`'s own rows, which
 * is right for a removal or a reorder — every surviving row keeps its
 * exercise — and wrong for a swap, whose whole effect is to change
 * `exercise_id`. Grouping the old rows would compute the new keys from the old
 * exercise names.
 *
 * So this takes the rows as they are AFTER the change, and `sourceOf[j]` is the
 * index in `before` that `after[j]` came from, or `null` for a row that did not
 * exist before. For a swap that is identity; for an append it is the old
 * prefix followed by `null`s. As with `rekeyCollapsed`, only the writer knows
 * it, so it is a parameter rather than something diffed out of the two lists.
 *
 * **An after-block reads as folded only if EVERY row in it came from a folded
 * block.** That one rule covers each case F35 names:
 *
 * - a swapped block keeps the fold the athlete gave it, under its new name;
 * - a block the swap welds to a folded neighbour does NOT inherit that
 *   neighbour's fold, because part of it was never folded;
 * - a row APPENDED into a folded last block has no source, so the block opens
 *   rather than hiding the set the athlete has just added.
 *
 * Same asymmetry as N543, for the same reason: folding rows nobody folded
 * hides work still owed, and leaving them open costs one tap.
 */
export function rekeyCollapsedAcross(
  collapsed: ReadonlySet<GroupKey>,
  before: readonly Pick<LoggedSet, 'exercise_id'>[],
  after: readonly Pick<LoggedSet, 'exercise_id'>[],
  sourceOf: readonly (number | null)[],
): Set<GroupKey> {
  const beforeGroups = groupSets(before);
  const beforeKeys = groupKeys(beforeGroups);
  const groupOfSet: number[] = [];
  beforeGroups.forEach((g, gi) => g.indices.forEach((i) => (groupOfSet[i] = gi)));

  const afterGroups = groupSets(after);
  const afterKeys = groupKeys(afterGroups);

  const next = new Set<GroupKey>();
  afterGroups.forEach((g, gi) => {
    const folded = g.indices.every((j) => {
      const src = sourceOf[j];
      // No source, or one naming no row: a row the athlete never folded.
      if (src == null || src < 0 || src >= before.length) return false;
      return collapsed.has(beforeKeys[groupOfSet[src]]);
    });
    if (folded) next.add(afterKeys[gi]);
  });
  return next;
}

/** A new set with `key` flipped — collapsed if it was open, open if collapsed. */
export function toggleGroup(collapsed: ReadonlySet<GroupKey>, key: GroupKey): Set<GroupKey> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * The stored form, read back tolerantly.
 *
 * A blob this code has never written — NULL from a row that predates the
 * column, or anything that is not a JSON array of strings — reads as
 * "nothing collapsed". That is the only safe default: the worst case of a
 * wrong answer here is every exercise folded shut on a screen the athlete is
 * trying to log into, and the worst case of "nothing collapsed" is one extra
 * tap on Done.
 */
export function parseCollapsed(json: string | null | undefined): GroupKey[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

export type GroupSummary = {
  /** Every row in the group — drops included, since each has its own tick. */
  total: number;
  /** Rows with `completed: true`. Never written by this module — only read. */
  ticked: number;
  /** The one line the collapsed group shows. */
  text: string;
};

/**
 * The summary line a collapsed group shows.
 *
 * Shape: `3 sets · 8 × 100 kg · 2 of 3 done`. The middle term describes the
 * LAST NON-DROP row (the number the athlete is working at, by the same
 * reasoning `emptyWorkingSet` uses), and is omitted when that row has nothing
 * recorded on it yet — "Not recorded" in the middle of a summary is noise, not
 * information. The ticked-of-total term is always present, because it is the
 * one the ticket asks for: a collapsed exercise must never READ as fully done
 * when it is not.
 *
 * `total` and `ticked` count every row, drops included. A drop is a row with
 * its own tick on this screen, so "2 of 3 done" over `[working, drop,
 * working]` is what the athlete sees when they expand it — counting only the
 * ordinals would say "2 of 2" over the same rows, which is a lie about the
 * drop.
 */
export function summariseGroup(
  setsInGroup: readonly LoggedSet[],
  units: UnitSystem,
  duration: DurationUnit = 'seconds',
): GroupSummary {
  const total = setsInGroup.length;
  const ticked = setsInGroup.filter((s) => s.completed).length;
  const headline =
    [...setsInGroup].reverse().find((s) => s.set_type !== 'drop') ??
    setsInGroup[setsInGroup.length - 1];
  const parts = [`${total} ${total === 1 ? 'set' : 'sets'}`];
  if (headline && hasMeasure(headline)) parts.push(describeSet(headline, units, duration));
  parts.push(`${ticked} of ${total} done`);
  return { total, ticked, text: parts.join(' · ') };
}

function hasMeasure(s: LoggedSet): boolean {
  return s.reps != null || s.weight_kg != null || s.seconds != null || s.distance_m != null;
}
