import { apiRequest } from './apiRequest';
import { familyOf, toCategory, type Tag, type TechniqueRef } from './bjjSession';
import type { TokenGetter } from './useAuthToken';

/**
 * The techniques the athlete is deliberately working on.
 *
 * This list exists to REMOVE capture rather than add it. The reflection wizard
 * was recording the same live event twice — tried/landed per technique on the
 * drilled step, scored/conceded per category in the live grid — and the earlier
 * answer was a convention about which one a query should read. Two capture
 * paths for one event means the model is wrong, so the paths are collapsed
 * instead: a focus technique gets a row in the live step, beside the category
 * rows, and that row is the only place it is recorded.
 *
 * It also puts technique-level detail where it earns its cost. Naming a
 * technique means searching a 466-entry library; across the whole catalog that
 * data is mostly noise, across the three-to-five things being developed it is
 * the most valuable evidence there is. Set on web — choosing what to work on
 * for the next few weeks is planning, not logging.
 */
export type Focus = {
  technique_id: string;
  /** From the shared library, so this renders with no second fetch. */
  name: string;
  /** Library format ("Guard - Bottom"), not the tag vocabulary. */
  position: string;
  /** Library format ("Submission"), not the tag vocabulary. */
  category: string;
  /** YYYY-MM-DD. When it joined the list, not when it was last saved. */
  started_on: string;
};

export function fetchFocus(getToken: TokenGetter, signal?: AbortSignal): Promise<Focus[]> {
  // `?? []` at the parse boundary: an older or drifted server omitting the
  // field would otherwise hand `undefined` to focusRows, which throws
  // "focus is not iterable" INSIDE a useMemo — taking down the wizard's render
  // rather than degrading to no focus block. techniques.ts normalises for the
  // same documented reason.
  return apiRequest<{ focus: Focus[] }>(getToken, '/bjj/focus', { signal }).then(
    (r) => r.focus ?? [],
  );
}

/** A technique row in the live step: what to record against, and its label. */
export type FocusRow = TechniqueRef & { name: string };

/**
 * The technique rows the live step shows: the focus list, plus anything this
 * session already has live evidence for.
 *
 * The union is the part that matters. Focus alone would strand rows — drop a
 * technique from the list on web after logging against it, and its `attempted`
 * / `scored` rows stay in the session with no control able to edit them, which
 * is exactly how the old drilled-step counters stranded rows when a chip was
 * removed. Taking the union keeps "what is displayed" and "what is stored" the
 * same set, which is the property that makes this screen honest.
 *
 * Focus entries win on collision: they carry the library's name, where a tag
 * carries only an id.
 */
export function focusRows(focus: Focus[], tags: Tag[]): FocusRow[] {
  const byID = new Map<string, FocusRow>();
  for (const f of focus) {
    // An empty id would draw two dead counters — 0 forever, untappable
    // (bumpTechniqueOutcome bails on a falsy id) and still announced to
    // VoiceOver as buttons. The drilled step guarded this; the guard was
    // deleted along with its counters rather than carried across.
    if (!f.technique_id) continue;
    byID.set(f.technique_id, {
      technique_id: f.technique_id,
      // Library vocabulary -> tag vocabulary, the same translation the drilled
      // step applies. Deriving it here rather than at each call site is what
      // keeps a focus row's tags joinable with a drilled row's for the same
      // technique.
      category: toCategory(f.category),
      position: familyOf(f.position),
      name: f.name,
    });
  }
  for (const t of tags) {
    if (!t.technique_id) continue;
    if (t.event !== 'attempted' && t.event !== 'scored') continue;
    if (byID.has(t.technique_id)) continue;
    byID.set(t.technique_id, {
      technique_id: t.technique_id,
      category: t.category,
      position: t.position,
      // No library lookup available for a technique that is no longer in
      // focus; the id is a readable slug and beats a blank label.
      name: t.technique_id,
    });
  }
  return [...byID.values()];
}
