import { randomUUID } from 'expo-crypto';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

import { ApiError } from './apiError';
import type { Exercise } from './exercises';
import { newTraceId, traceparent } from './trace';
import { formatDistance, formatWeight, type UnitSystem } from './units';
import type { WorkoutItem } from './workouts';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type SetType = 'warmup' | 'working' | 'backoff' | 'drop' | 'amrap' | 'failure';

export const SET_TYPES: { key: SetType; label: string; short: string }[] = [
  { key: 'warmup', label: 'Warm-up', short: 'W' },
  { key: 'working', label: 'Working', short: '' },
  { key: 'backoff', label: 'Back-off', short: 'B' },
  { key: 'drop', label: 'Drop', short: 'D' },
  { key: 'amrap', label: 'AMRAP', short: 'A' },
  { key: 'failure', label: 'To failure', short: 'F' },
];

export type LoggedSet = {
  exercise_id: string;
  position: number;
  set_type: SetType;
  reps: number | null;
  weight_kg: number | null;
  seconds: number | null;
  distance_m: number | null;
  /** Reps in reserve. 0 is meaningful — nothing left in the tank. */
  rir: number | null;
  /** 1–10, half steps. RPE 8 is roughly 2 RIR; record whichever you think in. */
  rpe: number | null;
  notes: string;
  /**
   * Done. The trigger for progressive volume — the summary counts what's
   * been performed, not what's been planned, so the header climbs as you
   * work rather than starting at the plan's total.
   */
  completed: boolean;
};

export type Session = {
  id: string;
  user_id: string;
  workout_id: string | null;
  sport: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  notes: string;
  sets: LoggedSet[];
  created_at: string;
  updated_at: string;
};


/**
 * The outcomes of the progression rule.
 *
 * The first four are the double-progression cycle proper; the rest are the
 * cases where the rule declines to advance and says why. Branch on these —
 * never pattern-match `reason`, which is prose and may change.
 *
 * Kept identical to apps/web's copy on purpose: the rule itself lives only on
 * the server, and these are the names it emits.
 */
export type SuggestionCode =
  /** Same load, one more rep — the first half of double progression. */
  | 'add_reps'
  /** Top of the rep range hit on every set: load moves, reps reset. */
  | 'add_load'
  /** Stalled three sessions at one load: back off ~10% and re-approach. */
  | 'deload'
  /** The range isn't finished at this load yet. Repeat it. */
  | 'hold'
  | 'no_history'
  | 'not_applicable'
  | 'repeat_hard'
  | 'repeat_unknown_effort'
  | 'repeat_stale';

/** The rep window a lift progresses inside before load moves. */
export type RepRange = { low: number; high: number };

/**
 * What to load today and for how many reps, derived from what you actually
 * did last time.
 *
 * The evidence travels with the recommendation on purpose — `last_*` is
 * always populated when there is history, even when the answer is "repeat
 * it". A number you can check beats a number you have to trust, and it is
 * the difference between a recommendation and an oracle.
 *
 * `last_weight_kg`, `last_reps`, `last_rir` and `last_rpe` all describe the
 * same single top set and are only meaningful together. `last_min_reps` /
 * `last_max_reps` are the spread across every working set.
 */
export type Suggestion = {
  exercise_id: string;
  code: SuggestionCode;
  reason: string;

  /** The prescription. Null when the exercise isn't loaded in weight. */
  target_weight_kg: number | null;
  target_reps: number | null;
  rep_range: RepRange;

  last_performed_at: string | null;
  last_weight_kg: number | null;
  last_reps: number | null;
  last_rir: number | null;
  last_rpe: number | null;
  last_min_reps: number | null;
  last_max_reps: number | null;
  working_sets: number;
  /** Consecutive recent sessions at this same load — the stall signal. */
  sessions_at_load: number;
  /** Every working set finished at or above the target reserve. */
  hit_target_effort: boolean;

  /** What the last top set implies you could lift once, effort included. */
  estimated_1rm_kg: number | null;
  /** The highest estimate anywhere in your history for this exercise. */
  best_1rm_kg: number | null;
};

export type Volume = {
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  hardest_rpe: number;
  exercise_ids: string[];
};

/**
 * Which measures a set of this exercise records. Same rule as the workout
 * template — driven by the catalog's `load_type`, so the logging form never
 * needs to know about specific exercises.
 */
export type Measure = 'reps' | 'weight' | 'seconds' | 'distance';

