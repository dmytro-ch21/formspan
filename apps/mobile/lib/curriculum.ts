import { apiRequest } from './apiRequest';
import { localZone } from './history';
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
 * *building* on web — picking a dozen techniques out of 542 and setting four
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
  /** Distinct sessions this must be DRILLED in — the criterion for the
   *  movement fundamentals nobody scores with (a breakfall, a shrimp).
   *  Sessions rather than reps: forty in one class is one class. The ONE
   *  criterion practice counts toward; every other threshold excludes it. */
  target_drilled_sessions: number | null;
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
  /** Distinct sessions in which this was drilled — sent even where no
   *  criterion reads it, which is what finally lets `hasEvidence` see
   *  drilled-only training. */
  drilled_sessions: number;
  mastered: boolean;
};

/** One named section — "Survive the bad places first" — with the phase's
 *  objective in the description. Items point at one via their `phase` index.
 *  Purely structure: no criteria and no progress of its own. */
export type CurriculumPhase = {
  order: number;
  title: string;
  description: string;
};

export type CurriculumItem = {
  /** A `technique` points into the library and may carry criteria; a
   *  `concept` is authored text — "position before submission", a graduation
   *  standard — and NEVER does: no evidence stream could measure one, and
   *  nothing in this feature is completable by hand. */
  kind: 'technique' | 'concept';
  /** Absent on concept items, which point at nothing. */
  technique_id?: string;
  /** The concept's own heading; absent on technique items, whose name is the
   *  library's. */
  title?: string;
  name: string;
  position: string;
  category: string;
  order: number;
  /** Index into the curriculum's `phases`, or null for an unphased item —
   *  every curriculum predating phases is entirely unphased, legally. */
  phase: number | null;
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
  /**
   * VOLA authored this — `owner_user_id IS NULL`, resolved server-side.
   *
   * Named `official` rather than `vola` (which is what F7 proposed) because
   * `vola` is the colour palette imported by nearly every component here, and
   * the schema already calls this concept official — see
   * `curricula_official_is_public` and its twin on workouts.
   *
   * See the server's field comment — `editable` is
   * permission and this is authorship, and the two agree on every row VOLA
   * wrote, which is what made confusing them survive review.
   *
   * Both strips test it as a TRUTHY filter rather than normalising it, and
   * that is the whole safety argument: an older server omitting the field
   * yields `undefined`, the filter drops the row, and the strip renders empty.
   * Empty is the safe failure here — the unsafe one is a strip full of
   * strangers' curricula wearing belt words. Do not "fix" this by defaulting
   * it to `true`.
   */
  official: boolean;
  name: string;
  description: string;
  /** A hint for ordering, never a gate — working white-belt fundamentals at
   *  purple is not a mistake. */
  belt: string | null;
  /** Which browse section this belongs to — "belt", "foundations". Same
   *  contract as `belt`: a grouping hint, never a gate, null for an athlete's
   *  own list. */
  track: string | null;
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
  /** Present on a single read, absent from the list — same lazy contract as
   *  `items`. Empty for a flat curriculum. */
  phases?: CurriculumPhase[];
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

/**
 * `tz` on every call that touches a date, and it is not optional in practice.
 *
 * Progress is measured from the enrollment date, and both ends of that
 * comparison used to be resolved in the SERVER's zone — which is UTC in every
 * deployed environment. Enrolling at 22:00 in New York stamped TOMORROW, so the
 * screen said progress was counted from a date that had not happened and the
 * evening's training fell outside the window. Sending the zone is what makes
 * "since you started" mean the athlete's day rather than the database's.
 */
/**
 * The roadmaps you are actively on, with progress — what Today and You read.
 *
 * A separate endpoint rather than filtering the list, because the two are
 * bounded by different things: the list spans every public curriculum, this is
 * bounded by how many syllabuses one athlete has taken on. It also carries real
 * `mastered_items`, which the list deliberately does not.
 */
export function listWorkingCurricula(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Curriculum[]> {
  return apiRequest<{ curricula?: Curriculum[] }>(
    getToken,
    `/curricula/working?tz=${encodeURIComponent(localZone())}`,
    { signal },
  ).then((r) => r.curricula ?? []);
}

/**
 * The next thing to work on a roadmap: the first unmastered step, in order.
 *
 * Order is the content of a syllabus, so "next" means next in the author's
 * sequence rather than closest to done — someone put the retention before the
 * sweep on purpose. Returns null when everything is mastered, or when the
 * curriculum is a reading list.
 */
export function nextStep(c: Curriculum): CurriculumItem | null {
  return (c.items ?? []).find((i) => i.criteria !== null && !(i.progress?.mastered ?? false)) ?? null;
}

export function getCurriculum(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<Curriculum> {
  return apiRequest<Curriculum>(
    getToken,
    `/curricula/${encodeURIComponent(id)}?tz=${encodeURIComponent(localZone())}`,
    { signal },
  );
}

/** Idempotent, and it un-archives. `started_on` is NOT reset — it is when you
 *  first took it on, and every criterion is measured from it. */
export function enrollInCurriculum(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(
    getToken,
    `/curricula/${encodeURIComponent(id)}/enrollment?tz=${encodeURIComponent(localZone())}`,
    { method: 'PUT' },
  );
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
