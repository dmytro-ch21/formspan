"use client";

import { newTraceId, traceparent } from "@/lib/trace";
// libraryTiles is imported for one pure predicate, not for presentation — it
// has no imports of its own and no React. Reusing it keeps the family prefix
// rule to one definition per app; the repo already carries three copies of it
// and `positionVocabulary.test.ts` exists because they drift.
import { inPositionFamily } from "@/lib/libraryTiles";
import { localZone } from "@/lib/history";
import { formatWeight, type UnitSystem } from "@/lib/units";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

/**
 * A discipline key. Deliberately NOT a hand-written union any more: the list
 * lives in the server's registry (`GET /v1/modules`), and a union here was a
 * second copy that drifted from it — this file's own SPORTS array listed them
 * in a different order than the type did.
 */
export type Sport = string;
export type Goal = "general" | "powerlifting" | "hypertrophy" | "endurance";
export type Visibility = "private" | "public";
export type LoadType =
  "weight_reps" | "reps" | "time" | "distance" | "distance_time";

export type Media = {
  kind: string;
  url: string;
  width: number | null;
  height: number | null;
  is_default: boolean;
};

export type Exercise = {
  id: string;
  name: string;
  sport: Sport;
  movement_pattern: string;
  movement_pattern_detail: string;
  primary_muscles: string[];
  secondary_muscles: string[];
  equipment: string[];
  load_type: LoadType;
  is_unilateral: boolean;
  instructions: string;
  media: Media[];
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
};

export type Workout = {
  id: string;
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

// SPORTS is gone. The list comes from GET /v1/modules — see `Module` below and
// `ModulesProvider` in the dashboard layout. Eight places in this app hardcoded
// disciplines; two of them reimplemented registry *capabilities* rather than
// just the list.

// Only meaningful for strength: powerlifting, hypertrophy and endurance are
// all done with the same barbell squat, so they belong to the workout.
export const GOALS: { key: Goal; label: string }[] = [
  { key: "general", label: "General" },
  { key: "powerlifting", label: "Powerlifting" },
  { key: "hypertrophy", label: "Hypertrophy" },
  { key: "endurance", label: "Endurance" },
];

export type TargetField = "sets" | "reps" | "weight" | "seconds" | "distance";

/**
 * Which target inputs an exercise takes, decided by its own `load_type`.
 * Identical rule to the mobile client — deliberately, because the two must
 * present the same template the same way. Duplicated rather than shared
 * because there's no cross-app package yet; if a third consumer appears,
 * promote it.
 */
export function targetFieldsFor(loadType: LoadType): TargetField[] {
  switch (loadType) {
    case "weight_reps":
      return ["sets", "reps", "weight"];
    case "reps":
      return ["sets", "reps"];
    case "time":
      return ["sets", "seconds"];
    case "distance":
      return ["sets", "distance"];
    case "distance_time":
      return ["distance", "seconds"];
  }
}

export const FIELD_LABEL: Record<TargetField, string> = {
  sets: "Sets",
  reps: "Reps",
  // Overridden by the caller with the athlete's own unit — kept here only
  // as the metric default for anything that hasn't been wired up yet.
  weight: "kg",
  seconds: "Secs",
  distance: "Metres",
};

export const FIELD_KEY: Record<TargetField, keyof WorkoutItem> = {
  sets: "target_sets",
  reps: "target_reps",
  weight: "target_weight_kg",
  seconds: "target_seconds",
  distance: "target_distance_m",
};

export function summariseTargets(
  i: WorkoutItem,
  units: UnitSystem = "metric",
): string {
  const parts: string[] = [];
  if (i.target_sets && i.target_reps)
    parts.push(`${i.target_sets} × ${i.target_reps}`);
  else if (i.target_sets) parts.push(`${i.target_sets} sets`);
  else if (i.target_reps) parts.push(`${i.target_reps} reps`);
  if (i.target_weight_kg) parts.push(formatWeight(i.target_weight_kg, units));
  if (i.target_seconds) {
    const m = Math.floor(i.target_seconds / 60);
    const s = i.target_seconds % 60;
    parts.push(m ? `${m}m${s ? ` ${s}s` : ""}` : `${s}s`);
  }
  if (i.target_distance_m) {
    parts.push(
      i.target_distance_m >= 1000
        ? `${(i.target_distance_m / 1000).toFixed(1)} km`
        : `${i.target_distance_m} m`,
    );
  }
  return parts.join(" · ") || "No targets";
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
    notes: "",
  };
}

export function pickImage(
  e: Exercise,
  prefer: "thumbnail" | "demo",
): string | null {
  const order =
    prefer === "thumbnail"
      ? ["thumbnail", "demo", "start"]
      : ["demo", "start", "thumbnail"];
  for (const kind of order) {
    const hit = e.media.find((m) => m.kind === kind && m.url);
    if (hit) return hit.url;
  }
  return null;
}

export type SetType =
  "warmup" | "working" | "backoff" | "drop" | "amrap" | "failure";