export function measuresFor(loadType: Exercise['load_type']): Measure[] {
  switch (loadType) {
    case 'weight_reps':
      return ['reps', 'weight'];
    case 'reps':
      return ['reps'];
    case 'time':
      return ['seconds'];
    case 'distance':
      return ['distance'];
    case 'distance_time':
      return ['distance', 'seconds'];
  }
}

export function emptySet(exerciseID: string, position: number, from?: LoggedSet): LoggedSet {
  // Carrying the previous set's numbers forward is the single biggest
  // reduction in taps: sets in a session are usually the same weight and
  // reps, so the common case becomes "confirm", not "type".
  return {
    exercise_id: exerciseID,
    position,
    set_type: from?.set_type ?? 'working',
    reps: from?.reps ?? null,
    weight_kg: from?.weight_kg ?? null,
    seconds: from?.seconds ?? null,
    distance_m: from?.distance_m ?? null,
    // Effort is per-set and never carried: the third set at the same weight
    // is not the same effort as the first, and prefilling it would invite
    // recording a number nobody actually judged.
    rir: null,
    rpe: null,
    notes: '',
    completed: false,
  };
}

/**
 * Turns a template into the sets to start from: one row per prescribed set,
 * pre-filled with the prescribed numbers.
 *
 * Pre-filling is the point. Starting a planned session from an empty list
 * means retyping the plan you already wrote, and the gap between prescribed
 * and actual — the whole reason sessions and workouts are separate — only
 * exists if the prescription is what you start from and then change.
 */
export function setsFromWorkout(items: WorkoutItem[]): LoggedSet[] {
  const out: LoggedSet[] = [];
  for (const item of items) {
    // A template with no set count still means "do this exercise" — one row.
    const count = Math.min(Math.max(item.target_sets ?? 1, 1), 20);
    for (let i = 0; i < count; i++) {
      out.push({
        exercise_id: item.exercise_id,
        position: out.length,
        set_type: 'working',
        reps: item.target_reps,
        weight_kg: item.target_weight_kg,
        seconds: item.target_seconds,
        distance_m: item.target_distance_m,
        rir: null,
        rpe: null,
        notes: '',
        completed: false,
      });
    }
  }
  return out;
}

/**
 * Swaps every set of one exercise for another, in place.
 *
 * The measures carry over only when the two exercises are measured the same
 * way — swapping a barbell squat for a goblet squat keeps your reps, but
 * swapping a plank for a run cannot keep anything, and inventing a number
 * there would be worse than an empty field. Effort is always cleared: the
 * replacement is a different movement, so a judgement about the old one
 * doesn't transfer.
 */
export function swapExercise(
  sets: LoggedSet[],
  fromID: string,
  to: Exercise,
  fromLoadType: Exercise['load_type'] | undefined,
): LoggedSet[] {
  const sameShape = fromLoadType === to.load_type;
  return sets.map((s) =>
    s.exercise_id !== fromID
      ? s
      : {
          ...s,
          exercise_id: to.id,
          reps: sameShape ? s.reps : null,
          weight_kg: sameShape ? s.weight_kg : null,
          seconds: sameShape ? s.seconds : null,
          distance_m: sameShape ? s.distance_m : null,
          rir: null,
          rpe: null,
          completed: false,
        },
  );
}

/**
 * Ranks candidates by how well they stand in for `base`.
 *
 * Deterministic and explainable by design — the same rule the whole product
 * is built on. Same movement pattern *and* the same load type is a genuine
 * substitute (you can slot it into the same set and the numbers still mean
 * something); matching only one of the two is a weaker suggestion; anything
 * else isn't a recommendation at all and is left to the full search.
 */
export function similarTo(base: Exercise, all: Exercise[]): Exercise[] {
  const score = (e: Exercise): number => {
    if (e.id === base.id) return -1;
    const pattern = e.movement_pattern === base.movement_pattern;
    const shape = e.load_type === base.load_type;
    if (pattern && shape) return 3;
    if (pattern) return 2;
    // A shared load type alone says nothing useful — every barbell lift is
    // weight_reps — so it only counts alongside shared equipment.
    if (shape && e.equipment.some((q) => base.equipment.includes(q))) return 1;
    return 0;
  };
  return all
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, 8)
    .map((x) => x.e);
}

