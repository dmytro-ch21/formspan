"use client";

import { newTraceId, traceparent } from "@/lib/trace";
import { formatWeight, type UnitSystem } from "@/lib/units";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

export type Sport = "strength" | "running" | "bjj";
export type Goal = "general" | "powerlifting" | "hypertrophy" | "endurance";
export type Visibility = "private" | "public";
export type LoadType = "weight_reps" | "reps" | "time" | "distance" | "distance_time";

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

export const SPORTS: { key: Sport; label: string }[] = [
  { key: "strength", label: "Strength" },
  { key: "bjj", label: "BJJ" },
  { key: "running", label: "Running" },
];

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

export function summariseTargets(i: WorkoutItem, units: UnitSystem = "metric"): string {
  const parts: string[] = [];
  if (i.target_sets && i.target_reps) parts.push(`${i.target_sets} × ${i.target_reps}`);
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

export function pickImage(e: Exercise, prefer: "thumbnail" | "demo"): string | null {
  const order = prefer === "thumbnail" ? ["thumbnail", "demo", "start"] : ["demo", "start", "thumbnail"];
  for (const kind of order) {
    const hit = e.media.find((m) => m.kind === kind && m.url);
    if (hit) return hit.url;
  }
  return null;
}

export type SetType = "warmup" | "working" | "backoff" | "drop" | "amrap" | "failure";

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


export type SuggestionCode =
  | "no_history"
  | "not_applicable"
  | "increase"
  | "repeat_hard"
  | "repeat_unknown_effort"
  | "repeat_stale"
  | "repeat_consolidate";

/**
 * What to load today, derived from what you actually did last time.
 *
 * The evidence travels with the recommendation on purpose — `last_*` is
 * always populated when there is history, even when the answer is "repeat
 * it". A number you can check beats a number you have to trust, and it is
 * the difference between a recommendation and an oracle.
 *
 * Branch on `code`; never pattern-match `reason`, which is prose.
 */
export type Suggestion = {
  exercise_id: string;
  last_performed_at: string | null;
  last_reps: number | null;
  last_weight_kg: number | null;
  last_rir: number | null;
  last_rpe: number | null;
  suggested_weight_kg: number | null;
  code: SuggestionCode;
  reason: string;
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

export function emptySet(exerciseID: string, position: number, from?: LoggedSet): LoggedSet {
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
  if (s.reps != null && s.weight_kg != null) parts.push(`${s.reps} × ${s.weight_kg}kg`);
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
  bjj_enabled: boolean;
  strength_enabled: boolean;
  nutrition_enabled: boolean;
  running_enabled: boolean;
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
  const b = await request<{ workouts: Workout[] }>(getToken, `/workouts?scope=${scope}`, {}, signal);
  return b.workouts ?? [];
}

export async function getWorkout(getToken: Token, id: string, signal?: AbortSignal): Promise<Workout> {
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}`, {}, signal);
}

export async function createWorkout(
  getToken: Token,
  input: { name: string; sport: Sport; goal: Goal | null; visibility: Visibility },
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
  return request<Workout>(getToken, `/workouts/${encodeURIComponent(id)}/items`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });
}

export async function deleteWorkout(getToken: Token, id: string): Promise<void> {
  await request<void>(getToken, `/workouts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchSuggestions(
  getToken: Token,
  exerciseIDs: string[],
  signal?: AbortSignal,
): Promise<Map<string, Suggestion>> {
  const unique = [...new Set(exerciseIDs)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const b = await request<{ suggestions: Suggestion[] }>(
    getToken,
    `/sessions/suggestions?exercise_ids=${encodeURIComponent(unique.join(","))}`,
    {},
    signal,
  );
  return new Map((b.suggestions ?? []).map((s) => [s.exercise_id, s]));
}

/**
 * Fills in the weight for sets that don't already carry one. A template's own
 * prescription always wins — it's an instruction, not a guess. Reps are left
 * alone: the plan owns those.
 */
export function applySuggestions(
  sets: LoggedSet[],
  suggestions: Map<string, Suggestion>,
): LoggedSet[] {
  return sets.map((s) => {
    if (s.weight_kg != null) return s;
    const hit = suggestions.get(s.exercise_id);
    const weight = hit?.suggested_weight_kg ?? null;
    return weight == null ? s : { ...s, weight_kg: weight };
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
  await request<void>(getToken, `/profile/exercise-units/${encodeURIComponent(exerciseID)}`, {
    method: "PUT",
    body: JSON.stringify({ unit_system: unit }),
  });
}

export function getProfile(getToken: Token, signal?: AbortSignal): Promise<Profile> {
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
    await request<Profile>(getToken, "/profile", { method: "POST", body: JSON.stringify({}) });
    return patch();
  }
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
  const b = await request<SessionPage>(getToken, `/sessions${sessionQS(opts)}`, {}, signal);
  return { sessions: b.sessions ?? [], total: b.total ?? 0, limit: b.limit ?? 0, offset: b.offset ?? 0 };
}

export async function listSessions(
  getToken: Token,
  opts: SessionQuery = {},
  signal?: AbortSignal,
): Promise<Session[]> {
  return (await listSessionsPage(getToken, opts, signal)).sessions;
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
  input: { sport: Sport; name: string; workout_id?: string | null; sets?: LoggedSet[] },
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

export async function deleteSession(getToken: Token, id: string): Promise<void> {
  await request<void>(getToken, `/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
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