export const SET_TYPES: { key: SetType; label: string; short: string }[] = [
  { key: "warmup", label: "Warm-up", short: "W" },
  { key: "working", label: "Working", short: "" },
  { key: "backoff", label: "Back-off", short: "B" },
  { key: "drop", label: "Drop", short: "D" },
  { key: "amrap", label: "AMRAP", short: "A" },
  { key: "failure", label: "To failure", short: "F" },
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
  sport: Sport;
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
 */
export type SuggestionCode =
  /** Same load, one more rep — the first half of double progression. */
  | "add_reps"
  /** Top of the rep range hit on every set: load moves, reps reset. */
  | "add_load"
  /** Stalled three sessions at one load: back off ~10% and re-approach. */
  | "deload"
  /** The range isn't finished at this load yet. Repeat it. */
  | "hold"
  | "no_history"
  | "not_applicable"
  | "repeat_hard"
  | "repeat_unknown_effort"
  | "repeat_stale";

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
 * `last_max_reps` are the spread across every working set, which belongs to
 * the session rather than to any one set.
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
 * Which measures a performed set records, decided by the exercise's own
 * `load_type` — the same data-driven rule the templates use, and identical
 * to the mobile client's `measuresFor`.
 */
export type Measure = "reps" | "weight" | "seconds" | "distance";

export function measuresFor(loadType: LoadType): Measure[] {
  switch (loadType) {
    case "weight_reps":
      return ["reps", "weight"];
    case "reps":
      return ["reps"];
    case "time":
      return ["seconds"];
    case "distance":
      return ["distance"];
    case "distance_time":
      return ["distance", "seconds"];
  }
}

export const MEASURE_LABEL: Record<Measure, string> = {
  reps: "Reps",
  weight: "kg",
  seconds: "Secs",
  distance: "Metres",
};

export const MEASURE_KEY: Record<Measure, keyof LoggedSet> = {
  reps: "reps",
  weight: "weight_kg",
  seconds: "seconds",
  distance: "distance_m",
};

export function emptySet(
  exerciseID: string,
  position: number,
  from?: LoggedSet,
): LoggedSet {
  return {
    exercise_id: exerciseID,
    position,
    // Carrying the previous set's numbers forward is what makes logging a
    // straight-sets block a click per set rather than a retype.
    set_type: from?.set_type ?? "working",
    reps: from?.reps ?? null,
    weight_kg: from?.weight_kg ?? null,
    seconds: from?.seconds ?? null,
    distance_m: from?.distance_m ?? null,
    // Effort is never carried: the third set at the same weight is not the
    // same effort as the first, and prefilling it would invite recording a
    // number nobody actually judged.
    rir: null,
    rpe: null,
    notes: "",
    completed: false,
  };
}

/**
 * Turns a template into the sets to start from: one row per prescribed set,
 * pre-filled with the prescribed numbers. Mirrors the mobile client exactly,
 * so a session started on either platform begins from the same rows.
 */
export function setsFromWorkout(items: WorkoutItem[]): LoggedSet[] {
  const out: LoggedSet[] = [];
  for (const item of items) {
    const count = Math.min(Math.max(item.target_sets ?? 1, 1), 20);
    for (let i = 0; i < count; i++) {
      out.push({
        exercise_id: item.exercise_id,
        position: out.length,
        set_type: "working",
        reps: item.target_reps,
        weight_kg: item.target_weight_kg,
        seconds: item.target_seconds,
        distance_m: item.target_distance_m,
        rir: null,
        rpe: null,
        notes: "",
        completed: false,
      });
    }
  }
  return out;
}

/**
 * Swaps every set of one exercise for another, in place — the rack is taken,
 * the bar is in use, a shoulder complains on the third set.
 *
 * Measures carry over only when the two are measured the same way: a barbell
 * squat for a goblet squat keeps your reps, a plank for a run cannot keep
 * anything, and inventing a number there would be worse than a blank. Effort
 * is always cleared — it was a judgement about a different movement.
 */
export function swapExercise(
  sets: LoggedSet[],
  fromID: string,
  to: Exercise,
  fromLoadType: LoadType | undefined,
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
 * Suggestions for replacing `base`, in two labelled tiers.
 *
 * **A SECOND COPY.** `apps/mobile/lib/sessions.ts` and
 * `apps/mobile/lib/exerciseFacets.ts` hold the same ranking and the same muscle
 * taxonomy. The apps share no package and mobile needs its copy to work
 * offline, so the duplication is deliberate — and it is exactly the shape this
 * repo has already been bitten by, where one vocabulary lived in four client
 * files and a change updated one of them. `swapParity.test.ts` on the mobile
 * side compares the two directly; extend it if you change either.
 *
 * Muscle first, because the question an athlete is asking is "the rack is
 * taken, what else trains this?" — see the mobile copy for the full reasoning,
 * including why equipment is shown but deliberately not scored.
 */
const MUSCLE_GROUPS: { key: string; label: string; muscles: readonly string[] }[] = [
  {
    key: 'chest',
    label: 'Chest',
    muscles: ['chest', 'upper-chest', 'lower-chest', 'serratus'],
  },
  {
    key: 'back',
    label: 'Back',
    muscles: [
      'lats', 'back', 'upper-back', 'mid-back', 'lower-back',
      'traps', 'upper-traps', 'mid-traps', 'lower-traps',
      'spinal-erectors', 'posterior-chain', 'spine', 'thoracic-spine',
    ],
  },
  {
    key: 'shoulders',
    label: 'Shoulders',
    muscles: [
      'shoulders', 'delts', 'front-delts', 'lateral-delts', 'rear-delts',
      'rotator-cuff', 'infraspinatus', 'subscapularis', 'teres-minor',
      'external-rotators',
    ],
  },
  {
    key: 'arms',
    label: 'Arms',
    muscles: [
      'biceps', 'triceps', 'brachialis', 'brachioradialis', 'forearms',
      'grip', 'wrist-extensors', 'wrist-flexors', 'hands',
    ],
  },
  {
    key: 'core',
    label: 'Core',
    muscles: [
      'abdominals', 'core', 'deep-core', 'lower-abdominals', 'obliques',
      'hip-flexors',
    ],
  },
  {
    key: 'glutes',
    label: 'Glutes',
    muscles: ['glutes', 'glute-medius'],
  },
  {
    key: 'legs',
    label: 'Legs',
    muscles: [
      'quadriceps', 'hamstrings', 'adductors', 'calves', 'soleus',
      'legs', 'hips', 'hip-rotators', 'ankles',
    ],
  },
  {
    key: 'neck',
    label: 'Neck',
    muscles: ['neck-extensors', 'neck-flexors', 'lateral-neck'],
  },
  {
    key: 'full-body',
    label: 'Full body',
    muscles: ['full-body', 'cardiorespiratory'],
  },
];

const MUSCLE_TO_GROUP = new Map<string, string>(
  MUSCLE_GROUPS.flatMap((g) => g.muscles.map((m) => [m, g.key] as [string, string])),
);

/**
 * Do these two exercises train the same thing?
 *
 * Compared on the GROUP, not the raw muscle: the catalog carries 58 distinct
 * values, so a raw comparison calls a barbell row and a chin-up unrelated
 * (`upper-back` vs `lats`). Unmapped muscles contribute no group, so two
 * exercises with unrecognised muscles never match each other.
 */
export function sharesMuscleGroup(a: Exercise, b: Exercise): boolean {
  const groups = new Set(
    a.primary_muscles
      .map((m) => MUSCLE_TO_GROUP.get(m) ?? null)
      .filter((g): g is string => g !== null),
  );
  return b.primary_muscles.some((m) => {
    const g = MUSCLE_TO_GROUP.get(m) ?? null;
    return g !== null && groups.has(g);
  });
}

export type SwapSuggestions = { muscle: Exercise[]; movement: Exercise[] };

/** Per tier, so a well-covered muscle cannot crowd the movement tier out. */
export const MAX_SWAP_SUGGESTIONS = 10;

export function swapSuggestions(base: Exercise, all: Exercise[]): SwapSuggestions {
  const rank = (e: Exercise): number => {
    const pattern = e.movement_pattern === base.movement_pattern;
    const carries = e.load_type === base.load_type;
    if (pattern && carries) return 3;
    if (pattern) return 2;
    if (carries) return 1;
    return 0;
  };
  const order = (a: Exercise, b: Exercise) =>
    rank(b) - rank(a) || a.name.localeCompare(b.name);

  const muscle: Exercise[] = [];
  const movement: Exercise[] = [];
  for (const e of all) {
    if (e.id === base.id) continue;
    if (sharesMuscleGroup(base, e)) muscle.push(e);
    else if (e.movement_pattern === base.movement_pattern) movement.push(e);
  }
  return {
    muscle: muscle.sort(order).slice(0, MAX_SWAP_SUGGESTIONS),
    movement: movement.sort(order).slice(0, MAX_SWAP_SUGGESTIONS),
  };
}

export function describeSet(s: LoggedSet): string {
  const parts: string[] = [];
  if (s.reps != null && s.weight_kg != null)
    parts.push(`${s.reps} × ${s.weight_kg}kg`);
  else if (s.reps != null) parts.push(`${s.reps} reps`);
  else if (s.weight_kg != null) parts.push(`${s.weight_kg}kg`);
  if (s.seconds != null) parts.push(`${s.seconds}s`);
  if (s.distance_m != null) parts.push(`${s.distance_m}m`);
  if (s.rpe != null) parts.push(`RPE ${s.rpe}`);
  else if (s.rir != null) parts.push(`${s.rir} RIR`);
  return parts.join(" · ") || "Not recorded";
}

export type UnitSystemPref = "metric" | "imperial";

export type Profile = {
  user_id: string;
  display_name: string | null;
  unit_system: UnitSystemPref;
  track_effort: boolean;
};

export type Token = () => Promise<string | null>;

/**
 * An API failure that kept the error *code* from the response envelope.
 * Codes are part of the contract; messages explicitly are not.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True when the server rejected the input rather than the request. */
export function isValidationError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "invalid_input";
}

async function request<T>(
  getToken: Token,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Not signed in.");

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      traceparent: traceparent(newTraceId()),
    },
  });

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // The API's message is human-usable where it matters (a sport mismatch
    // names the offending exercise), so surface it over a bare status.
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? "unknown",
      res.status,
    );
  }
  return body as T;
}

export async function listWorkouts(
  getToken: Token,
  scope: "mine" | "shared",
  signal?: AbortSignal,
): Promise<Workout[]> {
  const b = await request<{ workouts: Workout[] }>(
    getToken,
    `/workouts?scope=${scope}`,
    {},
    signal,
  );
  return b.workouts ?? [];
}

