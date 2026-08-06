import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * Curricula and roadmaps — client half of `/v1/curricula`. (Paths below omit
 * the prefix: `apiRequest` already carries `/v1`.)
 *
 * A curriculum is an ordered set of techniques; one whose items carry
 * completion criteria is a ROADMAP. The distinction is per ITEM, so the same
 * curriculum can be part reading list and part roadmap.
 *
 * **What this app does and does not get.** The design doc puts roadmap
 * *building* on web — picking a dozen techniques out of 466 and setting four
 * numeric criteria each is a desk job — and everything else here: pick one,
 * see progress, put its techniques into focus. That last one is why this file
 * exists at all. The loop is roadmap → `bjj_focus` → one-tap chips in the
 * reflection wizard → tagged events → criteria, and three of those four steps
 * were already on the phone. Only "choose the focus" was web-only, so an
 * athlete who trains and logs entirely on their phone had to open a laptop to
 * advance their own roadmap.
 *
 * `apps/web` has its own copy of these types, for the same reason
 * `lib/proficiency.ts` says: the two apps cannot import from each other and
 * there is no `packages/` yet. This is the third such duplication.
 */

/** What mastering one technique takes. Every threshold is measured SINCE the
 *  athlete enrolled, never over all time. */
export type Criteria = {
  /** Times landed live. Null on a defence-only criterion — "do not get caught
   *  in X" has no offensive half, and six of the brown syllabus's fourteen
   *  items are exactly that. */
  target_scored: number | null;
  /** Times you stopped theirs. About a third of `target_scored`: you choose
   *  when to attack, not when you are attacked. */
  target_defended: number | null;
  /** Distinct LIVE sessions. Drilling never counts toward it. */
  target_sessions: number | null;
  /** scored / (attempted + scored) — the reason the word "mastered" is
   *  defensible, since volume alone is satisfied by 25-from-30 and 25-from-400
   *  alike. Computable only because `attempted` and `scored` are DISJOINT; see
   *  `lib/proficiency.ts`, which makes the same point. */
  min_hit_rate: number | null;
};

export type Progress = {
  scored: number;
  defended: number;
  sessions: number;
  /** scored + attempted — how often they went for it. */
  attempts: number;
  /** Null when `attempts` is 0. Zero from zero is not a rate, and showing 0%
   *  reports a failure the athlete has not had. */
  hit_rate: number | null;
  mastered: boolean;
};

export type CurriculumItem = {
  technique_id: string;
  name: string;
  position: string;
  category: string;
  order: number;
  notes: string;
  /** Null means reading rather than a roadmap step. */
  criteria: Criteria | null;
  /** Null when not enrolled, or when the item has no criteria. */
  progress: Progress | null;
};

export type Curriculum = {
  id: string;
  /** Resolved server-side. Never decide this by comparing user ids. */
  editable: boolean;
  name: string;
  description: string;
  /** A hint for ordering, never a gate — working white-belt fundamentals at
   *  purple is not a mistake. */
  belt: string | null;
  visibility: 'private' | 'public';
  enrolled: boolean;
  /** "YYYY-MM-DD", null unless enrolled, and the anchor every criterion is
   *  measured from. */
  started_on: string | null;
  item_count: number;
  /** How many items carry criteria — i.e. whether this is a roadmap at all.
   *  THE PROGRESS RULE: progress counts only these, so dividing by
   *  `item_count` is the silent wrong answer. Present on list and single read. */
  countable_items: number;
  /** **Zero on the list response.** It needs the per-curriculum evidence
   *  aggregate, which the API deliberately does not run once per row — a list
   *  card drawing a bar from it renders a placeholder as fact, which shipped
   *  once on web already. Only meaningful on a single read. */
  mastered_items: number;
  items?: CurriculumItem[];
};

/**
 * Network-only, like the funnel and for the same reason: progress aggregates
 * every session ever logged, including ones synced from another device, so a
 * local answer would be a quietly smaller number.
 */
export function listCurricula(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Curriculum[]> {
  return apiRequest<{ curricula?: Curriculum[] }>(getToken, '/curricula', { signal }).then(
    // `?? []` rather than trusting the shape: this endpoint returns an object
    // with a `curricula` key, and reading it as a bare array is the exact
    // mistake that crashed Today on first render once.
    (r) => r.curricula ?? [],
  );
}

export function getCurriculum(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<Curriculum> {
  return apiRequest<Curriculum>(getToken, `/curricula/${encodeURIComponent(id)}`, { signal });
}

/** Idempotent, and it un-archives. `started_on` is NOT reset — it is when you
 *  first took it on, and every criterion is measured from it. */
export function enrollInCurriculum(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/curricula/${encodeURIComponent(id)}/enrollment`, {
    method: 'PUT',
  });
}

/** Archives rather than deletes: having worked a syllabus and stopped is a fact
 *  about the athlete. It does NOT mean completed. */
export function archiveCurriculumEnrollment(
  getToken: TokenGetter,
  id: string,
): Promise<void> {
  return apiRequest<void>(getToken, `/curricula/${encodeURIComponent(id)}/enrollment`, {
    method: 'DELETE',
  });
}
