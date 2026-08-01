import { randomUUID } from 'expo-crypto';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

import type { Exercise } from './exercises';
import { formatWeight, type UnitSystem } from './units';
import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type Sport = 'strength' | 'running' | 'bjj';
export type Goal = 'general' | 'powerlifting' | 'hypertrophy' | 'endurance';
export type Visibility = 'private' | 'public';

export type WorkoutItem = {
  exercise_id: string;
  position: number;
  target_sets: number | null;
  target_reps: number | null;
  target_weight_kg: number | null;
  target_seconds: number | null;
  target_distance_m: number | null;
  notes: string;
};

export type Workout = {
  id: string;
  /** null for a VOLA-authored official template. */
  owner_user_id: string | null;
  name: string;
  sport: Sport;
  goal: Goal | null;
  notes: string;
  visibility: Visibility;
  items: WorkoutItem[];
  created_at: string;
  updated_at: string;
};

// The LIST of sports is gone from here: it lives in the server's registry and
// reaches the app through lib/modules. What stays is the `Sport` type above,
// which types the wire format — three copies of the list existed in this app
// and all three disagreed.

// Only meaningful for strength — powerlifting, hypertrophy and endurance are
// all things you do with the same barbell squat, so they're a property of
// the workout rather than of the exercise.
export const GOALS: { key: Goal; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'powerlifting', label: 'Powerlifting' },
  { key: 'hypertrophy', label: 'Hypertrophy' },
  { key: 'endurance', label: 'Endurance' },
];

/**
 * Which target fields an item should show, decided by the exercise's own
 * load_type rather than by branching on sport or name. This is the payoff of
 * carrying load_type in the catalog: the form is data-driven, so adding an
 * exercise never means touching this file.
 */
export type TargetField = 'sets' | 'reps' | 'weight' | 'seconds' | 'distance';

export function targetFieldsFor(loadType: Exercise['load_type']): TargetField[] {
  switch (loadType) {
    case 'weight_reps':
      return ['sets', 'reps', 'weight'];
    case 'reps':
      return ['sets', 'reps'];
    case 'time':
      return ['sets', 'seconds'];
    case 'distance':
      return ['sets', 'distance'];
    case 'distance_time':
      return ['distance', 'seconds'];
  }
}

/** A one-line human summary of an item's targets, e.g. "3 × 5 · 100kg". */
export function summariseTargets(item: WorkoutItem, units: UnitSystem = 'metric'): string {
  const parts: string[] = [];
  if (item.target_sets && item.target_reps) parts.push(`${item.target_sets} × ${item.target_reps}`);
  else if (item.target_sets) parts.push(`${item.target_sets} sets`);
  else if (item.target_reps) parts.push(`${item.target_reps} reps`);
  if (item.target_weight_kg) parts.push(formatWeight(item.target_weight_kg, units));
  if (item.target_seconds) {
    const m = Math.floor(item.target_seconds / 60);
    const s = item.target_seconds % 60;
    parts.push(m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`);
  }
  if (item.target_distance_m) {
    parts.push(
      item.target_distance_m >= 1000
        ? `${(item.target_distance_m / 1000).toFixed(1)}km`
        : `${item.target_distance_m}m`,
    );
  }
  return parts.join(' · ') || 'No targets set';
}

export function emptyItem(exerciseID: string, position: number): WorkoutItem {
  return {
    exercise_id: exerciseID,
    position,
    target_sets: null,
    target_reps: null,
    target_weight_kg: null,
    target_seconds: null,
    target_distance_m: null,
    notes: '',
  };
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
    // The API's error envelope carries a human-usable message for the cases
    // a user can act on (a sport mismatch names the offending exercise), so
    // prefer it over a bare status code.
    const message = body?.error?.message;
    throw new Error(message || `Request failed (${res.status}).`);
  }
  return body as T;
}

export async function listWorkouts(
  getToken: TokenGetter,
  scope: 'mine' | 'shared',
  signal?: AbortSignal,
): Promise<Workout[]> {
  const body = await request<{ workouts: Workout[] }>(
    getToken,
    `/workouts?scope=${scope}`,
    {},
    signal,
  );
  return body.workouts ?? [];
}

export async function getWorkout(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<Workout> {
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}`, {}, signal);
}

export async function createWorkout(
  getToken: TokenGetter,
  input: {
    name: string;
    sport: Sport;
    goal: Goal | null;
    visibility: Visibility;
    /**
     * The id to create it under.
     *
     * Optional, and supplying it is what makes offline creation work: a
     * workout created with no signal already exists locally under an id, and
     * any session started from it references THAT id. Minting a fresh one at
     * push time would create a second workout server-side and leave the
     * session pointing at one that never arrives.
     */
    id?: string;
  },
): Promise<Workout> {
  const { id, ...rest } = input;
  // Client-generated ID, so creating a workout is idempotent on retry — the
  // same contract as offline activity logging. The server does
  // ON CONFLICT (id) DO NOTHING, so re-pushing after a lost response is a
  // no-op rather than a duplicate plan.
  return request<Workout>(getToken, '/workouts', {
    method: 'POST',
    body: JSON.stringify({ id: id ?? randomUUID(), ...rest, notes: '' }),
  });
}

export async function replaceItems(
  getToken: TokenGetter,
  id: string,
  items: WorkoutItem[],
): Promise<Workout> {
  // Positions are reassigned server-side from array order, so the client
  // only has to send the list in the order it wants.
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}/items`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

export async function deleteWorkout(
  getToken: TokenGetter,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
