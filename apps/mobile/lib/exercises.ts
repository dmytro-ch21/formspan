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
  primary_muscles: string[];
  secondary_muscles: string[];
  equipment: string[];
  /** Drives which inputs a logging screen renders — see the backend module. */
  load_type: 'weight_reps' | 'reps' | 'time' | 'distance' | 'distance_time';
  is_unilateral: boolean;
  instructions: string;
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