export function describeSet(s: LoggedSet, units: UnitSystem = 'metric'): string {
  const parts: string[] = [];
  const w = formatWeight(s.weight_kg, units);
  if (s.reps != null && s.weight_kg != null) parts.push(`${s.reps} × ${w}`);
  else if (s.reps != null) parts.push(`${s.reps} reps`);
  else if (s.weight_kg != null) parts.push(w);
  if (s.seconds != null) parts.push(`${s.seconds}s`);
  if (s.distance_m != null) parts.push(formatDistance(s.distance_m, units));
  if (s.rpe != null) parts.push(`RPE ${s.rpe}`);
  else if (s.rir != null) parts.push(`${s.rir} RIR`);
  return parts.join(' · ') || 'Not recorded';
}

async function request<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  const res = await netFetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
    );
  }
  return body as T;
}

/**
 * `goal` picks the rep range the rule progresses inside — the same squat is a
 * 3-rep lift in a strength block and a 10-rep lift in a hypertrophy one. Pass
 * the goal of the workout being performed; omitting it falls back to a general
 * 5-8 range rather than failing.
 */
export async function fetchSuggestions(
  getToken: TokenGetter,
  exerciseIDs: string[],
  goal?: string | null,
  signal?: AbortSignal,
): Promise<Map<string, Suggestion>> {
  const unique = [...new Set(exerciseIDs)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const q = new URLSearchParams({ exercise_ids: unique.join(',') });
  if (goal) q.set('goal', goal);
  const b = await request<{ suggestions: Suggestion[] }>(
    getToken,
    `/sessions/suggestions?${q}`,
    {},
    signal,
  );
  return new Map((b.suggestions ?? []).map((s) => [s.exercise_id, s]));
}

/**
 * Fills in the weight and reps for sets that don't already carry them.
 *
 * A template's own prescription always wins — it's an instruction, not a
 * guess. Where it's silent, the recommendation goes in, so a planned session
 * opens at numbers that mean something rather than empty boxes.
 *
 * Reps are filled now where they deliberately weren't before. The old rule
 * only ever moved load, so inventing reps would have overwritten the
 * programme; under double progression the rep target *is* half the
 * recommendation, and leaving it blank drops the half that moves most often.
 */
export function applySuggestions(
  sets: LoggedSet[],
  suggestions: Map<string, Suggestion>,
): LoggedSet[] {
  return sets.map((s) => {
    const hit = suggestions.get(s.exercise_id);
    if (!hit) return s;
    let next = s;
    if (next.weight_kg == null && hit.target_weight_kg != null) {
      next = { ...next, weight_kg: hit.target_weight_kg };
    }
    if (next.reps == null && hit.target_reps != null) {
      next = { ...next, reps: hit.target_reps };
    }
    return next;
  });
}

export async function listSessions(
  getToken: TokenGetter,
  opts: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<Session[]> {
  // Every session carries all of its sets, so a screen showing five recent
  // ones must not pull the API's default fifty.
  const qs = opts.limit ? `?limit=${opts.limit}` : '';
  const b = await request<{ sessions: Session[] }>(getToken, `/sessions${qs}`, {}, signal);
  return b.sessions ?? [];
}

export async function getSession(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}`, {}, signal);
}

export async function startSession(
  getToken: TokenGetter,
  input: {
    sport: string;
    name: string;
    workout_id?: string | null;
    sets?: LoggedSet[];
    /** Supplied when pushing a session that was started offline. */
    id?: string;
    started_at?: string;
  },
): Promise<{ session: Session; volume: Volume }> {
  // Client-generated ID, so starting a session is idempotent on retry — the
  // same contract offline activity logging relies on, and what lets the
  // offline store push a session it created hours earlier.
  return request(getToken, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id ?? randomUUID(),
      started_at: input.started_at ?? new Date().toISOString(),
      ...input,
    }),
  });
}

export async function replaceSets(
  getToken: TokenGetter,
  id: string,
  sets: LoggedSet[],
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/sets`, {
    method: 'PUT',
    body: JSON.stringify({ sets }),
  });
}

export async function finishSession(
  getToken: TokenGetter,
  id: string,
  /** Supplied when pushing a session finished offline — the real end time,
   *  not the time the sync happened to run. */
  endedAt?: string,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/finish`, {
    method: 'POST',
    body: JSON.stringify({ ended_at: endedAt ?? new Date().toISOString() }),
  });
}

export async function deleteSession(
  getToken: TokenGetter,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
