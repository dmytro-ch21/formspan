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
  const known = new Map(phases.map((p) => [p.order, p]));
  const unphased: CurriculumItem[] = [];
  const perPhase = new Map<number, CurriculumItem[]>(
    phases.map((p) => [p.order, []]),
  );
  for (const it of items) {
    if (it.phase !== null && known.has(it.phase)) {
      perPhase.get(it.phase)!.push(it);
    } else {
      unphased.push(it);
    }
  }
  const groups: PhaseGroup[] = [];
  if (unphased.length > 0) groups.push({ phase: null, items: unphased });
  for (const p of [...phases].sort((a, b) => a.order - b.order)) {
    // Empty phases still render: a titled, described section with nothing in
    // it yet is authoring in progress, not nothing.
    groups.push({ phase: p, items: perPhase.get(p.order) ?? [] });
  }
  return groups;
}
