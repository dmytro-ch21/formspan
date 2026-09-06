import { randomUUID } from 'expo-crypto';
import { ApiError, parseRetryAfterMs } from './apiError';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

import type { Exercise } from './exercises';
import { formatDistance, formatWeight, type UnitSystem } from './units';
import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type Sport = 'strength' | 'running' | 'bjj';
export type Goal = 'general' | 'powerlifting' | 'hypertrophy' | 'endurance';
export type Visibility = 'private' | 'public';

// N494/#864 (phase 2 of #753): per-workout-item progression protocol. See
// `docs/decisions/history.md` and `backend/internal/modules/workout/workout.go`'s
// `ItemProtocol` — this mirrors that type's wire shape field for field.
// Every field optional: an item with no protocol at all (`undefined`) means
// nothing configured here, and the progression engine falls back to the
// workout-wide goal-based range exactly as it always has.
export type ProgressionStrategy =
  | 'double_progression'
  | 'linear'
  | 'top_set_backoff'
  | 'difficulty_progression'
  | 'program_controlled';

export const PROGRESSION_STRATEGIES: { key: ProgressionStrategy; label: string }[] = [
  { key: 'double_progression', label: 'Double progression' },
  { key: 'linear', label: 'Linear' },
  { key: 'top_set_backoff', label: 'Top set + backoff' },
  { key: 'difficulty_progression', label: 'Difficulty progression' },
  { key: 'program_controlled', label: 'Program-controlled' },
];

export type RepCountMode = 'total' | 'per_side';

export type ExerciseProfile =
  | 'primary_compound'
  | 'secondary_compound_lunge'
  | 'isolation_accessory'
  | 'calf_high_rep_accessory'
  | 'bodyweight_difficulty_progression'
  | 'timed_distance';

export type SetRole = 'warmup' | 'working' | 'top_set' | 'backoff' | 'amrap';

export type SetPrescription = {
  role: SetRole;
  load_kg?: number | null;
  rep_range_min?: number | null;
  rep_range_max?: number | null;
  effort_rir_min?: number | null;
  effort_rir_max?: number | null;
  rest_seconds?: number | null;
  optional?: boolean;
};

export type ItemProtocol = {
  progression_strategy?: ProgressionStrategy | null;
  rep_range_min?: number | null;
  rep_range_max?: number | null;
  target_sets?: number | null;
  target_rir?: number | null;
  target_rpe?: number | null;
  rep_count_mode?: RepCountMode | null;
  equipment_increment?: number | null;
  exercise_profile?: ExerciseProfile | null;
  sets?: SetPrescription[];
};

export type WorkoutItem = {
  exercise_id: string;
  position: number;
  target_sets: number | null;
  target_reps: number | null;
  target_weight_kg: number | null;
  target_seconds: number | null;
  target_distance_m: number | null;
  notes: string;
  /**
   * The item's own progression configuration — see `ItemProtocol` above.
   * Omitted (rather than `null`) for the common case of nothing configured,
   * matching the server's own `omitempty`.
   */
  protocol?: ItemProtocol | null;
};

/**
 * True when a protocol carries at least one real field — used to decide
 * whether an item's "Protocol" section should show as configured, and
 * whether it's worth sending `protocol` at all on save (an object with every
 * field empty means the same thing as no protocol, so there is no reason to
 * ask the server to store one).
 */
export function protocolIsConfigured(p: ItemProtocol | null | undefined): boolean {
  if (!p) return false;
  return (
    p.progression_strategy != null ||
    p.rep_range_min != null ||
    p.rep_range_max != null ||
    p.target_sets != null ||
    p.target_rir != null ||
    p.target_rpe != null ||
    p.rep_count_mode != null ||
    p.equipment_increment != null ||
    p.exercise_profile != null ||
    (p.sets != null && p.sets.length > 0)
  );
}

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
    // Both, because these are the movements that are honestly both — "3 × 15
    // burpees" and "3 × 40s burpees" are the same plan written two ways, and
    // until the second one could be written the timer had nothing to run on a
    // conditioning circuit. Mutually exclusive in practice: see `withTarget`.
    case 'reps':
      return ['sets', 'reps', 'seconds'];
    case 'time':
      return ['sets', 'seconds'];
    case 'distance':
      return ['sets', 'distance'];
    case 'distance_time':
      return ['distance', 'seconds'];
  }
}

