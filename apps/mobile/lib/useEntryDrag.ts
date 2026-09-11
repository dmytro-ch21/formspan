/**
 * Drag a food entry to a place — N531/#962, completed by N553/#1019.
 *
 * ## What this used to be, and what changed
 *
 * Through N531 a drop landed on a SECTION and never on a position inside one,
 * and this comment said why: neither store had an order column, both listed a
 * meal by `logged_at, id`, so "put the eggs above the toast" had nowhere to be
 * written and would have snapped back on the next pull. That was the right
 * call and it is now obsolete — the athlete asked for the within-meal move a
 * second time, and N553 built the missing half (a `position` column on both
 * stores, through the sync path, rendered by web). The alternative that entry
 * named as not-taken is what this ticket took.
 *
 * So a drop now names TWO things: the meal it landed on, and the SLOT inside
 * that meal. `dropTargetFor` answers the first from the section frames;
 * `slotFor` answers the second from the row frames. A drop on a card's header
 * or its "Add Food" row — over the section but over no row — resolves to the
 * end of the meal, which is the honest reading of "this meal, unspecified
 * where".
 *
 * ## Why a hook rather than logic inside `MealCard`
 *
 * A drag crosses cards. The row that lifts belongs to one `MealCard`; the
 * section it lands on is another. So the thing that knows which section is
 * under the finger — and whether a drop is a move at all — has to sit above
 * both, in the day screen. And a hook is the shape that makes the drop
 * decision testable without a gesture: `renderHook`, `start`, `move`, `end`,
 * assert what `onDrop` was told. The gesture itself (`EntryRow`'s
 * `PanResponder`) is a thin caller of these three.
 *
 * ## Geometry comes from `measure`, injected
 *
 * Sections are measured in WINDOW coordinates at the moment a drag starts
 * (`measureInWindow`), not tracked via `onLayout`: a collapse (N468) or a
 * day switch changes every card's frame, and a stale layout would light up
 * the wrong section. The day view's own scroll is locked for the length of
 * the drag (`scrollEnabled={false}` — the caller's job), so the frames
 * measured at `start` stay true until `end`. `measure` is a parameter so a
 * test can hand in four rectangles and this file never touches a native
 * view.
 */

import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';

import type { Meal } from '@/lib/nutrition';

/** One meal card's vertical extent, in window coordinates. */
export type SectionFrame = { meal: Meal; top: number; bottom: number };

/** One ENTRY row's vertical extent, in the same window coordinates. */
export type RowFrame = { id: string; meal: Meal; top: number; bottom: number };

/** Everything measured at the moment a drag starts. */
export type Frames = { sections: SectionFrame[]; rows: RowFrame[] };

/**
 * Which slot inside `meal` a finger at `pageY` is over — the index the dragged
 * row would occupy in that meal WITHOUT itself.
 *
 * Compared against each row's MIDPOINT rather than its edges, which is what
 * makes the drop feel like it follows the finger: crossing the halfway line of
 * the row above is the moment the athlete expects the gap to open, and using
 * the row's top instead means the swap happens a whole row late.
 *
 * The dragged row is excluded before indexing, because "index 2 in the list
 * without me" is what a reorder means and what {@link plan} takes. Rows are
 * sorted by `top`, not trusted in call order — they are measured concurrently
 * and a `Promise.all` preserves input order, but the input order is the
 * caller's map over a card and nothing here should depend on that.
 *
 * A finger below every row (the "Add Food" button, the card's padding) returns
 * the length: the end of the meal.
 */
export function slotFor(
  pageY: number,
  meal: Meal,
  rows: readonly RowFrame[],
  draggedId: string,
): number {
  const mine = rows
    .filter((r) => r.meal === meal && r.id !== draggedId)
    .sort((a, b) => a.top - b.top);
  for (let i = 0; i < mine.length; i += 1) {
    if (pageY < (mine[i].top + mine[i].bottom) / 2) return i;
  }
  return mine.length;
}

/**
 * Which section a finger at `pageY` is over, or null between/outside them.
 *
 * Half-open `[top, bottom)` so two adjacent cards never both claim the
 * boundary pixel. Null — not "the nearest" — for a finger that has left every
 * card (the day pill, the summary, the tab bar): a drop there is a cancelled
 * drag, and snapping it to the closest section would move an entry the
 * athlete was trying NOT to move.
 */
export function dropTargetFor(pageY: number, frames: readonly SectionFrame[]): Meal | null {
  for (const f of frames) {
    if (pageY >= f.top && pageY < f.bottom) return f.meal;
  }
  return null;
}

export type EntryDrag = {
  /** The entry currently lifted, or null when nothing is. */
  active: { id: string; meal: Meal } | null;
  /** The section under the finger right now — the card that should light up. */
  target: Meal | null;
  /**
   * The slot inside {@link target} the row would land in, or null when the
   * finger is over no card. Drives the gap the day view opens under the
   * finger, which is the only thing that tells the athlete WHERE a within-meal
   * drop will put the row — a whole-card highlight cannot say that, and N531's
   * feedback was exactly that the move looked like it did nothing.
   */
  slot: number | null;
  /** Long-press fired on a row. No-op while `enabled` is false. */
  start: (id: string, meal: Meal) => void;
  /** The finger moved; `pageY` is its window y. */
  move: (pageY: number) => void;
  /** The finger lifted at `pageY`. Calls `onDrop` for a real move only. */
  end: (pageY: number) => void;
  /** The gesture was taken away (a system gesture, a terminated responder). */
  cancel: () => void;
};

