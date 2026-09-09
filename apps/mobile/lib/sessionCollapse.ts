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
 * other block, any edit to a row's numbers, ticks, type or notes, and a
 * reorder that does not change the relative order of two same-exercise
 * blocks (which is every reorder the screen can perform: `moveGroup` moves by
 * one place, and two adjacent same-exercise blocks have already merged into
 * one).
 *
 * NOT STABLE against — anything that changes HOW MANY blocks of an exercise
 * precede this one. Removing a block, removing a block's last set, and
 * deleting the row between two same-exercise blocks (which merges them) all
 * RENAME later blocks of that exercise: drop the first squat and `squat#1`
 * becomes `squat#0`. A `collapsed` set carried unchanged across one of those
 * therefore lands on a different block — the fold jumps to a block nobody
 * tapped, or the tapped block loses it. Nothing here can prevent that,
 * because a set carries no id to key on instead; the caller must rebuild the
 * fold state with {@link rekeyCollapsed}, and the session screen does at
 * every site that removes a row or a block.
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

  const beforeGroups = groupSets(before);
  const beforeKeys = groupKeys(beforeGroups);
  const groupOfSet: number[] = [];
  beforeGroups.forEach((g, gi) => g.indices.forEach((i) => (groupOfSet[i] = gi)));

  const afterGroups = groupSets(surviving.map((i) => before[i]));
  const afterKeys = groupKeys(afterGroups);

  const next = new Set<GroupKey>();
  afterGroups.forEach((g, gi) => {
    const sources = new Set(g.indices.map((i) => groupOfSet[surviving[i]]));
    if ([...sources].every((s) => collapsed.has(beforeKeys[s]))) next.add(afterKeys[gi]);
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
