import { MAX_FOCUS, type Focus } from './bjjFocus';
import type { CurriculumItem } from './curriculum';

/**
 * What the focus list should become, given a roadmap and what is in it now.
 *
 * **The bridge, and the reason this app can advance a roadmap at all.** The
 * loop is roadmap → `bjj_focus` → one-tap chips in the reflection wizard →
 * technique-tagged events → the completion criteria. Three of those four steps
 * were already on the phone; only choosing the focus was web-only, so an
 * athlete who trains and logs entirely here had to open a laptop to move their
 * own roadmap on.
 *
 * ---
 *
 * **`PUT /v1/bjj/focus` REPLACES THE LIST WHOLESALE**, which is what this
 * module exists to handle safely. A naive "put my roadmap in focus" would
 * silently delete whatever the athlete chose by hand — destructive, and against
 * the recorded UX direction. So this computes a proposal and reports what it
 * would evict, letting the caller show that before anything is written.
 *
 * The rules, in order:
 *
 *  1. **A mastered roadmap technique leaves.** That is the advance: finishing
 *     one is what makes room for the next.
 *  2. **Unmastered roadmap STEPS come in, in roadmap order.** Order is the
 *     content of a syllabus.
 *  3. **Whatever the athlete already had is kept in the leftover slots.** It is
 *     theirs; the roadmap is not entitled to it.
 *  4. **Capped at `MAX_FOCUS`.**
 *
 * Rule 3 against rule 4 is where eviction comes from, and `dropped` names those
 * so the UI can say which rather than quietly doing it.
 *
 * **This is a second copy** — `apps/web/src/lib/roadmapFocus.ts` holds the same
 * rule against the same endpoint. The two apps cannot import from each other
 * and there is no `packages/` yet, the same gap `lib/proficiency.ts` and the
 * adherence rule both ran into. That is now three shared rules duplicated by
 * hand; the next one should probably force the package instead.
 */
export type FocusProposal = {
  /** The list to send, in order. Never longer than `MAX_FOCUS`. */
  next: string[];
  /** Roadmap techniques entering focus that were not in it before. */
  added: CurriculumItem[];
  /**
   * What would leave, and why. `mastered` is the advance working as intended;
   * `evicted` is the athlete losing a choice to the cap, and only that one is
   * worth a warning.
   */
  dropped: { focus: Focus; reason: 'mastered' | 'evicted' }[];
  /** True when applying would change nothing, so the UI can say so rather than
   *  offering a button that writes an identical list. */
  unchanged: boolean;
};

export function proposeFocus(
  items: CurriculumItem[],
  current: Focus[],
  max: number = MAX_FOCUS,
): FocusProposal {
  const inRoadmap = new Map(items.map((i) => [i.technique_id, i]));

  // Rules 1 and 2. Only items that are roadmap STEPS — an item with no criteria
  // is reading, and a slot spent on something nothing can complete is a
  // category error on a list capped at five.
  const wanted = items.filter(
    (i) => i.criteria !== null && !(i.progress?.mastered ?? false),
  );

  // Rule 3. Anything the athlete holds that this roadmap has not mastered for
  // them — including entries unrelated to the roadmap, which is the point.
  const keep = current.filter((f) => {
    const item = inRoadmap.get(f.technique_id);
    if (!item) return true;
    return !(item.progress?.mastered ?? false);
  });

  const next: string[] = [];
  const seen = new Set<string>();
  for (const source of [wanted.map((w) => w.technique_id), keep.map((k) => k.technique_id)]) {
    for (const id of source) {
      if (next.length >= max) break;
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
  }

  const before = new Set(current.map((f) => f.technique_id));
  const after = new Set(next);

  return {
    next,
    added: wanted.filter((w) => after.has(w.technique_id) && !before.has(w.technique_id)),
    dropped: current
      .filter((f) => !after.has(f.technique_id))
      .map((f) => ({
        focus: f,
        reason: (inRoadmap.get(f.technique_id)?.progress?.mastered
          ? 'mastered'
          : 'evicted') as 'mastered' | 'evicted',
      })),
    // Same members AND same order. The wizard renders the chips in this order,
    // so a reshuffle is a real change even when the set is identical.
    unchanged:
      next.length === current.length &&
      next.every((id, i) => current[i]?.technique_id === id),
  };
}
