import { randomUUID } from 'expo-crypto';

import type { Curriculum, CurriculumItemWrite, CurriculumWrite, Visibility } from './curriculum';

/**
 * The draft state for the mobile curriculum builder (N83) — pure logic, kept
 * out of `components/curriculum/CurriculumEditor.tsx` on purpose, the same
 * reasoning `curriculumRow.ts` gives for its own split: this is exactly where
 * the web builder's blocking findings lived (a phase removed without
 * remapping the items pointing at it, a criteria field cleared without its
 * dependent), and none of that is reachable from a component test that only
 * renders the screen.
 *
 * Mirrors `apps/web`'s `CurriculumBuilder.tsx` reduced to a single reorderable
 * list rather than two panes — see that file's own doc comment for why phases
 * and items stay flat lists with a per-row phase index rather than nested
 * drag targets. The mobile reduction is the SAME shape, with up/down buttons
 * standing in for drag-and-drop, which is the one thing genuinely harder on a
 * phone than a mouse.
 */

/** A phase as the builder holds it, with a stable local key — phases reorder
 *  too, and an index key would carry a focused `TextInput`'s state to
 *  whatever row lands at that index after a move. Stripped before saving. */
export type PhaseDraft = { _key: string; title: string; description: string };

/** An item as the builder holds it: the wire shape plus a stable local key —
 *  concept rows have no `technique_id` to key a reorderable list on, and an
 *  index key would re-attach open/closed editor state to whatever row lands
 *  at that index after a move. Stripped before saving. */
export type ItemDraft = CurriculumItemWrite & { _key: string };

/** `expo-crypto`'s `randomUUID`, the id source every other local-first module
 *  in this app already uses (see `lib/sessions.ts`, `lib/plan.ts`) — not a
 *  module counter, which resets on Fast Refresh while preserved component
 *  state keeps the old keys, so the next added row would collide. */
export function nextKey(): string {
  return randomUUID();
}

/** Seeds the builder's phase drafts from an existing curriculum, or empty for
 *  a new one. */
export function phaseDraftsOf(existing?: Curriculum): PhaseDraft[] {
  return (existing?.phases ?? []).map((p) => ({
    _key: nextKey(),
    title: p.title,
    description: p.description,
  }));
}

/** Seeds the builder's item drafts from an existing curriculum, or empty for
 *  a new one. Criteria come back flattened onto the item, matching the wire
 *  shape the builder edits directly rather than nesting a `criteria` object
 *  the way the READ side does. */
export function itemDraftsOf(existing?: Curriculum): ItemDraft[] {
  return (existing?.items ?? []).map((it) => ({
    _key: nextKey(),
    kind: it.kind,
    technique_id: it.technique_id,
    title: it.title,
    phase: it.phase,
    notes: it.notes,
    target_scored: it.criteria?.target_scored ?? null,
    target_defended: it.criteria?.target_defended ?? null,
    target_sessions: it.criteria?.target_sessions ?? null,
    min_hit_rate: it.criteria?.min_hit_rate ?? null,
    target_drilled_sessions: it.criteria?.target_drilled_sessions ?? null,
  }));
}

/** What the builder shows for a technique item it did not just add itself —
 *  name and position, read off the curriculum's own `items` (which carry
 *  them on every read, per `lib/curriculum.ts`'s `CurriculumItem`) rather
 *  than re-fetched. A freshly-added item's meta comes from the technique the
 *  picker handed over instead; see `CurriculumEditor`. */
export function techniqueMetaOf(existing?: Curriculum): Record<string, { name: string; position: string }> {
  const out: Record<string, { name: string; position: string }> = {};
  for (const it of existing?.items ?? []) {
    if (it.technique_id) out[it.technique_id] = { name: it.name, position: it.position };
  }
  return out;
}

/**
 * Removing a phase remaps every item: its members go unphased rather than
 * vanishing, and later phases shift down one — an item's `phase` is an INDEX
 * into the phases array, so the two must move together or the save carries
 * items pointing at the wrong section (or, past the end of a shortened array,
 * at nothing the server can validate).
 */
export function removePhaseAt(
  phases: PhaseDraft[],
  items: ItemDraft[],
  idx: number,
): { phases: PhaseDraft[]; items: ItemDraft[] } {
  return {
    phases: phases.filter((_, i) => i !== idx),
    items: items.map((it) => {
      if (it.phase == null) return it;
      if (it.phase === idx) return { ...it, phase: null };
      return it.phase > idx ? { ...it, phase: it.phase - 1 } : it;
    }),
  };
}

/** Swapping two phases swaps their members' indexes with them — two separate
 *  array operations rather than one nested inside the other, so a caller
 *  driving both off one `setState` cannot apply the item remap twice. */
export function movePhase(
  phases: PhaseDraft[],
  items: ItemDraft[],
  idx: number,
  delta: -1 | 1,
): { phases: PhaseDraft[]; items: ItemDraft[] } {
  const to = idx + delta;
  if (to < 0 || to >= phases.length) return { phases, items };
  const nextPhases = [...phases];
  [nextPhases[idx], nextPhases[to]] = [nextPhases[to], nextPhases[idx]];
  const nextItems = items.map((it) => {
    if (it.phase === idx) return { ...it, phase: to };
    if (it.phase === to) return { ...it, phase: idx };
    return it;
  });
  return { phases: nextPhases, items: nextItems };
}

/** Generic "swap with a neighbour" reorder for a plain array, used for both
 *  the phase list and the item list — bounds-checked so a caller can wire it
 *  straight to a disabled-at-the-edges up/down button pair. */
export function moveAt<T>(list: T[], idx: number, delta: -1 | 1): T[] {
  const to = idx + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[idx], next[to]] = [next[to], next[idx]];
  return next;
}

/**
 * What the server will refuse, said before the round trip rather than after —
 * the server's whole-content 400 (`invalidContentMsg`) cannot say which of up
 * to 60 rows was the untitled concept, but the client building the request
 * knows exactly which one.
 *
 * Mirrors `CurriculumBuilder.tsx`'s `save()` guard clauses. Returns the first
 * problem found, or null when the draft is postable.
 */
export function validateDraft(name: string, phases: PhaseDraft[], items: ItemDraft[]): string | null {
  if (name.trim() === '') return 'Give this curriculum a name.';
  if (items.some((i) => i.kind === 'concept' && !i.title?.trim())) {
    return 'Every concept needs a title — or remove the empty one.';
  }
  if (phases.some((p) => !p.title.trim())) {
    return 'Every phase needs a title — or remove the empty one.';
  }
  return null;
}

/**
 * The draft, as the wire wants it. `phases` travels only WITH `items` (the
 * server refuses them apart), and an empty phases array is omitted entirely —
 * items without phases is the wire's spelling of "flat", which is also what
 * deleting your last phase should mean.
 */
export function draftToWrite(input: {
  name: string;
  description: string;
  belt: string;
  visibility: Visibility;
  phases: PhaseDraft[];
  items: ItemDraft[];
}): CurriculumWrite {
  const { name, description, belt, visibility, phases, items } = input;
  return {
    name: name.trim(),
    description: description.trim(),
    // Empty select means "not a belt syllabus", which is null rather than "" —
    // PATCH treats an explicit null as CLEAR, matching web.
    belt: belt === '' ? null : belt,
    visibility,
    ...(phases.length > 0
      ? { phases: phases.map((p) => ({ title: p.title.trim(), description: p.description.trim() })) }
      : {}),
    items: items.map((draft) => {
      const { _key: omitted, ...it } = draft;
      void omitted;
      return { ...it, title: it.title?.trim() || undefined };
    }),
  };
}