export function useEntryDrag({
  enabled,
  measure,
  onDrop,
}: {
  /**
   * False while combine-select (N115) is active — a row that is a checkbox
   * is not a row that can be lifted. Also false with nobody signed in.
   */
  enabled: boolean;
  /** The cards' AND rows' window frames, fresh. Resolves to whatever could be
   *  measured; anything that has not laid out yet is simply absent. */
  measure: () => Promise<Frames>;
  /**
   * A drop that actually moves the row — a different meal, a different slot,
   * or both. `to`/`slot` name the destination; a drop that lands where the row
   * already was never reaches here (the caller's `plan` guards it a second
   * time, because a no-op write dirties a row and dirtying a row blocks
   * sharing).
   */
  onDrop: (id: string, from: Meal, to: Meal, slot: number) => void;
}): EntryDrag {
  const [active, setActive] = useState<{ id: string; meal: Meal } | null>(null);
  const [target, setTarget] = useState<Meal | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  // Refs, not state, for what the gesture reads on every move: a
  // `PanResponder` is built once and would otherwise close over the first
  // render's values.
  const activeRef = useRef<{ id: string; meal: Meal } | null>(null);
  const framesRef = useRef<Frames>({ sections: [], rows: [] });
  // A measurement that resolves after the drag it was started for has
  // already ended must not arm the NEXT drag with the previous one's frames.
  const dragSeq = useRef(0);
  /**
   * The last (section, slot) this drag announced, so a crossing is felt ONCE.
   *
   * `move` runs from `onPanResponderMove` — 60-120 times a second. React bails
   * out of an unchanged `setSlot`, which is why the re-render cost is per
   * crossing rather than per frame, but a haptic has no such bail-out: fired
   * unguarded here it is a buzz per frame, which is the single worst thing this
   * change could ship.
   */
  const feltAt = useRef<string | null>(null);

  const clear = useCallback(() => {
    activeRef.current = null;
    feltAt.current = null;
    framesRef.current = { sections: [], rows: [] };
    setActive(null);
    setTarget(null);
    setSlot(null);
  }, []);

  const start = useCallback(
    (id: string, meal: Meal) => {
      if (!enabled) return;
      dragSeq.current += 1;
      const seq = dragSeq.current;
      activeRef.current = { id, meal };
      framesRef.current = { sections: [], rows: [] };
      setActive({ id, meal });
      // The row lifts over its own section first, so the highlight starts
      // there rather than on nothing. No slot yet: until the frames arrive
      // there is no honest answer to "where in it", and guessing one would
      // open a gap under a finger that has not moved.
      setTarget(meal);
      setSlot(null);
      // The lift. A ~300ms hold with no confirmation means the athlete does not
      // know it registered until they move — which is exactly when it is too
      // late to find out it didn't. A row that rises under the finger in
      // silence reads as lag rather than as a lift.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      measure()
        .then((frames) => {
          if (seq !== dragSeq.current || !activeRef.current) return;
          framesRef.current = frames;
          // Seed the crossing guard with the slot the row is ALREADY in, so
          // the first movement is not announced as a crossing.
          //
          // Without this, `feltAt` is null when the finger first moves, the
          // row "enters" its own position, and the athlete feels the lift
          // impact followed a few tens of milliseconds later by a selection
          // tick — a double-buzz at pickup, announcing a move that has not
          // happened. The ticket's own device criterion forbids exactly that
          // ("a single light tap at the moment it lifts").
          //
          // `slotFor` excludes the dragged row, so removing it at index i and
          // reinserting at i is the identity — that index IS the origin slot.
          const originRows = frames.rows
            .filter((r) => r.meal === meal && r.id !== id)
            .sort((a, b) => a.top - b.top);
          const self = frames.rows.find((r) => r.id === id);
          const origin =
            self === undefined
              ? null
              : originRows.filter((r) => r.top < self.top).length;
          feltAt.current = origin === null ? null : `${meal}:${origin}`;
        })
        .catch(() => {
          // Unmeasurable cards mean no drop target can be found, so the
          // drag ends as a cancel — never a move onto a guessed section.
        });
    },
    [enabled, measure],
  );

  const move = useCallback((pageY: number) => {
    const a = activeRef.current;
    if (!a) return;
    const to = dropTargetFor(pageY, framesRef.current.sections);
    const nextSlot = to === null ? null : slotFor(pageY, to, framesRef.current.rows, a.id);
    setTarget(to);
    setSlot(nextSlot);
    // One tap per crossing, and nothing in between — this is what lets an
    // athlete feel where the row will land without watching the screen, which
    // is the whole point on a phone held one-handed between sets. `selection`
    // rather than `impact`: it is a lighter tick, and iOS uses it for exactly
    // this in its own reorder lists.
    const key = to === null ? null : `${to}:${nextSlot}`;
    if (key !== feltAt.current) {
      feltAt.current = key;
      if (key !== null) Haptics.selectionAsync().catch(() => {});
    }
  }, []);

  const end = useCallback(
    (pageY: number) => {
      const a = activeRef.current;
      if (!a) return;
      const to = dropTargetFor(pageY, framesRef.current.sections);
      // The frames may not have arrived yet (a lift-and-release faster than
      // a measure round trip) — then `to` is null and this is a cancel,
      // which is the right answer for a gesture that never really began.
      if (to) {
        onDrop(a.id, a.meal, to, slotFor(pageY, to, framesRef.current.rows, a.id));
        // The commit, and ONLY the commit. A release with no `to` is a cancel
        // — the frames never arrived — and a cancel must feel like nothing,
        // because confirming a move that did not happen is worse than silence.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      clear();
    },
    [onDrop, clear],
  );

  return { active, target, slot, start, move, end, cancel: clear };
}