/** Which `WorkoutItem` field each target writes. */
const TARGET_FIELD: Record<TargetField, keyof WorkoutItem> = {
  sets: 'target_sets',
  reps: 'target_reps',
  weight: 'target_weight_kg',
  seconds: 'target_seconds',
  distance: 'target_distance_m',
};

/**
 * Write one target, keeping a dual-mode item to a single measure.
 *
 * **Reps and duration are mutually exclusive on a `reps` exercise**, and this is
 * where that is enforced rather than in the editor, because it is the same
 * invariant `lib/setMode.ts` derives a set's mode from: a row carrying both 15
 * reps and 40 seconds is a row two readers describe two different ways. A
 * template holding both would hand that ambiguity straight to every session
 * started from it, where the duration wins and the rep target sits in the data
 * meaning nothing.
 *
 * Only `reps` exercises. `distance_time` legitimately carries both — there the
 * pair is a distance and how long it took, not two ways of counting one thing.
 */
export function withTarget(
  item: WorkoutItem,
  field: TargetField,
  value: number | null,
  loadType: Exercise['load_type'] | undefined,
): WorkoutItem {
  const next = { ...item, [TARGET_FIELD[field]]: value };
  if (loadType !== 'reps' || value == null) return next;
  if (field === 'seconds') return { ...next, target_reps: null };
  if (field === 'reps') return { ...next, target_seconds: null };
  return next;
}

/** A one-line human summary of an item's targets, e.g. "3 × 5 · 100kg". */
/**
 * `units` is REQUIRED, deliberately.
 *
 * It defaulted to `'metric'`, which means a call site that forgets it renders
 * kilograms to an imperial athlete AND TYPECHECKS. That is the silent-metric
 * failure this whole change exists to remove — a default here quietly reopens
 * it for every future caller, and no check can see it: the literal `kg` never
 * appears in the source, it comes out of `formatWeight`.
 */
export function summariseTargets(item: WorkoutItem, units: UnitSystem): string {
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
  // `formatDistance` rather than a local km/m split: it already switches unit
  // by magnitude in BOTH systems, so an imperial athlete gets miles and yards
  // instead of the kilometres this hand-rolled version printed regardless of
  // preference — on a function that was already being handed `units`.
  if (item.target_distance_m) parts.push(formatDistance(item.target_distance_m, units));
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
    // An `ApiError`, not a plain `Error` — and that distinction is load
    // bearing, not tidiness. `isNotFound` and `isPermanentRejection` both
    // return false for anything that isn't an `ApiError`, on the reasoning
    // that it never reached the server. So while this module threw plain
    // errors, EVERY classification branch in the workout push path was dead
    // code: a 404 on delete never counted as success (the tombstone would
    // survive forever, failing every run for a plan deleted exactly as
    // intended), and a permanent refusal was classified `transient`, so the
    // orchestrator would grind a doomed request for the life of the install
    // — the precise failure PR2 exists to prevent, revived for the new
    // outbox. `lib/sessions.ts` was migrated to `ApiError` and this module
    // was not; the gap was invisible because a mocked test supplied the
    // contract the real module didn't honour.
    //
    // The API's error envelope carries a human-usable message for the cases
    // a user can act on (a sport mismatch names the offending exercise), so
    // prefer it over a bare status code.
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
      parseRetryAfterMs(res.headers?.get('Retry-After')),
    );
  }
  return body as T;
}

export async function listWorkouts(
  getToken: TokenGetter,
  scope: 'mine' | 'public',
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

export async function renameWorkout(
  getToken: TokenGetter,
  id: string,
  name: string,
): Promise<Workout> {
  // PATCH rather than a field on the items PUT: a rename must not have to
  // resend the item list, or a client with a slightly stale copy silently
  // rewrites the workout while correcting a typo.
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkout(
  getToken: TokenGetter,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
