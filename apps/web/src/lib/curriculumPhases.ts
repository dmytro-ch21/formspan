import type { CurriculumItem, CurriculumPhase } from "./api";

/**
 * A curriculum's items arranged for rendering: one group per phase, in phase
 * order, plus a leading group for unphased items.
 *
 * Small and pure on purpose — the grouping has two properties worth a real
 * test rather than a reviewer's glance:
 *
 *  - **Unphased items come FIRST, not last.** A flat curriculum (every one
 *    predating phases) is entirely unphased; rendering its items after an
 *    empty phase list is fine, but a MIXED curriculum's unphased items are
 *    the ones its author never assigned, and burying them at the bottom is
 *    how they silently vanish from attention. First keeps them visible.
 *  - **An item pointing at a phase that is not in the array falls back to
 *    unphased rather than disappearing.** The API's composite FK makes the
 *    dangling case impossible today; this guard is for the day a bug ships
 *    one, because a dropped item would misreport the curriculum's contents.
 */
export type PhaseGroup = {
  /** Null for the unphased group. */
  phase: CurriculumPhase | null;
  items: CurriculumItem[];
};

export function groupByPhase(
  phases: CurriculumPhase[],
  items: CurriculumItem[],
): PhaseGroup[] {
  // An item's `phase` is an INDEX INTO THE ARRAY — that is the contract's own
  // definition — not a match against the `order` field. The two coincide
  // today because the server writes dense zero-based orders, but the array
  // position is the promise; matching on `order` would silently unphase
  // everything the day the field ever became sparse.
  const unphased: CurriculumItem[] = [];
  const perPhase: CurriculumItem[][] = phases.map(() => []);
  for (const it of items) {
    if (it.phase !== null && it.phase >= 0 && it.phase < phases.length) {
      perPhase[it.phase].push(it);
    } else {
      unphased.push(it);
    }
  }
  const groups: PhaseGroup[] = [];
  if (unphased.length > 0) groups.push({ phase: null, items: unphased });
  phases.forEach((p, i) => {
    // Empty phases still render: a titled, described section with nothing in
    // it yet is authoring in progress, not nothing.
    groups.push({ phase: p, items: perPhase[i] });
  });
  return groups;
}
