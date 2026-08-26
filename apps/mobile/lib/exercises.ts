import { apiRequest } from './apiRequest';
import type { NetFetchOptions } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

/**
 * The global exercise catalog. Unlike activities this is read-only reference
 * content, identical for every user — so there's no local outbox and nothing
 * user-scoped here.
 */

export type MediaKind = 'thumbnail' | 'demo' | 'start' | 'end' | 'demo_video';

export type Media = {
  kind: MediaKind;
  storage_key: string;
  /** Empty when the API has no media origin configured — treat as "no image". */
  url: string;
  content_type: string;
  width: number | null;
  height: number | null;
  position: number;
};

export type Exercise = {
  id: string;
  name: string;
  sport: string;
  movement_pattern: string;
  /**
   * Which grips to offer, decided by the SERVER (N16).
   *
   * Optional because a row cached before this field existed parses without it —
   * `exercise_cache` stores the whole API object as `payload_json`, so the field
   * arrives automatically on the next catalog fetch and no SQLite migration was
   * needed, but the rows already on disk predate it.
   *
   * **`undefined` and `[]` are different answers.** `[]` is the server saying
   * grip is meaningless here (a squat) and the picker should not appear;
   * `undefined` is "this row is older than the field", where `offeredGrips`
   * falls back to the local table rather than hiding a control that used to
   * work. Collapsing the two would silently remove the grip picker offline.
   */
  offered_grips?: string[];
  primary_muscles: string[];
  secondary_muscles: string[];
  equipment: string[];
  /** Drives which inputs a logging screen renders — see the backend module. */
  load_type: 'weight_reps' | 'reps' | 'time' | 'distance' | 'distance_time';
  /**
   * Which number goes in the weight field. `per_side` means ONE implement —
   * one dumbbell, one kettlebell, one farmer handle — because that is what is
   * stamped on it and what an athlete reads off it.
   *
   * Drives the INPUT hint and nothing else. What the weight is multiplied by
   * is the exercise's `implements`, which the server applies before any client
   * sees a number — see the set's `load_factor`.
   *
   * Optional because a session cached by an app older than this field has no
   * `load_mode` in its stored exercise payload; absent reads as "say nothing"
   * rather than as `total`.
   */
  load_mode?: 'total' | 'per_side';
  is_unilateral: boolean;
  instructions: string;
  /**
   * Why this exercise's values are what they are — admin-authored, and shown
   * on the exercise screen only when it is there.
   *
   * OPTIONAL, and absent is the normal case: the server omits the key entirely
   * when empty, and a session cached by an app older than this field has none
   * either. Both mean the same thing — say nothing — so unlike `load_mode`
   * there is no absent-versus-known distinction to preserve, and a falsy check
   * is the whole handling.
   *
   * Not `instructions`, which is how to PERFORM the movement. This is how it is
   * RECORDED and why: `single-leg-kettlebell-romanian-deadlift` counts one
   * implement while the dumbbell version counts two, deliberately, and without
   * this the difference reads as a bug.
   */
  note?: string;
  media: Media[];
};

export type ExerciseFilter = { sport?: string; q?: string };

/**
 * Picks the best available image for a given use.
 *
 * Falls back deliberately rather than returning nothing: a thumbnail scaled
 * up beats an empty box, and an exercise with only a `demo` still should
 * appear in a list. Returns null only when there's genuinely no image, so a
 * caller can render a real placeholder instead of a broken one.
 */
export function pickImage(e: Exercise, prefer: MediaKind): string | null {
  const order: MediaKind[] =
    prefer === 'thumbnail'
      ? ['thumbnail', 'demo', 'start']
      : ['demo', 'start', 'thumbnail'];
  for (const kind of order) {
    const hit = e.media.find((m) => m.kind === kind && m.url);
    if (hit) return hit.url;
  }
  return null;
}

/**
 * One catalog exercise, BY ID.
 *
 * ## Why this exists rather than reusing the search
 *
 * The identify screen resolved a picked candidate by putting the exercise
 * **id** into the **name** search — `fetchExercises({ q: exerciseID })`, then
 * `.find(e => e.id === exerciseID)`. That worked only because ids happen to be
 * slugs of names, which is a coincidence the catalog does not promise and the
 * write path actively breaks: renaming an exercise deliberately keeps its id
 * (`TestRenamingKeepsTheID`, landed 2026-08-04 in #113).
 *
 * The first name that diverges from its slug — "Seated Cable Row" becoming
 * "Cable Row Machine" — makes every token of `seated-cable-row` have to appear
 * in the new name, which they do not, so the search returns nothing and the
 * athlete is told **"That exercise is no longer in the catalog"** about an
 * exercise the server returned two seconds earlier. A confident wrong answer,
 * which is the exact class the shortlist exists to prevent. Found in review of
 * N44 (#325), fixed under N47.
 *
 * It is also strictly cheaper: one row instead of a ranked list with media.
 *
 * ## It throws `ApiError`, and that is the point
 *
 * Going through `apiRequest` keeps the status and the contract's error CODE,
 * so a 404 can say the exercise is gone and a dead network can say something
 * true instead — the same distinction N41's barcode lookup turns on.
 * `fetchExercises` below now goes through the same helper for the same
 * reason (N62) — this file used to be the one place still hand-rolling a
 * bare `Error`.
 */
export function fetchExercise(getToken: TokenGetter, id: string): Promise<Exercise> {
  return apiRequest<Exercise>(getToken, `/exercises/${encodeURIComponent(id)}`);
}

/**
 * The catalog listing, filtered by sport and/or a name search.
 *
 * Went through `netFetch` directly and hand-rolled a bare `Error` on a
 * non-2xx response until N62. That lost the server's error CODE (so a 404
 * and a validation error were indistinguishable to a caller) and put a
 * second copy of `apiRequest`'s dozen lines here to drift from — see
 * `fetchExercise`'s doc comment above for the fuller argument. Every caller
 * already catches this with a bare `catch` (offline falls back to the
 * cache), so the error's *identity* changing from `Error` to `ApiError` is
 * safe: nothing here pattern-matches on `.message`.
 */
export async function fetchExercises(
  getToken: TokenGetter,
  filter: ExerciseFilter = {},
  signal?: AbortSignal,
  opts?: NetFetchOptions,
): Promise<Exercise[]> {
  const params = new URLSearchParams();
  if (filter.sport) params.set('sport', filter.sport);
  if (filter.q) params.set('q', filter.q);
  const qs = params.toString();

  const body = await apiRequest<{ exercises: Exercise[] }>(
    getToken,
    `/exercises${qs ? `?${qs}` : ''}`,
    { signal },
    opts,
  );
  return body.exercises ?? [];
}
