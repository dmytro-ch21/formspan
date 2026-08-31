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
  /**
   * Which of `next` this roadmap is a reason for — its own techniques, and
   * nothing else.
   *
   * **A strict subset of `next`, and that is the entire point.** Rule 3 keeps
   * the athlete's own entries in the list, so `next` is a mix of two
   * provenances; sending it as though the roadmap owned all of it would give
   * the roadmap the power to delete hand-picked techniques when it is
   * deactivated. The server attributes exactly these ids and no others.
   *
   * Every roadmap technique in `next`, not just the newly added ones: a
   * technique a SECOND roadmap also wants must gain that roadmap's claim too,
   * or deactivating the first one takes it away from the second. The server's
   * own rule protects hand-picked rows from being claimed, so naming them here
   * is safe and naming too few is not.
   */
  fromRoadmap: string[];
  /** Roadmap techniques entering focus that were not in it before. */
  added: CurriculumItem[];
  /**
   * What would leave, and why. `mastered` is the advance working as intended;
   * `evicted` is the athlete losing a choice to the cap, and only that one is
   * worth a warning.
   */
  dropped: { focus: Focus; reason: 'mastered' | 'evicted' }[];
  /**
   * True when applying would change nothing, so the UI can say so rather than
   * offering a button that writes an identical list.
   *
   * **Two conditions, not one — this is N100.** The list has to match AND
   * every id this roadmap is a reason for (`fromRoadmap`) has to either
   * already carry THIS curriculum's claim OR be provably unclaimable (N100.1
   * — see `isUnclaimable`). List-match alone gets a second roadmap wrong:
   * when its techniques are already all in focus (placed there by a FIRST
   * roadmap, or by hand), `next` equals `current` and the naive answer is
   * "unchanged" — but applying is still a real write, because it registers
   * this roadmap's own claim in `bjj_focus_sources`. Skip that write and the
   * technique has no source but the first roadmap's; deactivate that one and
   * the technique leaves focus while this roadmap is still working it, which
   * is exactly the bug N95 closed for one roadmap and N100 closes for two.
   *
   * **The "or unclaimable" half is N100.1.** A technique the athlete
   * hand-picked (or one whose provenance predates the `origin` column) has
   * `curriculum_ids: []` and the server's claim INSERT is guarded by
   * `origin = 'roadmap'` — it will never register ANY roadmap's claim on
   * that row. Requiring `alreadyClaims` alone for such a row makes
   * `unchanged` false forever: the list never changes, no claim is ever
   * granted, and the apply control never clears. `isUnclaimable` recognises
   * that case and lets `unchanged` become true once there is truly nothing
   * left the server would do differently.
   */
  unchanged: boolean;
};

/** Whether `curriculumID` already has a registered claim on `techniqueID`,
 *  per the athlete's CURRENT focus list — the fact `unchanged` above needs
 *  and a plain list comparison cannot see.
 *
 *  `?? []` guards a `curriculum_ids` that never arrived: `fetchFocus`
 *  normalises the top-level array but not this per-row field, so a server
 *  that hasn't deployed this column yet — a real rollout skew, not a
 *  hypothetical — would otherwise hand this `undefined` and throw on
 *  `.includes` the moment the athlete opens the roadmap's overflow menu,
 *  rather than degrading to "nothing claimed". */
function alreadyClaims(current: Focus[], techniqueID: string, curriculumID: string): boolean {
  return current.some(
    (f) => f.technique_id === techniqueID && (f.curriculum_ids ?? []).includes(curriculumID),
  );
}

/**
 * Whether `techniqueID` is an EXISTING focus row no roadmap will ever be
 * allowed to claim — the other fact `unchanged` needs and `alreadyClaims`
 * cannot answer on its own.
 *
 * **Only defined for a row already in `current`.** An id absent from
 * `current` is a NEW addition — `added` covers that, and it is a real write,
 * so this must not be asked about it (it would vacuously return `false`,
 * which happens to be correct, but for the wrong reason — don't rely on it).
 *
 * **The proof, not a guess.** `SetFocus` (`focus_postgres.go`) only ever
 * gives a row `origin = 'roadmap'` in the SAME transaction it inserts that
 * roadmap's claim into `bjj_focus_sources`, and `ReleaseFocusSource` deletes
 * a `'roadmap'`-origin row in the SAME statement that removes its last
 * source — so a `'roadmap'`-origin row can never be read back with zero
 * sources. An empty `curriculum_ids` on an existing row is therefore proof
 * the row is `'athlete'`- or `'unknown'`-origin, and the server's own guard
 * (`WHERE f.origin = 'roadmap'` on the claim INSERT) will refuse to attach
 * any curriculum to it, forever. Treating that refusal as a pending write is
 * the N100.1 bug: the apply control never clears for a roadmap that overlaps
 * a hand-picked (or pre-provenance) technique.
 *
 * **One acknowledged exception, not silently missed.** A `'roadmap'`-origin
 * row CAN be read back with zero sources if a client claims a technique
 * without enrolling and the owner later deletes that curriculum —
 * `bjj_focus_sources.curriculum_id` is `ON DELETE CASCADE`, not blocked by
 * enrollment, and `migrations/000069_bjj_focus_provenance.up.sql` documents
 * this as "a real state, not an impossible one". Such a row IS still
 * claimable, so `isUnclaimable` would wrongly call it unclaimable and hide
 * the control. This needs a non-conforming client plus a curriculum
 * deletion, is self-inflicted, and is recoverable by re-editing the focus
 * list by hand — accepted rather than guarded against here.
 */
