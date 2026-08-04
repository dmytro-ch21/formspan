"use client";

import { newTraceId, traceparent } from "@/lib/trace";
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
 * Ranks stand-ins for `base`. Deterministic and explainable by design — the
 * same movement pattern *and* load type is a true substitute (it slots into
 * the same set and the numbers still mean something); one of the two is a
 * weaker suggestion; neither isn't a recommendation at all.
 */
export function similarTo(base: Exercise, all: Exercise[]): Exercise[] {
  const score = (e: Exercise): number => {
    if (e.id === base.id) return -1;
    const pattern = e.movement_pattern === base.movement_pattern;
    const shape = e.load_type === base.load_type;
    if (pattern && shape) return 3;
    if (pattern) return 2;
    // A shared load type alone says nothing — every barbell lift is
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
 * these as one-tap rows instead of asking anyone to search 466 library entries
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
   * the baseline; counting marks ~130 ordinary techniques as restricted when
   * only 20 are.
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
 * 466 summaries are ~65 KB; full rows would be ~274 KB and carry prose no grid
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
 * Local search across name, aliases and position.
 *
 * Aliases matter more than they look: half this library is known by two names,
 * and someone searching "scarf hold" will never find "Kesa-Gatame Escape"
 * without them.
 */
export function searchTechniques(
  list: TechniqueSummary[],
  query: string,
): TechniqueSummary[] {
  const q = foldForSearch(query.trim());
  if (!q) return list;
  return list.filter((t) => haystack(t).includes(q));
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
 * is duplicated four ways. Change one, change the other: nothing enforces it,
 * `verify` runs no web tests, and a silent divergence here is invisible.
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

/**
 * Folded haystacks, cached per technique object.
 *
 * Search runs on every keystroke over the whole 466-entry library. Folding
 * name + aliases + position each time is 1592 fold calls per character typed,
 * measured at 0.774 ms uncached against 0.029 ms cached.
 *
 * A WeakMap keyed on the technique object is what makes this safe: the catalog
 * objects are built once in listTechniques and never written to, so a refetch
 * makes new objects and the stale entries are collected with them. That
 * immutability is the load-bearing assumption and it is a CONVENTION, not
 * something enforced — mutate a summary in place and search silently keeps
 * answering from the pre-mutation text. Build a new object instead.
 */
const foldedCache = new WeakMap<object, string>();

function haystack(t: TechniqueSummary): string {
  const hit = foldedCache.get(t);
  if (hit !== undefined) return hit;
  // Joined with a separator so a query cannot match across two fields.
  const built = [
    foldForSearch(t.name),
    ...t.aliases.map(foldForSearch),
    foldForSearch(t.position),
  ].join("\n");
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
 * Measured across all 466 before being built on: 458 (98%) split into 2+ steps,
 * clustered at 3–4, averaging 30 characters each. The remaining 8 return `[]`
 * and the caller renders the original prose — a one-item numbered list looks
 * like a bug.
 *
 * Kept byte-identical to the mobile implementation in
 * `apps/mobile/lib/techniques.ts`; the two screens must not disagree about
 * where a step ends.

 * The split deliberately avoids a lookbehind. `(?<=\.)\s+` fired on zero of
 * 466 (trailing periods are stripped anyway), and on web `lib/api.ts` is
 * imported by every dashboard page — a regex literal Next/SWC does not
 * transpile, so an unsupported feature is a parse-time SyntaxError that takes
 * the whole dashboard down on Safari/iOS < 16.4. `\.\s+` is byte-identical on
 * this corpus and carries no engine-support risk.
 *
 * `;` joins the split for the same reason `,` does: 6 of the 8 prose fallbacks
 * were semicolon-joined instruction pairs.
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
