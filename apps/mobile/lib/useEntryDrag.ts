/**
 * Drag a food entry from one meal section to another — N531/#962.
 *
 * ## What this is, and what it deliberately is not
 *
 * A drop lands on a SECTION, never on a position inside one. Neither
 * `nutrition_entries` on the server nor `food_entries` on the phone has an
 * order column — both list a meal by `logged_at, id` — so there is nothing a
 * within-meal reorder could be written to, and a drag that let the athlete
 * "put the eggs above the toast" would snap back on the next pull. The
 * ticket's own rule is "do not ship a drag that silently forgets", and the
 * honest way to obey it without a server change is to not offer the thing
 * that would be forgotten: the target is the meal, the highlight is the
 * whole card, and the row sorts into its new section by its log time. See
 * `docs/decisions/history.md`'s N531 entry for the alternative (an order
 * column: migration, OpenAPI, sync, web) and why it was not taken here.
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

import { useCallback, useRef, useState } from 'react';

import type { Meal } from '@/lib/nutrition';

/** One meal card's vertical extent, in window coordinates. */
export type SectionFrame = { meal: Meal; top: number; bottom: number };

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
  /** The four cards' window frames, fresh. Resolves to whatever could be
   *  measured; a card that has not laid out yet is simply absent. */
  measure: () => Promise<SectionFrame[]>;
  /** A drop on a DIFFERENT section than the entry started in. */
  onDrop: (id: string, from: Meal, to: Meal) => void;
}): EntryDrag {
  const [active, setActive] = useState<{ id: string; meal: Meal } | null>(null);
  const [target, setTarget] = useState<Meal | null>(null);
  // Refs, not state, for what the gesture reads on every move: a
  // `PanResponder` is built once and would otherwise close over the first
  // render's values.
  const activeRef = useRef<{ id: string; meal: Meal } | null>(null);
  const framesRef = useRef<SectionFrame[]>([]);
  // A measurement that resolves after the drag it was started for has
  // already ended must not arm the NEXT drag with the previous one's frames.
  const dragSeq = useRef(0);

  const clear = useCallback(() => {
    activeRef.current = null;
    framesRef.current = [];
    setActive(null);
    setTarget(null);
  }, []);

  const start = useCallback(
    (id: string, meal: Meal) => {
      if (!enabled) return;
      dragSeq.current += 1;
      const seq = dragSeq.current;
      activeRef.current = { id, meal };
      framesRef.current = [];
      setActive({ id, meal });
      // The row lifts over its own section first, so the highlight starts
      // there rather than on nothing.
      setTarget(meal);
      measure()
        .then((frames) => {
          if (seq !== dragSeq.current || !activeRef.current) return;
          framesRef.current = frames;
        })
        .catch(() => {
          // Unmeasurable cards mean no drop target can be found, so the
          // drag ends as a cancel — never a move onto a guessed section.
        });
    },
    [enabled, measure],
  );

  const move = useCallback((pageY: number) => {
    if (!activeRef.current) return;
    setTarget(dropTargetFor(pageY, framesRef.current));
  }, []);

  const end = useCallback(
    (pageY: number) => {
      const a = activeRef.current;
      if (!a) return;
      const to = dropTargetFor(pageY, framesRef.current);
      // The frames may not have arrived yet (a lift-and-release faster than
      // a measure round trip) — then `to` is null and this is a cancel,
      // which is the right answer for a gesture that never really began.
      if (to && to !== a.meal) onDrop(a.id, a.meal, to);
      clear();
    },
    [onDrop, clear],
  );

  return { active, target, start, move, end, cancel: clear };
}