function isUnclaimable(current: Focus[], techniqueID: string): boolean {
  return current.some(
    (f) => f.technique_id === techniqueID && (f.curriculum_ids ?? []).length === 0,
  );
}

/**
 * The same proposal for ONE technique — what "work on this" does from a lesson.
 *
 * The roadmap screen expands a lesson in place and offers to start it, which is
 * a different request from "apply this whole roadmap": the athlete named one
 * thing, so nothing else may be pulled in behind it. Rules 3 and 4 still hold —
 * what they already had is kept, and the cap still evicts from the end — but
 * rule 2 is narrowed to the single id, and rule 1 does not apply at all: this
 * is an addition, not an advance.
 *
 * The chosen technique goes FIRST, which is also what stops the cap silently
 * refusing the request. Appended, a sixth pick would be the one dropped, and
 * the button would do nothing while reporting success.
 *
 * Returns `unchanged` when it is already in focus, so the caller can say so
 * rather than writing an identical list.
 */
export function proposeOneFocus(
  items: CurriculumItem[],
  current: Focus[],
  /**
   * The curriculum this "work on this" is FROM — needed only to compute
   * `unchanged` correctly. See `FocusProposal.unchanged`.
   */
  curriculumID: string,
  techniqueID: string,
  max: number = MAX_FOCUS,
): FocusProposal {
  const item = items.find((i) => i.technique_id === techniqueID);
  const inRoadmap = new Map(
    items
      .filter((i): i is CurriculumItem & { technique_id: string } => !!i.technique_id)
      .map((i) => [i.technique_id, i]),
  );

  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of [techniqueID, ...current.map((f) => f.technique_id)]) {
    if (next.length >= max) break;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  const before = new Set(current.map((f) => f.technique_id));
  const after = new Set(next);

  return {
    next,
    fromRoadmap: next.filter((id) => inRoadmap.has(id)),
    added: before.has(techniqueID) || !item ? [] : [item],
    // Only ever `evicted` here: nothing is being retired for being mastered,
    // so anything that falls off did so because the athlete is at the cap.
    dropped: current
      .filter((f) => !after.has(f.technique_id))
      .map((f) => ({ focus: f, reason: 'evicted' as const })),
    unchanged:
      next.length === current.length &&
      next.every((id, i) => current[i]?.technique_id === id) &&
      next
        .filter((id) => inRoadmap.has(id))
        .every((id) => alreadyClaims(current, id, curriculumID) || isUnclaimable(current, id)),
  };
}

export function proposeFocus(
  items: CurriculumItem[],
  current: Focus[],
  /**
   * The roadmap being applied — needed only to compute `unchanged` correctly.
   * See `FocusProposal.unchanged`.
   */
  curriculumID: string,
  max: number = MAX_FOCUS,
): FocusProposal {
  // Concept items carry no technique_id — an idea cannot be a focus row.
  // Narrowed once here so everything below works with a guaranteed id.
  const steps = items.filter(
    (i): i is CurriculumItem & { technique_id: string } =>
      typeof i.technique_id === 'string' && i.technique_id !== '',
  );
  const inRoadmap = new Map(steps.map((i) => [i.technique_id, i]));

  // Rules 1 and 2. Only items that are roadmap STEPS — an item with no criteria
  // is reading, and a slot spent on something nothing can complete is a
  // category error on a list capped at five.
  const wanted = steps.filter(
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
    fromRoadmap: next.filter((id) => inRoadmap.has(id)),
    added: wanted.filter((w) => after.has(w.technique_id) && !before.has(w.technique_id)),
    dropped: current
      .filter((f) => !after.has(f.technique_id))
      .map((f) => ({
        focus: f,
        reason: (inRoadmap.get(f.technique_id)?.progress?.mastered
          ? 'mastered'
          : 'evicted') as 'mastered' | 'evicted',
      })),
    // Same members AND same order — the wizard renders the chips in this
    // order, so a reshuffle is a real change even when the set is identical —
    // AND every roadmap-owned id in `next` either already carries THIS
    // curriculum's claim OR is provably unclaimable (N100.1 — a hand-picked
    // or pre-provenance row the server will never let this roadmap attach
    // to, so there is nothing left for "apply" to write). That claim clause
    // is N100: without it, a second roadmap whose techniques are already all
    // in focus reads as unchanged and the apply control disappears, so it
    // can never register its own claim.
    unchanged:
      next.length === current.length &&
      next.every((id, i) => current[i]?.technique_id === id) &&
      next
        .filter((id) => inRoadmap.has(id))
        .every((id) => alreadyClaims(current, id, curriculumID) || isUnclaimable(current, id)),
  };
}
