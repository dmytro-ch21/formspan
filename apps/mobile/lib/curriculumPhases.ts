import type { CurriculumItem, CurriculumPhase } from './curriculum';

/**
 * A curriculum's items arranged for rendering: one group per phase, in array
 * order, plus a leading group for unphased items.
 *
 * `apps/web` has an identical module, for the reason `lib/curriculum.ts`
 * gives: the apps cannot import from each other and there is no `packages/`
 * yet. Keep the two in step.
 *
 * Two properties carry tests rather than a reviewer's glance:
 *
 *  - **Unphased items come FIRST.** A flat curriculum is entirely unphased; a
 *    MIXED curriculum's unphased items are the ones its author never
 *    assigned, and burying them at the bottom is how they silently vanish.
 *  - **An item's `phase` is an INDEX INTO THE ARRAY** — the contract's own
 *    definition — and a dangling index falls back to unphased rather than
 *    dropping the item. Impossible today via the composite FK; load-bearing
 *    the day a bug ships one.
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