export async function getWorkout(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<Workout> {
  return request<Workout>(
    getToken,
    `/workouts/${encodeURIComponent(id)}`,
    {},
    signal,
  );
}

export async function createWorkout(
  getToken: Token,
  input: {
    name: string;
    sport: Sport;
    goal: Goal | null;
    visibility: Visibility;
  },
): Promise<Workout> {
  // Client-generated ID keeps create idempotent on retry, matching the
  // contract the offline mobile client relies on.
  return request<Workout>(getToken, "/workouts", {
    method: "POST",
    body: JSON.stringify({ id: crypto.randomUUID(), ...input, notes: "" }),
  });
}

export async function replaceItems(
  getToken: Token,
  id: string,
  items: WorkoutItem[],
): Promise<Workout> {
  return request<Workout>(
    getToken,
    `/workouts/${encodeURIComponent(id)}/items`,
    {
      method: "PUT",
      body: JSON.stringify({ items }),
    },
  );
}

export async function renameWorkout(
  getToken: Token,
  id: string,
  name: string,
): Promise<Workout> {
  // PATCH rather than a field on the items PUT: a rename must not have to
  // resend the item list, or a client holding a slightly stale copy silently
  // rewrites the workout while correcting a typo.
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkout(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/workouts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * `goal` picks the rep range the rule progresses inside — the same squat is a
 * 3-rep lift in a strength block and a 10-rep lift in a hypertrophy one. Pass
 * the goal of the workout being performed; omitting it falls back to a general
 * 5–8 range rather than failing.
 */
export async function fetchSuggestions(
  getToken: Token,
  exerciseIDs: string[],
  goal?: string | null,
  signal?: AbortSignal,
): Promise<Map<string, Suggestion>> {
  const unique = [...new Set(exerciseIDs)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const q = new URLSearchParams({ exercise_ids: unique.join(",") });
  if (goal) q.set("goal", goal);
  const b = await request<{ suggestions: Suggestion[] }>(
    getToken,
    `/sessions/suggestions?${q}`,
    {},
    signal,
  );
  return new Map((b.suggestions ?? []).map((s) => [s.exercise_id, s]));
}

/**
 * Fills in the weight and reps for sets that don't already carry them. A
 * template's own prescription always wins — it's an instruction, not a guess.
 *
 * Reps are filled now where they weren't before: under double progression the
 * rep target *is* half the recommendation, and a session that pre-filled the
 * weight but left reps blank would silently drop the half that moves most
 * often.
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

/**
 * Per-exercise unit overrides, as a map of exercise id → unit system. A
 * missing key means "use the profile default"; clearing removes the key
 * rather than storing a sentinel.
 */
export async function getExerciseUnits(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Record<string, UnitSystemPref>> {
  const b = await request<{ exercise_units: Record<string, UnitSystemPref> }>(
    getToken,
    "/profile/exercise-units",
    {},
    signal,
  );
  return b.exercise_units ?? {};
}

/** Pass null to clear the override and fall back to the profile default. */
export async function setExerciseUnit(
  getToken: Token,
  exerciseID: string,
  unit: UnitSystemPref | null,
): Promise<void> {
  await request<void>(
    getToken,
    `/profile/exercise-units/${encodeURIComponent(exerciseID)}`,
    {
      method: "PUT",
      body: JSON.stringify({ unit_system: unit }),
    },
  );
}

export function getProfile(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Profile> {
  return request<Profile>(getToken, "/profile", {}, signal);
}

/**
 * Sets the unit preference, creating the profile if there isn't one yet.
 * PATCH on a missing profile is a 404 — the right answer for the API, but a
 * dead end for someone who reaches Settings without having onboarded.
 */
export async function updateUnitSystem(
  getToken: Token,
  unit: UnitSystemPref,
): Promise<Profile> {
  const patch = () =>
    request<Profile>(getToken, "/profile", {
      method: "PATCH",
      body: JSON.stringify({ unit_system: unit }),
    });
  try {
    return await patch();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    await request<Profile>(getToken, "/profile", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return patch();
  }
}

/**
 * BJJ rank, client half of `internal/modules/bjj`.
 *
 * `current` on {@link BjjStanding} is DERIVED server-side from `promotions`,
 * not stored — see the backend's `StandingFrom`. This client never computes a
 * rank itself, for the same reason the server doesn't let a date decide it:
 * two independent derivations are two chances to disagree.
 */
export type BjjBelt = "white" | "blue" | "purple" | "brown" | "black";

/** Belts, in rank order — for a picker that doesn't hardcode the list again. */
export const BJJ_BELTS: BjjBelt[] = ["white", "blue", "purple", "brown", "black"];

export const BJJ_MAX_STRIPES = 4;
export const BJJ_MAX_DEGREE = 6;

export type BjjRank = {
  belt: BjjBelt;
  stripes: number;
  /** Black-belt degrees. 0 on every other belt. */
  degree: number;
};

/** What the add/edit form sends — a rank plus the promotion's own facts. */
export type BjjPromotionInput = BjjRank & {
  /** "YYYY-MM-DD", or null when the athlete doesn't remember. */
  promoted_on: string | null;
  academy: string;
  instructor: string;
  note: string;
};

export type BjjPromotion = BjjPromotionInput & {
  id: string;
  created_at: string;
  updated_at: string;
};

export type BjjStanding = {
  /** Null means no rank recorded — a real state, not a loading placeholder. */
  current: BjjRank | null;
  time_at_current_days: number | null;
  promotions: BjjPromotion[];
};

export function getBjjStanding(
  getToken: Token,
  signal?: AbortSignal,
): Promise<BjjStanding> {
  return request<BjjStanding>(getToken, "/bjj/standing", {}, signal);
}

/**
 * One technique's accumulated evidence — NOT a score.
 *
 * `attempted` and `scored` are disjoint: attempted is "went for it live and it
 * didn't land", so `attempted + scored` is how often it was tried and
 * `scored / (attempted + scored)` is the hit rate. Reading `attempted` as
 * total tries is the natural mistake and gives different numbers.
 */
export type BjjProficiency = {
  technique_id: string;
  name: string;
  position: string;
  category: string;
  drilled: number;
  attempted: number;
  scored: number;
  conceded: number;
  /**
   * Them going for it and the athlete stopping them — the mirror of
   * `attempted`, and the defensive half of the 2x2 the tag vocabulary forms.
   * Required by the contract; omitting it here let the page treat a defensive
   * win as evidence of nothing.
   */
  defended: number;
  /** How many separate sessions contributed — the honesty check on the rest. */
  sessions: number;
  last_seen: string;
};

/** Counts of TECHNIQUES, not of reps. */
export type BjjProficiencySummary = {
  techniques: number;
  drilled: number;
  tried_live: number;
  landed: number;
};

/**
 * One technique the athlete is deliberately working on.
 *
 * The list is short (max 5) and turns over every few weeks. It is what makes
 * technique-level capture affordable on the phone: the reflection wizard shows
 * these as one-tap rows instead of asking anyone to search 542 library entries
 * mid-reflection.
 */
export type BjjFocus = {
  technique_id: string;
  name: string;
  position: string;
  category: string;
  /** YYYY-MM-DD. When it JOINED the list — survives reordering and re-saves. */
  started_on: string;
};

/** Matches the backend's maxFocus. The cap is the feature: twenty is the library again. */
export const MAX_BJJ_FOCUS = 5;

export function getBjjFocus(getToken: Token, signal?: AbortSignal): Promise<BjjFocus[]> {
  return request<{ focus: BjjFocus[] }>(getToken, "/bjj/focus", {}, signal).then(
    (r) => r.focus ?? [],
  );
}

/** Replaces the list wholesale; array order is the athlete's own ranking. */
export function setBjjFocus(getToken: Token, techniqueIDs: string[]): Promise<BjjFocus[]> {
  return request<{ focus: BjjFocus[] }>(getToken, "/bjj/focus", {
    method: "PUT",
    body: JSON.stringify({ technique_ids: techniqueIDs }),
  }).then((r) => r.focus ?? []);
}

export function getBjjProficiency(
  getToken: Token,
  signal?: AbortSignal,
): Promise<{ techniques: BjjProficiency[]; summary: BjjProficiencySummary }> {
  return request<{ techniques: BjjProficiency[]; summary: BjjProficiencySummary }>(
    getToken,
    "/bjj/proficiency",
    {},
    signal,
  );
}

export function createBjjPromotion(
  getToken: Token,
  input: BjjPromotionInput,
): Promise<BjjPromotion> {
  return request<BjjPromotion>(getToken, "/bjj/promotions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateBjjPromotion(
  getToken: Token,
  id: string,
  input: BjjPromotionInput,
): Promise<BjjPromotion> {
  return request<BjjPromotion>(
    getToken,
    `/bjj/promotions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function deleteBjjPromotion(getToken: Token, id: string): Promise<void> {
  return request<void>(getToken, `/bjj/promotions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * The obvious next step from a current rank — one more stripe, or the next
 * belt once a stripe run is full.
 *
 * A suggestion for the add-promotion form to start from, not a value the
 * server ever sees or trusts: every field is still editable before saving,
 * for the jumps and corrections this can't guess.
 *
 * Black is degrees, not stripes — advancing past `BJJ_MAX_DEGREE` has
 * nowhere further to go, so it holds rather than wrapping to white.
 */
export function nextBjjRank(current: BjjRank): BjjRank {
  if (current.belt === "black") {
    return { belt: "black", stripes: 0, degree: Math.min(current.degree + 1, BJJ_MAX_DEGREE) };
  }
  if (current.stripes < BJJ_MAX_STRIPES) {
    return { belt: current.belt, stripes: current.stripes + 1, degree: 0 };
  }
  const next = BJJ_BELTS[Math.min(BJJ_BELTS.indexOf(current.belt) + 1, BJJ_BELTS.length - 1)];
  return { belt: next, stripes: 0, degree: 0 };
}

/**
 * "3 years", "6 months", "12 days" — the coarsest unit that doesn't round to
 * zero. Matches how a grappler actually states time at a belt; nobody says
 * "1,097 days".
 */
export function describeTimeAtBjjBelt(days: number): string {
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} ${years === 1 ? "year" : "years"}`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} ${months === 1 ? "month" : "months"}`;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export type SessionQuery = {
  limit?: number;
  offset?: number;
  sport?: Sport;
  from?: string;
  to?: string;
  tz?: string;
  /** Free text matched against the session name. */
  q?: string;
};

/** One page of sessions, plus how many the filter matched in total. */
export type SessionPage = {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
};

function sessionQS(opts: SessionQuery): string {
  const p = new URLSearchParams();
  if (opts.limit) p.set("limit", String(opts.limit));
  if (opts.offset) p.set("offset", String(opts.offset));
  if (opts.sport) p.set("sport", opts.sport);
  if (opts.from) p.set("from", opts.from);
  if (opts.to) p.set("to", opts.to);
  if (opts.tz) p.set("tz", opts.tz);
  if (opts.q) p.set("q", opts.q);
  // Not `p.size`: that's Safari 17+, and on older builds `undefined > 0` is
  // false, so every filter would be dropped in silence — the listing would
  // quietly cover all time while the calendar covered the period.
  const query = p.toString();
  return query ? `?${query}` : "";
}

export async function listSessionsPage(
  getToken: Token,
  opts: SessionQuery = {},
  signal?: AbortSignal,
): Promise<SessionPage> {
  const b = await request<SessionPage>(
    getToken,
    `/sessions${sessionQS(opts)}`,
    {},
    signal,
  );
  return {
    sessions: b.sessions ?? [],
    total: b.total ?? 0,
    limit: b.limit ?? 0,
    offset: b.offset ?? 0,
  };
}

export type HistoryTotals = {
  sessions: number;
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  duration_seconds: number;
  exercises: number;
  active_days: number;
};

export type HistoryDay = {
  date: string; // YYYY-MM-DD in the requested timezone
  sessions: number;
  working_sets: number;
  total_reps: number;
  tonnage_kg: number;
  duration_seconds: number;
  sports: Sport[];
};

export type History = {
  from: string;
  to: string;
  totals: HistoryTotals;
  /** The same-length window immediately before, for reading totals as a direction. */
  previous: HistoryTotals;
  /** Only days that had training, ascending. Gaps are absent, not zero-filled. */
  days: HistoryDay[];
  /** Every sport in range, ignoring the sport filter. */
  sports: { sport: Sport; sessions: number }[];
};

/**
 * The training-history rollup.
 *
 * Aggregated server-side deliberately: the working-set rule lives in one
 * place, and summing a client-side listing would silently under-report once
 * history outgrows the 200-row cap.
 */
export async function fetchHistory(
  getToken: Token,
  opts: { from: string; to: string; sport?: Sport; tz?: string },
  signal?: AbortSignal,
): Promise<History> {
  const q = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.sport) q.set("sport", opts.sport);
  if (opts.tz) q.set("tz", opts.tz);
  return request<History>(getToken, `/sessions/history?${q}`, {}, signal);
}

export async function getSession(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}`, {}, signal);
}

export async function startSession(
  getToken: Token,
  input: {
    sport: Sport;
    name: string;
    workout_id?: string | null;
    sets?: LoggedSet[];
  },
): Promise<{ session: Session; volume: Volume }> {
  // Client-generated ID, so starting a session is idempotent on retry —
  // the same contract the offline mobile client relies on.
  return request(getToken, "/sessions", {
    method: "POST",
    body: JSON.stringify({
      id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      ...input,
    }),
  });
}

export async function replaceSets(
  getToken: Token,
  id: string,
  sets: LoggedSet[],
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/sets`, {
    method: "PUT",
    body: JSON.stringify({ sets }),
  });
}

export async function finishSession(
  getToken: Token,
  id: string,
): Promise<{ session: Session; volume: Volume }> {
  return request(getToken, `/sessions/${encodeURIComponent(id)}/finish`, {
    method: "POST",
    body: JSON.stringify({ ended_at: new Date().toISOString() }),
  });
}

export async function deleteSession(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function listExercises(
  getToken: Token,
  filter: { sport?: string; q?: string } = {},
  signal?: AbortSignal,
): Promise<Exercise[]> {
  const p = new URLSearchParams();
  if (filter.sport) p.set("sport", filter.sport);
  if (filter.q) p.set("q", filter.q);
  const qs = p.toString();
  const b = await request<{ exercises: Exercise[] }>(
    getToken,
    `/exercises${qs ? `?${qs}` : ""}`,
    {},
    signal,
  );
  return b.exercises ?? [];
}

/* ── BJJ technique library ─────────────────────────────────────────────── */

export type Ruleset = {
  id: string;
  age_scope: string;
  rule_class: string;
  /** Empty means this division doesn't apply, NOT "allowed at no belt". */
  gi_allowed_belts: string[];
  gi_note: string;
  no_gi_allowed_belts: string[];
  no_gi_note: string;
  /**
   * A genuine restriction, as opposed to the shape of IBJJF's divisions.
   * Trust this field — do NOT infer restriction by counting belts. Adult no-gi
   * has no white belt division, so a no-gi list of Blue/Purple/Brown/Black is
   * the baseline; counting marks 441 ordinary techniques as restricted when
   * only 27 are.
   */
  is_restricted: boolean;
  notes: string;
  sources: string[];
};

export type TechniqueSummary = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  /**
   * What the technique DOES: advance | reverse | escape | control | finish.
   *
   * The contract has always promised this on the list response, and the
   * runtime objects have always carried it — only this type omitted it, so it
   * was invisible to every caller here. That omission was not free: when
   * search started indexing `function`, mobile got it and web did not, and the
   * same query returned different SETS on the two platforms ("advance" — 131
   * on the phone, 0 on the desktop) with nothing able to see the difference.
   *
   * Optional because the movement fundamentals (breakfalls, grappling stance)
   * genuinely have none — the API omits the key rather than sending "".
   * Note it cannot be destructured (`const { function } = t` is a syntax
   * error); read it as `t.function`.
   */
  function?: string;
  position: string;
  position_detail: string;
  gi_no_gi: string;
  /** Commonly taught from — an observation, never a gate. */
  typical_belt: string;
  ibjjf_ruleset_id: string;
};

export type Technique = TechniqueSummary & {
  /** The mechanics. */
  description: string;
  /** The decision: when the mechanics apply. */
  when_to_use: string;
  setup_from: string[];
  common_next_moves: string[];
  common_counters: string[];
  /** Empty for every technique in the current library. */
  video_reference: string;
  source_notes: string;
  ibjjf?: Ruleset | null;
};

/**
 * The whole library, unfiltered and cached for the tab's lifetime.
 *
 * 542 summaries are ~197 KB; full rows would be ~587 KB and carry prose no grid
 * can show. Fetching once makes search and filtering local, which is what lets
 * the desktop grid update as you type without a request per keystroke.
 *
 * Failures are not cached — a null cache retries, an empty array would look
 * like a library with nothing in it.
 */
let techniqueCache: TechniqueSummary[] | null = null;
let rulesetCache: Map<string, Ruleset> | null = null;

export async function listTechniques(
  getToken: Token,
  signal?: AbortSignal,
): Promise<TechniqueSummary[]> {
  if (techniqueCache) return techniqueCache;
  const b = await request<{ techniques: TechniqueSummary[] }>(
    getToken,
    "/techniques",
    {},
    signal,
  );
  // Normalised at the parse boundary: a server predating the enrichment omits
  // these, and `undefined.length` in a render is a blank page rather than a
  // degraded one. That is exactly the shape of a staged rollout.
  techniqueCache = (b.techniques ?? []).map((t) => ({
    ...t,
    aliases: t.aliases ?? [],
    // haystack() folds position on every entry now, where the old three-way
    // filter short-circuited on a name match and often never read it.
    position: t.position ?? "",
    position_detail: t.position_detail ?? "",
    typical_belt: t.typical_belt ?? "",
    ibjjf_ruleset_id: t.ibjjf_ruleset_id ?? "",
  }));
  return techniqueCache;
}

export async function getTechnique(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<Technique> {
  const t = await request<Technique>(
    getToken,
    `/techniques/${encodeURIComponent(id)}`,
    {},
    signal,
  );
  return {
    ...t,
    aliases: t.aliases ?? [],
    setup_from: t.setup_from ?? [],
    common_next_moves: t.common_next_moves ?? [],
    common_counters: t.common_counters ?? [],
    description: t.description ?? "",
    when_to_use: t.when_to_use ?? "",
    video_reference: t.video_reference ?? "",
    source_notes: t.source_notes ?? "",
    typical_belt: t.typical_belt ?? "",
    position_detail: t.position_detail ?? "",
    ibjjf_ruleset_id: t.ibjjf_ruleset_id ?? "",
  };
}

/**
 * Rulesets, fetched at most once. A missing legality badge must never stop a
 * technique being read, so a failure yields an empty map rather than throwing.
 */
export async function listRulesets(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Map<string, Ruleset>> {
  if (rulesetCache) return rulesetCache;
  try {
    const b = await request<{ rulesets: Ruleset[] }>(
      getToken,
      "/techniques/rulesets",
      {},
      signal,
    );
    rulesetCache = new Map((b.rulesets ?? []).map((r) => [r.id, r]));
    return rulesetCache;
  } catch {
    return new Map();
  }
}

/**
 * One entry in the BJJ position glossary — the nodes the techniques run
 * between. Techniques are what you *do*; these are what you do it *in*.
 *
 * Eleven of them, a few KB total, so none of the technique library's
 * optimisations apply: no summary/detail split, no local search, fetched whole.
 */
export type Position = {
  id: string;
  name: string;
  aliases: string[];
  /**
   * The join key back to the library, prefix-matched against a summary's
   * `position` — not compared. Note back control's family is `Back`.
   */
  family: string;
  /**
   * Narrow the family match by `position_detail`. Includes is a whitelist,
   * excludes a blacklist applied after it; both empty means the whole family.
   *
   * BOTH must be applied — see {@link techniquesInPosition}.
   */
  detail_includes: string[];
  detail_excludes: string[];
  /** Pedagogical reading order. The server sorts by it; do not re-sort. */
  order_index: number;
  /** What the position is, and how you end up in it. */
  description: string;
  /** What each player is trying to do there. Both sides, split by a blank line. */
  priorities: string;
};

/**
 * Positions, fetched once. Failures are not cached, same reasoning as the
 * technique cache above.
 */
let positionCache: Position[] | null = null;

function normalisePosition(p: Position): Position {
  return {
    ...p,
    aliases: p.aliases ?? [],
    family: p.family ?? "",
    detail_includes: p.detail_includes ?? [],
    detail_excludes: p.detail_excludes ?? [],
    order_index: p.order_index ?? 0,
    description: p.description ?? "",
    priorities: p.priorities ?? "",
  };
}

export async function listPositions(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Position[]> {
  if (positionCache) return positionCache;
  const b = await request<{ positions: Position[] }>(
    getToken,
    "/techniques/positions",
    {},
    signal,
  );
  positionCache = (b.positions ?? []).map(normalisePosition);
  return positionCache;
}

/**
 * Served from the cached list when it is loaded, which it always is here: the
 * panel only opens from a card the list rendered. The request is the fallback
 * for a deep link, not the normal path.
 */
export async function getPosition(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<Position> {
  const cached = positionCache?.find((p) => p.id === id);
  if (cached) return cached;
  return normalisePosition(
    await request<Position>(
      getToken,
      `/techniques/positions/${encodeURIComponent(id)}`,
      {},
      signal,
    ),
  );
}

/**
 * The techniques that happen in a position, resolved locally.
 *
 * This is why `family` exists and why there is no per-position endpoint: the
 * Library already holds all 542 summaries, so the cross-link costs a filter
 * rather than a request.
 *
 * Two axes, and applying only the first is the bug this shipped with once.
 * `position` is coarse — every guard technique says "Guard - Bottom" — so
 * family alone puts closed and open guard on the same 161 entries, and the
 * Open Guard panel lists closed-guard material beneath a description saying
 * the ankles are not locked. `position_detail` is what knows the difference.
 */
export function techniquesInPosition(
  techniques: TechniqueSummary[],
  position: Pick<Position, "family" | "detail_includes" | "detail_excludes">,
): TechniqueSummary[] {
  const {
    family,
    detail_includes: includes,
    detail_excludes: excludes,
  } = position;
  if (!family) return [];
  return techniques
    .filter((t) => {
      if (!inPositionFamily(t.position, family)) return false;
      if (includes.length > 0 && !includes.includes(t.position_detail))
        return false;
      return !excludes.includes(t.position_detail);
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * One collator, built once — `localeCompare` re-enters ICU per call, and open
 * guard alone sorts 138 entries.
 */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * Words that carry no identity, dropped from the QUERY only.
 *
 * "break the guard" and "pass the guard" are how the moves get said out loud,
 * and neither appears anywhere in the catalog's naming — the rows are
 * "Standing Closed-Guard Break" and "Knee-Cut Pass". Requiring the joiner to
 * appear is what made the spoken form return nothing at all.
 *
 * Dropped from the query and NOT from the fields: a stored name is data and
 * gets to keep its words. Stripping both sides would let "side control" match
 * "side" alone.
 *
 * DUPLICATED in apps/mobile/lib/techniques.ts, along with everything else in
 * this search — see foldForSearch's note for why the two apps carry copies.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "from", "to", "of", "and", "or", "in", "on", "at", "into",
  "with", "for",
]);

function queryTokens(query: string): string[] {
  const folded = foldForSearch(query.trim());
  if (!folded) return [];
  const all = folded.split(" ").filter(Boolean);
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  // A query of nothing BUT joiners ("to the") keeps them rather than becoming
  // an empty search that returns all 542 — the athlete typed something.
  return kept.length > 0 ? kept : all;
}

// What a token is worth by where it landed. Name beats alias beats position,
// so "armbar" ranks the armbars above every technique that merely happens to
// sit in a position whose text contains it.
const W_NAME = 100;
const W_ALIAS = 60;
const W_POSITION = 30;
const W_META = 12;

/**
 * Score one technique against pre-tokenised query terms.
 *
 * Returns 0 when ANY term matches nothing — terms are ANDed, so "knee belly"
 * does not return every knee technique. A non-zero score is both "this
 * matches" and "this is how well", which keeps filtering and ranking from
 * drifting apart into two definitions of a match.
 */
function scoreTechnique(
  t: TechniqueSummary,
  terms: string[],
  whole: string,
): number {
  const f = folded(t);
  let score = 0;

  for (const term of terms) {
    let best = 0;
    if (f.name.includes(term)) best = W_NAME;
    else if (f.aliases.some((a) => a.includes(term))) best = W_ALIAS;
    else if (f.position.includes(term) || f.detail.includes(term))
      best = W_POSITION;
    else if (f.category.includes(term) || f.fn.includes(term)) best = W_META;
    // One unmatched term disqualifies the row entirely.
    if (best === 0) return 0;
    score += best;
  }

  // Contiguity bonuses, in order of how strongly they say "this is the one".
  // Without them "armbar" ranks 21 techniques by nothing but term count and
  // the top slots go to whichever the seed file happened to list first.
  if (f.name === whole) score += 10_000;
  else if (f.name.startsWith(whole)) score += 5_000;
  else if (f.name.includes(whole)) score += 2_000;
  else if (f.aliases.some((a) => a === whole)) score += 4_000;
  else if (f.aliases.some((a) => a.includes(whole))) score += 1_000;

  // Every term in the name outranks a row that needed position or category to
  // complete the match.
  if (terms.every((term) => f.name.includes(term))) score += 500;

  return score;
}

/**
 * Local search across name, aliases, position, detail and category.
 *
 * ORDER IS THE CALLER'S, DELIBERATELY. The Library merges this output against
 * the exercise catalog with a linear merge of two name-sorted runs — returning
 * by relevance silently corrupts that interleave into an unsorted jumble, with
 * no type error and no test to catch it. Use `rankTechniques` where the best
 * few matter; this stays a filter.
 *
 * Aliases matter more than they look: half this library is known by two names,
 * and someone searching "scarf hold" will never find "Kesa-Gatame Escape"
 * without them.
 */
export function searchTechniques(
  list: TechniqueSummary[],
  query: string,
): TechniqueSummary[] {
  const terms = queryTokens(query);
  if (terms.length === 0) return list;
  const whole = foldForSearch(query.trim());
  return list.filter((t) => scoreTechnique(t, terms, whole) > 0);
}

/**
 * The same matches, best first.
 *
 * For the surfaces that show a handful and drop the rest — the curriculum
 * builder's 60, the reflect picker on mobile. A cap over UNRANKED results is
 * what made "side control" (50 matches) look like the library was missing the
 * obvious ones; the cap was never the problem, the arbitrary choice of which
 * ones was.
 *
 * Ties break on name so the order is stable across keystrokes rather than
 * reshuffling equal-scoring rows underneath a cursor already moving to one.
 */
export function rankTechniques(
  list: TechniqueSummary[],
  query: string,
): TechniqueSummary[] {
  const terms = queryTokens(query);
  if (terms.length === 0) return list;
  const whole = foldForSearch(query.trim());
  return list
    .map((t) => ({ t, score: scoreTechnique(t, terms, whole) }))
    .filter((r) => r.score > 0)
    // localeCompare, NOT the module's `collator` (sensitivity: "base"). Not a
    // style choice — mobile has no Intl.Collator and ties must break the same
    // way on both platforms or the two apps rank an identical result set
    // differently. Nothing else compares this; searchParity does.
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .map((r) => r.t);
}

/**
 * Lowercase and strip diacritics, so what someone types matches what the
 * library actually stores.
 *
 * Not cosmetic. `sao-paulo-pass` — "São Paulo Pass" — had been in the catalog
 * the whole time and was unfindable: a plain `toLowerCase().includes()` fails
 * "sao paulo" against "São Paulo" because the strings genuinely differ. The
 * technique looked missing, and the near-consequence was authoring a duplicate:
 * two ids for one technique, permanently, in every training record referencing
 * either.
 *
 * NFD splits "ã" into "a" + U+0303 COMBINING TILDE; U+0300–U+036F is the
 * combining-marks block, so removing it leaves the base letters.
 *
 * Dashes fold the same way and for the same reason, and they are the LARGER
 * half of this bug: 16 technique names are spelled with U+2013 EN DASH
 * ("North–South Pass"), which NFD does not decompose. Typing the hyphen
 * that is actually on the keyboard is not a misspelling — the two
 * characters render nearly identically — so "north-south pass" finding
 * nothing is the São Paulo failure again with eight times the blast
 * radius. The app's own vocabulary disagrees with itself here: positions.json
 * spells the position "North-South" with a plain hyphen while every technique
 * name in it uses the en dash.
 *
 * Every dash folds to a SPACE rather than to a hyphen, which also makes
 * "north south" and "kesa gatame" work — nobody reaches for a hyphen when
 * searching. Measured over every name and alias in the catalog: folding to a
 * space finds everything folding to a hyphen finds, plus six more query forms,
 * and loses nothing.
 *
 * DUPLICATED in apps/mobile/lib/techniques.ts. The two apps share no package, and mobile
 * needs its copy to work offline — the same reason the position vocabulary
 * is duplicated four ways. Change one, change the other.
 *
 * That used to be enforced by nothing at all. It now has two guards: each app
 * runs the same behavioural cases against the real catalog (this app's are in
 * src/lib/__tests__/techniqueSearch.test.ts), and mobile's searchParity.test.ts
 * compares the tuning values both copies carry — behaviour tests would let the
 * two rank differently while both stayed green.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-\u2010-\u2015\u2212]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

type Folded = {
  name: string;
  aliases: string[];
  position: string;
  detail: string;
  category: string;
  fn: string;
};

/**
 * Folded fields, cached per technique object.
 *
 * Search runs on every keystroke over the whole 542-entry library. Folding
 * name + aliases + position each time is 2141 fold calls per character typed,
 * measured at 0.774 ms uncached against 0.029 ms cached. Now six fields
 * rather than three, so the cache matters more, not less.
 *
 * A WeakMap keyed on the technique object is what makes this safe: the catalog
 * objects are built once in listTechniques and never written to, so a refetch
 * makes new objects and the stale entries are collected with them. That
 * immutability is the load-bearing assumption and it is a CONVENTION, not
 * something enforced — mutate a summary in place and search silently keeps
 * answering from the pre-mutation text. Build a new object instead.
 *
 * Kept APART rather than joined into one string. They used to be one
 * `\n`-joined haystack, which forced every query to be a contiguous substring
 * of a single field — the reason `arm bar` found nothing while `armbar` found
 * 21, and `break the guard` found nothing while `guard break` found 5.
 * Separate fields let a query match token-by-token and let a match know WHICH
 * field it landed in, which is what ranking needs.
 */
const foldedCache = new WeakMap<object, Folded>();

function folded(t: TechniqueSummary): Folded {
  const hit = foldedCache.get(t);
  if (hit !== undefined) return hit;
  const built: Folded = {
    name: foldForSearch(t.name),
    aliases: t.aliases.map(foldForSearch),
    position: foldForSearch(t.position),
    detail: foldForSearch(t.position_detail),
    // `?? ''` on both, matching the defaulting every other searched field gets
    // at the parse boundary: a server predating the enrichment omits them, and
    // foldForSearch(undefined) throws mid-keystroke inside the filter.
    category: foldForSearch(t.category ?? ""),
    fn: foldForSearch(t.function ?? ""),
  };
  foldedCache.set(t, built);
  return built;
}

/**
 * Split a technique's description into execution steps.
 *
 * The library authors `description` as ONE sentence containing a
 * comma-separated sequence — "Control wrist and elbow, break posture, pivot
 * across the shoulder, clamp the knees, and extend the hips through the elbow
 * line." That is five instructions wearing a paragraph.
 *
 * Re-measured across all 542 (2026-08-06): 535 (99%) split into 2+ steps,
 * clustered at 3–4, averaging 33 characters each. The remaining 7 return `[]`
 * and the caller renders the original prose — a one-item numbered list looks
 * like a bug.
 *
 * Kept byte-identical to the mobile implementation in
 * `apps/mobile/lib/techniques.ts`; the two screens must not disagree about
 * where a step ends.

 * The split deliberately avoids a lookbehind. `(?<=\.)\s+` fires on zero of
 * 542 (trailing periods are stripped anyway), and on web `lib/api.ts` is
 * imported by every dashboard page — a regex literal Next/SWC does not
 * transpile, so an unsupported feature is a parse-time SyntaxError that takes
 * the whole dashboard down on Safari/iOS < 16.4. `\.\s+` is byte-identical on
 * this corpus and carries no engine-support risk.
 *
 * `;` joins the split for the same reason `,` does: on the current corpus a
 * comma-only split falls back to prose on 9, and `;` rescues 2 of them.
 */
export function executionSteps(description: string): string[] {
  const raw = (description || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[,;]\s*(?:and\s+)?|\.\s+/)
    .map((p) => p.trim().replace(/\.$/, ""))
    .filter(Boolean);

  // Length-only folding. An earlier version also folded anything under three
  // words and swallowed real instructions: "break posture" is a step, not a
  // tail.
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length && p.length < 10) merged[merged.length - 1] += `, ${p}`;
    else merged.push(p);
  }

  if (merged.length < 2) return [];
  return merged.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}

/* ── the discipline registry ───────────────────────────────────────────── */

// Defined in `modules.ts`, which carries NO "use client" directive, because
// `dashboard/layout.tsx` is a Server Component and cannot call a client
// reference. Re-exported here so existing client call sites are unchanged.
// See modules.ts for the failure this was found by.
export type { Module, ModuleCapabilities } from "@/lib/modules";
export {
  normaliseModules,
  listModules,
  setModules,
  enabledSports,
  moduleFor,
  labelForModule,
} from "@/lib/modules";

export type RecordKind =
  | "heaviest_weight"
  | "estimated_1rm"
  | "most_reps"
  | "longest_time"
  | "furthest_distance";

export type PersonalRecord = {
  kind: RecordKind;
  /** In storage units — kg, reps, seconds or metres. */
  value: number;
  reps: number | null;
  weight_kg: number | null;
  seconds: number | null;
  distance_m: number | null;
  rir: number | null;
  rpe: number | null;
  achieved_at: string;
  session_id: string;
  is_recent: boolean;
};

export type ExerciseRecords = {
  exercise_id: string;
  records: PersonalRecord[];
};

export const RECORD_LABEL: Record<RecordKind, string> = {
  heaviest_weight: "Heaviest",
  estimated_1rm: "Est. 1RM",
  most_reps: "Most reps",
  longest_time: "Longest",
  furthest_distance: "Furthest",
};

/**
 * The caller's records.
 *
 * `scope: "all"` is the desk view — everything they've actually trained,
 * most-used first. Without it the API answers for their pinned shortlist,
 * which is what the phone shows.
 */
export async function fetchRecords(
  getToken: Token,
  opts: { scope?: "all"; exerciseIDs?: string[] } = {},
  signal?: AbortSignal,
): Promise<ExerciseRecords[]> {
  const p = new URLSearchParams();
  if (opts.scope) p.set("scope", opts.scope);
  if (opts.exerciseIDs?.length)
    p.set("exercise_ids", opts.exerciseIDs.join(","));
  const query = p.toString();
  const b = await request<{ records: ExerciseRecords[] }>(
    getToken,
    `/records${query ? `?${query}` : ""}`,
    {},
    signal,
  );
  return b.records ?? [];
}

export async function fetchPinnedExercises(
  getToken: Token,
  signal?: AbortSignal,
): Promise<string[]> {
  const b = await request<{ exercise_ids: string[] }>(
    getToken,
    "/records/pinned",
    {},
    signal,
  );
  return b.exercise_ids ?? [];
}

export async function setPinnedExercises(
  getToken: Token,
  exerciseIDs: string[],
): Promise<string[]> {
  const b = await request<{ exercise_ids: string[] }>(
    getToken,
    "/records/pinned",
    {
      method: "PUT",
      body: JSON.stringify({ exercise_ids: exerciseIDs }),
    },
  );
  return b.exercise_ids ?? [];
}

/**
 * A planned session — what the athlete INTENDS to train, and when.
 *
 * The third leg alongside `Workout` (the template) and `Session` (what
 * happened). `day` is a bare `YYYY-MM-DD` and stays a string the whole way
 * through: parsed into a Date it would gain a midnight and a zone, and
 * `new Date("2026-08-04")` is parsed as **UTC**, so west of Greenwich it
 * renders as the 3rd. Every date helper below therefore works on the string
 * or on local Date parts, never on that constructor.
 */
export type Plan = {
  id: string;
  user_id: string;
  day: string;
  sport: Sport;
  workout_id: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
};

export async function listPlans(
  getToken: Token,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<Plan[]> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  const b = await request<{ plans: Plan[] }>(
    getToken,
    `/plans?${q}`,
    {},
    signal,
  );
  return b.plans ?? [];
}

export async function createPlan(
  getToken: Token,
  input: {
    day: string;
    sport: Sport;
    workoutID: string | null;
    notes?: string;
  },
): Promise<Plan> {
  return request<Plan>(getToken, "/plans", {
    method: "POST",
    // Client-generated id, matching workouts and sessions — it keeps a retried
    // create idempotent rather than producing a second plan.
    body: JSON.stringify({
      id: crypto.randomUUID(),
      day: input.day,
      sport: input.sport,
      workout_id: input.workoutID,
      notes: input.notes ?? "",
    }),
  });
}

/**
 * Move or re-point a plan.
 *
 * `workoutID` is deliberately three-state, matching the endpoint: leave the
 * key out to keep the current template, pass a string to set it, pass `null`
 * to clear it. `undefined` here means "omit", which is why the body is built
 * key by key rather than spread.
 */
export async function updatePlan(
  getToken: Token,
  id: string,
  changes: { day?: string; sport?: Sport; workoutID?: string | null; notes?: string },
): Promise<Plan> {
  const body: Record<string, unknown> = {};
  if (changes.day !== undefined) body.day = changes.day;
  if (changes.sport !== undefined) body.sport = changes.sport;
  if (changes.workoutID !== undefined) body.workout_id = changes.workoutID;
  if (changes.notes !== undefined) body.notes = changes.notes;

  return request<Plan>(getToken, `/plans/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deletePlan(getToken: Token, id: string): Promise<void> {
  await request<void>(getToken, `/plans/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* ---------------------------------------------------------------------------
 * Curricula and roadmaps
 *
 * A curriculum is an ordered set of techniques to learn; one whose items carry
 * completion criteria is a ROADMAP. The distinction is per ITEM — `criteria`
 * nullable — so the same curriculum can be part reading list and part roadmap.
 * ------------------------------------------------------------------------ */

/** What mastering one technique takes. Every threshold is measured SINCE the
 *  athlete enrolled, never over all time. */
export type CurriculumCriteria = {
  /** Times landed live. Null on a defence-only criterion. */
  target_scored: number | null;
  /** Times you stopped theirs. About a third of `target_scored` — you do not
   *  choose when a technique is attempted on you. */
  target_defended: number | null;
  /** Distinct LIVE sessions the evidence must span. Drilling never counts. */
  target_sessions: number | null;
  /** scored / (attempted + scored). The reason the word "mastered" is
   *  defensible: volume alone is satisfied by 25-from-30 and 25-from-400
   *  alike, and only the first is skill. */
  min_hit_rate: number | null;
};

export type CurriculumProgress = {
  scored: number;
  defended: number;
  sessions: number;
  /** scored + attempted — how often they went for it. */
  attempts: number;
  /** Null when `attempts` is 0. Zero from zero is not a rate, and rendering it
   *  as 0% reports a failure the athlete has not had. */
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
  /** Null means this item is reading rather than a roadmap step. */
  criteria: CurriculumCriteria | null;
  /** Null when the caller is not enrolled, or the item has no criteria. */
  progress: CurriculumProgress | null;
};

export type Curriculum = {
  id: string;
  /** Resolved server-side. Never compare user ids in the client to decide
   *  this — that is how client-side authorization happens. */
  editable: boolean;
  name: string;
  description: string;
  /** A hint for ordering, never a gate. Working white-belt fundamentals at
   *  purple is not a mistake. */
  belt: string | null;
  visibility: Visibility;
  enrolled: boolean;
  /** "YYYY-MM-DD". Null unless enrolled, and the anchor every criterion is
   *  measured from. */
  started_on: string | null;
  /** How many techniques are in it. Present on the list too, so a card can say
   *  "12 techniques" without fetching them. */
  item_count: number;
  /** How many items carry criteria — i.e. whether this is a roadmap at all.
   *  THE PROGRESS RULE, shipped by the API so no client invents its own:
   *  progress counts only these. Dividing by `item_count` is the silent wrong
   *  answer. Populated on the list AND the single read. */
  countable_items: number;
  /** How many countable items your record currently clears. "Currently" is
   *  load-bearing — mastery is derived, so this can go down.
   *
   *  **ZERO ON THE LIST RESPONSE.** It needs the per-curriculum evidence
   *  aggregate, which is not run once per row. Only meaningful on a single
   *  read — a list card that draws a progress bar from it is reading a
   *  placeholder, which is exactly the bug that shipped here once. */
  mastered_items: number;
  created_at: string;
  updated_at: string;
  /** Present on a single read, absent from the list. */
  items?: CurriculumItem[];
};

/** One item as the client sends it. Flattened to match the column names, and
 *  the library fields are absent because they are the catalog's. */
export type CurriculumItemWrite = {
  technique_id: string;
  notes?: string;
  target_scored?: number | null;
  target_defended?: number | null;
  target_sessions?: number | null;
  min_hit_rate?: number | null;
};

export type CurriculumWrite = {
  name?: string;
  description?: string;
  belt?: string | null;
  visibility?: Visibility;
  /** Omit to leave the list alone; `[]` empties it; a list replaces it. Three
   *  distinct states — collapsing the first two makes every metadata edit
   *  delete every item. */
  items?: CurriculumItemWrite[];
};

/** The shipped defaults, mirrored from the Go module so a builder can offer
 *  them without a round trip. Changing one here does NOT change the rule —
 *  the server decides — but they must not drift. */
export const CRITERIA_DEFAULTS = {
  target_scored: 25,
  target_defended: 8,
  target_sessions: 12,
  min_hit_rate: 0.35,
} as const;

export function listCurricula(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Curriculum[]> {
  return request<{ curricula: Curriculum[] }>(
    getToken,
    "/curricula",
    {},
    signal,
  ).then((b) => b.curricula ?? []);
}

/**
 * `tz` on every call that touches a date.
 *
 * Progress is measured from the enrollment date, and both ends of that
 * comparison used to resolve in the SERVER's zone — UTC in every deployed
 * environment. Enrolling at 22:00 in New York stamped TOMORROW, so the screen
 * reported progress "counted from" a date that had not happened and that
 * evening's training fell outside the window.
 */
/** The roadmaps you are actively on, with real progress — the list response's
 *  `mastered_items` is deliberately zero, this one's is not. */
export function listWorkingCurricula(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Curriculum[]> {
  return request<{ curricula: Curriculum[] }>(
    getToken,
    `/curricula/working?tz=${encodeURIComponent(localZone())}`,
    {},
    signal,
  ).then((b) => b.curricula ?? []);
}

export function getCurriculum(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<Curriculum> {
  return request<Curriculum>(
    getToken,
    `/curricula/${encodeURIComponent(id)}?tz=${encodeURIComponent(localZone())}`,
    {},
    signal,
  );
}

export function createCurriculum(
  getToken: Token,
  input: CurriculumWrite,
): Promise<Curriculum> {
  return request<Curriculum>(getToken, `/curricula?tz=${encodeURIComponent(localZone())}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCurriculum(
  getToken: Token,
  id: string,
  input: CurriculumWrite,
): Promise<Curriculum> {
  return request<Curriculum>(
    getToken,
    `/curricula/${encodeURIComponent(id)}?tz=${encodeURIComponent(localZone())}`,
    {
    method: "PATCH",
    body: JSON.stringify(input),
    },
  );
}

export async function deleteCurriculum(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/curricula/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * Sequences: the chain a class actually taught, in the order it flows.
 *
 * Distinct from a Curriculum, though both are ordered technique lists. A
 * curriculum's order is PEDAGOGICAL — learn this before that, over months. A
 * sequence's is CAUSAL: this move puts you where the next one starts, so
 * reordering it produces something that does not work on the mat. That is why
 * there are no criteria and no progress here — a chain is not a thing you
 * complete, and the mastery of its parts is already tracked per technique.
 */

export type SequenceStep = {
  technique_id: string;
  /** Resolved from the library on every read, never stored on the step — which
   *  is what makes a renamed technique read correctly everywhere. Absent from
   *  the write type for the same reason. */
  name: string;
  position: string;
  category: string;
  /** advance | reverse | escape | control | finish. Absent for the movement
   *  fundamentals, which genuinely have none.
   *
   *  LOAD-BEARING FOR RENDERING: it is what distinguishes a step that ENDS the
   *  exchange from one whose destination was simply never recorded. Both carry
   *  a null `ends_at_position_id`, and drawing them the same way tells the
   *  athlete a submission left them nowhere. */
  function?: string;
  /** Zero-based, assigned by the server from array order. */
  order: number;
  /** Where this step leaves you. Null means NOT RECORDED **or** ENDS THE
   *  EXCHANGE — see `function` for how to tell them apart. */
  ends_at_position_id: string | null;
  ends_at_position_name?: string;
  notes: string;
};

export type Sequence = {
  id: string;
  /** Whether the CALLER may change this — resolved server-side so no client
   *  compares user ids to decide whether to show an edit affordance. False
   *  only for VOLA-authored reference chains. */
  editable: boolean;
  name: string;
  description: string;
  start_position_id: string | null;
  start_position_name?: string;
  created_at: string;
  updated_at: string;
  /** On BOTH the list and the single read, so a card says "4 steps" without
   *  fetching them. */
  step_count: number;
  /** Absent on list responses, present on a single read. */
  steps?: SequenceStep[];
};

export type SequenceStepWrite = {
  technique_id: string;
  ends_at_position_id?: string | null;
  notes?: string;
};

export type SequenceWrite = {
  name?: string;
  description?: string;
  /** Omit to leave it alone; explicit `null` clears it. A single nullable
   *  field cannot express both, which is why the server keys off key
   *  PRESENCE rather than the value. */
  start_position_id?: string | null;
  /** Omit to leave the chain alone; `[]` clears it; a list replaces it
   *  wholesale. Three distinct states — collapsing the first two makes every
   *  rename delete every step. Replace-all rather than per-step patching
   *  because the ORDER is the content. */
  steps?: SequenceStepWrite[];
};

/** Mirrored from the Go module. The server decides; this exists so a builder
 *  can stop the athlete at the cap instead of showing them a 400. */
export const MAX_SEQUENCE_STEPS = 20;

export function listSequences(
  getToken: Token,
  signal?: AbortSignal,
): Promise<Sequence[]> {
  return request<{ sequences: Sequence[] }>(
    getToken,
    "/sequences",
    {},
    signal,
  ).then((b) => b.sequences ?? []);
}

export function getSequence(
  getToken: Token,
  id: string,
  signal?: AbortSignal,
): Promise<Sequence> {
  return request<Sequence>(
    getToken,
    `/sequences/${encodeURIComponent(id)}`,
    {},
    signal,
  );
}

export function createSequence(
  getToken: Token,
  input: SequenceWrite,
): Promise<Sequence> {
  return request<Sequence>(getToken, "/sequences", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSequence(
  getToken: Token,
  id: string,
  input: SequenceWrite,
): Promise<Sequence> {
  return request<Sequence>(getToken, `/sequences/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteSequence(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(getToken, `/sequences/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* ── Friends and sharing ─────────────────────────────────────────────────────
 *
 * Everyone is addressed by HANDLE, never by user id — the API does not accept
 * one and does not return one, so there is no id here to leak into a URL or a
 * log. Sharing is one surface for every shareable type: a `resource_type` and
 * a `resource_id`, so plans and workouts join it without a second client.
 */

export type FriendCard = {
  username: string;
  display_name: string | null;
  since: string;
};

export async function listFriends(
  getToken: Token,
  signal?: AbortSignal,
): Promise<FriendCard[]> {
  const body = await request<{ friends: FriendCard[] }>(
    getToken,
    "/friends",
    {},
    signal,
  );
  // `?? []` because null has a RESERVED meaning in the screens that call
  // this — it is the loading state — so a nil slice arriving from a future
  // server regression would render as a spinner that never resolves.
  return body.friends ?? [];
}

export type ShareCard = {
  id: string;
  resource_type: string;
  resource_label: string;
  /** The sender's handle, resolved live — a rename propagates. */
  from: string;
  created_at: string;
};

export async function listShareInbox(
  getToken: Token,
  signal?: AbortSignal,
): Promise<ShareCard[]> {
  const body = await request<{ shares: ShareCard[] }>(
    getToken,
    "/shares/inbox",
    {},
    signal,
  );
  return body.shares ?? [];
}

/** 409 means it is already sitting unanswered in their inbox; 404 covers
 *  "not your friend", "no such handle" and "not yours to send" alike. */
export async function shareResource(
  getToken: Token,
  toUsername: string,
  resourceType: string,
  resourceID: string,
): Promise<void> {
  await request<void>(getToken, "/shares", {
    method: "POST",
    body: JSON.stringify({
      to_username: toUsername,
      resource_type: resourceType,
      resource_id: resourceID,
    }),
  });
}

/** Returns the id of the RECIPIENT'S OWN new copy — never the sender's, which
 *  they cannot open. 410 means the sender deleted it before you accepted. */
export async function acceptShare(
  getToken: Token,
  shareID: string,
): Promise<{ resource_type: string; resource_id: string }> {
  return request(getToken, `/shares/${encodeURIComponent(shareID)}/accept`, {
    method: "POST",
  });
}

/** One verb for declining and for the sender taking it back. */
export async function dismissShare(
  getToken: Token,
  shareID: string,
): Promise<void> {
  await request<void>(getToken, `/shares/${encodeURIComponent(shareID)}`, {
    method: "DELETE",
  });
}

/** Idempotent, and it un-archives. `started_on` is NOT reset — it is when you
 *  first took it on, and every criterion is measured from it. */
export async function enrollInCurriculum(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(
    getToken,
    `/curricula/${encodeURIComponent(id)}/enrollment?tz=${encodeURIComponent(localZone())}`,
    { method: "PUT" },
  );
}

/** Archives rather than deletes: having worked a syllabus and stopped is a
 *  fact about the athlete. It does NOT mean completed. */
export async function archiveCurriculumEnrollment(
  getToken: Token,
  id: string,
): Promise<void> {
  await request<void>(
    getToken,
    `/curricula/${encodeURIComponent(id)}/enrollment`,
    { method: "DELETE" },
  );
}

/**
 * Name -> technique, for turning a cross-reference string into a link.
 *
 * `setup_from`, `common_next_moves` and `common_counters` store NAMES, not
 * ids, so rendering one as navigable means resolving it first.
 *
 * DUPLICATED in apps/mobile/lib/techniqueGraph.ts, for the reason the whole
 * search is: the two apps share no package and mobile needs its copy offline.
 * Keyed on `foldForSearch` so the two spellings of one name — `North-South
 * Control` with a hyphen against the en dash the catalog stores — do not
 * decide whether a row is navigable.
 *
 * Aliases second, so a real name always beats another entry's alias.
 */
export function buildEdgeIndex(
  techniques: TechniqueSummary[],
): Map<string, TechniqueSummary> {
  const byName = new Map<string, TechniqueSummary>();
  for (const t of techniques) {
    const k = foldForSearch(t.name);
    if (!byName.has(k)) byName.set(k, t);
  }
  for (const t of techniques) {
    for (const a of t.aliases ?? []) {
      const k = foldForSearch(a);
      if (!byName.has(k)) byName.set(k, t);
    }
  }
  return byName;
}

/**
 * Resolve one cross-reference, or null when it names something the library
 * does not contain.
 *
 * NULL IS THE COMMON CASE FOR SOME FIELDS AND THAT IS CORRECT. Measured over
 * the 542-entry catalog: `setup_from` resolves 84%, `common_next_moves` 31%,
 * `common_counters` 10%. The rest are concepts rather than techniques —
 * "Sprawl", "Crossface", "Stabilize top position" — and inventing library
 * entries for them would be worse than leaving them the prose they are.
 *
 * A self-reference resolves to null: a row that navigates to the panel it is
 * already in is a dead control that looks live.
 */
export function resolveEdge(
  index: Map<string, TechniqueSummary>,
  raw: string,
  selfID?: string,
): TechniqueSummary | null {
  const hit = index.get(foldForSearch(raw));
  if (!hit || hit.id === selfID) return null;
  return hit;
}
