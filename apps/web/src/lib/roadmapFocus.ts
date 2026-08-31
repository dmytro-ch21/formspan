import { MAX_BJJ_FOCUS, type BjjFocus, type CurriculumItem } from "./api";

/**
 * What the focus list should become, given a roadmap and what is in it now.
 *
 * **This is the bridge the design doc calls for**, and it closes the loop the
 * whole feature rests on: a roadmap's current techniques become focus rows,
 * focus rows already render as one-tap chips in the reflection wizard, those
 * chips write technique-tagged events, and those events are exactly what the
 * completion criteria read. Every part of that except this selection already
 * shipped — which is why wiring it needs no backend change at all.
 *
 * ---
 *
 * **`PUT /v1/bjj/focus` REPLACES THE LIST WHOLESALE.** That is the fact this
 * module exists to handle safely. A naive "put my roadmap in focus" would
 * silently delete whatever the athlete had chosen by hand, which is both
 * destructive and against the recorded UX direction. So this computes a
 * proposal, reports what it would evict, and lets the caller show that before
 * anything is written.
 *
 * The rules, in order:
 *
 *  1. **A mastered roadmap technique leaves.** That is the advance: finishing
 *     one is what makes room for the next, and leaving it there would spend a
 *     slot on something the record already says you own.
 *  2. **Unmastered roadmap techniques come in, in roadmap order.** The order is
 *     the content of a syllabus — someone put the guard retention before the
 *     sweep on purpose.
 *  3. **Whatever the athlete already had is kept in the leftover slots**, in its
 *     existing order. It is theirs; the roadmap is not entitled to it.
 *  4. **Capped at `MAX_BJJ_FOCUS`.** The bound is the feature — a focus list of
 *     twenty is the library again, and the wizard would be back to searching.
 *
 * Rule 3 is where the eviction comes from: a roadmap wanting four slots when
 * the athlete already holds five means one of theirs is pushed out. `dropped`
 * names those so the UI can say which, rather than quietly doing it.
 */
export type FocusProposal = {
  /** The list to send, in order. Never longer than `MAX_BJJ_FOCUS`. */
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
   * Entries that would leave, and why. `mastered` ones are the advance working
   * as intended; `evicted` ones are the athlete's own choices being pushed out
   * by the cap, which is the only case worth a warning.
   */
  dropped: { focus: BjjFocus; reason: "mastered" | "evicted" }[];
  /**
   * True when applying would change nothing — so the UI can say so rather
   * than offering a button that does nothing.
   *
   * **Two conditions, not one — this is N100.** The list has to match AND
   * every id this roadmap is a reason for (`fromRoadmap`) has to already
   * carry THIS curriculum's claim. List-match alone gets a second roadmap
   * wrong: when its techniques are already all in focus (placed there by a
   * FIRST roadmap, or by hand), `next` equals `current` and the naive answer
   * is "unchanged" — but applying is still a real write, because it registers
   * this roadmap's own claim in `bjj_focus_sources`. Skip that write and the
   * technique has no source but the first roadmap's; deactivate that one and
   * the technique leaves focus while this roadmap is still working it, which
   * is exactly the bug N95 closed for one roadmap and N100 closes for two.
   */
  unchanged: boolean;
};

/** Whether `curriculumID` already has a registered claim on `techniqueID`,
 *  per the athlete's CURRENT focus list — the fact `unchanged` above needs
 *  and a plain list comparison cannot see. */
function alreadyClaims(current: BjjFocus[], techniqueID: string, curriculumID: string): boolean {
  return current.some(
    (f) => f.technique_id === techniqueID && f.curriculum_ids.includes(curriculumID),
  );
}

export function proposeFocus(
  items: CurriculumItem[],
  current: BjjFocus[],
  /**
   * The roadmap being applied — needed only to compute `unchanged` correctly.
   * See `FocusProposal.unchanged`.
   */
  curriculumID: string,
  max: number = MAX_BJJ_FOCUS,
): FocusProposal {
  // Concept items carry no technique_id — they are ideas, and an idea cannot
  // be a focus row. Narrowed once here so everything below works with a
  // guaranteed id.
  const steps = items.filter(
    (i): i is CurriculumItem & { technique_id: string } =>
      typeof i.technique_id === "string" && i.technique_id !== "",
  );
  const inRoadmap = new Map(steps.map((i) => [i.technique_id, i]));

  // Rule 1 + 2. Only items that are actually roadmap STEPS — an item with no
  // criteria is reading, and putting something you are merely studying into a
  // list whose whole job is to capture live outcomes would be a category error.
  const wanted = steps.filter(
    (i) => i.criteria !== null && !(i.progress?.mastered ?? false),
  );

  // Rule 3. Anything the athlete holds that this roadmap has not mastered for
  // them. A hand-set entry unrelated to the roadmap survives here too — that is
  // the point.
  const keep = current.filter((f) => {
    const item = inRoadmap.get(f.technique_id);
    if (!item) return true; // not ours to touch
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

  const added = wanted.filter(
    (w) => after.has(w.technique_id) && !before.has(w.technique_id),
  );

  const dropped = current
    .filter((f) => !after.has(f.technique_id))
    .map((f) => {
      const item = inRoadmap.get(f.technique_id);
      return {
        focus: f,
        reason: (item?.progress?.mastered ? "mastered" : "evicted") as
          | "mastered"
          | "evicted",
      };
    });

  return {
    next,
    fromRoadmap: next.filter((id) => inRoadmap.has(id)),
    added,
    dropped,
    // Same members AND same order — the athlete's own ranking, and the wizard
    // renders the chips in it, so a reshuffle is a real change even when the
    // set is identical — AND every roadmap-owned id in `next` already carries
    // THIS curriculum's claim. That last clause is N100: without it, a second
    // roadmap whose techniques are already all in focus reads as unchanged and
    // the apply control disappears, so it can never register its own claim.
    unchanged:
      next.length === current.length &&
      next.every((id, i) => current[i]?.technique_id === id) &&
      next
        .filter((id) => inRoadmap.has(id))
        .every((id) => alreadyClaims(current, id, curriculumID)),
  };
}
