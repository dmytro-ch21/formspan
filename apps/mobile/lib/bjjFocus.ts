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
 * technique means searching a 542-entry library; across the whole catalog that
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
  /**
   * Which curricula currently claim this row. Empty — never absent — for a
   * hand-picked or pre-provenance entry.
   *
   * **This is what N100 fixes.** `roadmapFocus.ts`'s `unchanged` used to be
   * computed from the technique list alone, which cannot tell "a second
   * roadmap wants exactly what's already in focus, so applying it would
   * register a new claim" apart from "applying it would change nothing at
   * all" — those look identical on the list, and only this field tells them
   * apart.
   */
  curriculum_ids: string[];
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

/**
 * The cap, mirrored from the backend's own `maxFocus`.
 *
 * The bound IS the feature: a focus list of twenty is the library again, and
 * the wizard would be back to searching 542 entries. Duplicated rather than
 * fetched because it is a product decision, not data — but if the server's
 * value ever moves, this is the second place to change.
 */
export const MAX_FOCUS = 5;

/**
 * Replace the focus list.
 *
 * **REPLACES WHOLESALE**, matching the endpoint. That is the fact every caller
 * has to carry: sending a shorter list deletes the difference, silently, and a
 * shorter focus list looks exactly like a focus list. `lib/roadmapFocus.ts`
 * exists to compute what to send without destroying anything the athlete chose
 * by hand.
 *
 * This app could only READ focus until now — the write lived on web, which is
 * why advancing a roadmap needed a laptop even though every other step of the
 * loop was already here.
 */
export function setFocus(
  getToken: TokenGetter,
  techniqueIDs: string[],
  /**
   * The roadmap this write is applying, when it is one.
   *
   * Omit it for a hand edit — a reorder, or adding a technique from the focus
   * list — and the new entries are recorded as the athlete's own, which makes
   * them sovereign: no roadmap deactivation can ever remove them.
   *
   * Pass it when applying a roadmap, with `technique_ids` set to
   * `proposal.fromRoadmap` and NOT to `proposal.next`. The two differ by the
   * athlete's own entries, which a roadmap re-sends but does not own — see
   * roadmapFocus.ts rule 3. Sending `next` here would hand the roadmap the
   * right to delete hand-picked techniques when it is switched off.
   */
  roadmap?: { curriculum_id: string; technique_ids: string[] },
): Promise<void> {
  return apiRequest<void>(getToken, '/bjj/focus', {
    method: 'PUT',
    body: JSON.stringify({ technique_ids: techniqueIDs, roadmap }),
  });
}

/** A technique row in the live step: what to record against, and its label. */
export type FocusRow = TechniqueRef & { name: string };

/**
 * The technique rows the live step shows: the focus list, plus every technique
 * this session names — drilled today, or already carrying live evidence.
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
export function focusRows(
  focus: Focus[],
  tags: Tag[],
  /**
   * Library id -> display name, for rows that come from a TAG rather than a
   * focus entry. A tag carries only an id, and since drilled techniques now
   * produce rows (below) the common case is a technique the athlete picked by
   * name one screen earlier — showing them `armbar-closed-guard` back would
   * read as a different thing entirely.
   *
   * Optional, and the fallback is still the id: the caller's lookup is the
   * technique library, which is unavailable on a cold launch with no signal —
   * exactly when a gym reflection is being written. A readable slug beats a
   * blank label, which is the trade the tag path already made.
   */
  names?: ReadonlyMap<string, string>,
): FocusRow[] {
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
    // Every LIVE technique-tagged event, not just the offensive two. A
    // technique whose only evidence is `defended` — "I never went for it, I
    // just kept stopping theirs", which is exactly the athlete the defensive
    // criterion is for — got no row at all, so three recorded stops were
    // saved, synced and then invisible and uneditable on reopen. That is the
    // precise property this function's test calls THE property.
    //
    // Reachable without anyone dropping a focus technique: `LiveStep`
    // swallows a `fetchFocus` failure on purpose, so every offline reflection
    // at a gym takes this path.
    // `conceded` only. `drilled` USED to be skipped here too, on the reasoning
    // that a technique with no live outcome had nothing to edit — which was
    // true, and was the whole problem: the wizard asked what you drilled on one
    // screen and then offered no way to say it landed on the next, unless the
    // technique happened to be on the focus list. An athlete with no focus list
    // could not attribute a live outcome at ALL, which quietly made the
    // technique funnel drilled-only and `first_drilled_scored` unreachable
    // (N31).
    //
    // `bumpTechniqueOutcome` was already written for this: its doc says the
    // source is "a drilled tag, or a focus entry", and it inherits category and
    // position from whichever named the technique. The row was the only missing
    // half.
    //
    // `conceded` stays out. It is the category grid's "Them" column and carries
    // no technique; the per-technique defensive event is `defended`, which the
    // grid does offer. A conceded row here would draw counters that no tap
    // could ever fill.
    if (t.event === 'conceded') continue;
    if (byID.has(t.technique_id)) continue;
    byID.set(t.technique_id, {
      technique_id: t.technique_id,
      category: t.category,
      position: t.position,
      // The caller's lookup when it has one — see `names` above — and the id
      // otherwise, which is a readable slug and beats a blank label.
      name: names?.get(t.technique_id) ?? t.technique_id,
    });
  }
  return [...byID.values()];
}
