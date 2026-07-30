import { randomUUID } from 'expo-crypto';

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

export const SPORTS: { key: Sport; label: string }[] = [
  { key: 'strength', label: 'Strength' },
  { key: 'bjj', label: 'BJJ' },
  { key: 'running', label: 'Running' },
];

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
  getToken: () => Promise<string | null>,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');

  const res = await fetch(`${API_BASE}${path}`, {
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
  getToken: () => Promise<string | null>,
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
  getToken: () => Promise<string | null>,
  id: string,
  signal?: AbortSignal,
): Promise<Workout> {
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}`, {}, signal);
}

export async function createWorkout(
  getToken: () => Promise<string | null>,
  input: { name: string; sport: Sport; goal: Goal | null; visibility: Visibility },
): Promise<Workout> {
  // Client-generated ID, so creating a workout is idempotent on retry — the
  // same contract as offline activity logging.
  return request<Workout>(getToken, '/workouts', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), ...input, notes: '' }),
  });
}

export async function replaceItems(
  getToken: () => Promise<string | null>,
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
  getToken: () => Promise<string | null>,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
