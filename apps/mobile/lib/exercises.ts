import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

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

export async function fetchExercises(
  getToken: TokenGetter,
  filter: ExerciseFilter = {},
  signal?: AbortSignal,
): Promise<Exercise[]> {
  const token = await getToken();

  const params = new URLSearchParams();
  if (filter.sport) params.set('sport', filter.sport);
  if (filter.q) params.set('q', filter.q);
  const qs = params.toString();

  const res = await netFetch(`${API_BASE}/exercises${qs ? `?${qs}` : ''}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      traceparent: traceparent(newTraceId()),
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Couldn't load exercises (${res.status}).`);
  }
  const body = (await res.json()) as { exercises: Exercise[] };
  return body.exercises ?? [];
}
