"use client";

import { apiRequest, type Token } from "@/lib/api";

/**
 * The nutrition endpoints, as the web app sees them.
 *
 * A wire layer and nothing else — no caching, no merging, no local state. It
 * mirrors `apps/mobile/lib/nutritionApi.ts` field for field on purpose: the
 * two apps read the same contract, and a type that drifts on one side is a bug
 * that only shows up on the other.
 *
 * **Every macro is a float and every target number is a whole calorie,** which
 * is the Go types showing through and is not worth "tidying": an entry records
 * what a label said, a target is a decision somebody made, and decisions are
 * made in round numbers.
 */

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export type FoodKind = "food" | "recipe";
export type TargetSource = "derived" | "manual" | "adjustment";

/**
 * `fibre_g` is nullable and the others are not, and the difference carries
 * meaning: zero fat is a measurement, an unstated fibre is silence. Averaging
 * silence as zero drags every fibre figure down, which is why the server keeps
 * it a pointer all the way to the wire.
 */
export type Macros = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
};

export type Entry = Macros & {
  id: string;
  user_id: string;
  eaten_on: string;
  meal: Meal;
  name: string;
  servings: number;
  serving_label: string;
  /** Provenance only. NOTHING reads nutrition back through it — see the Go
   *  package doc: a logged row owns its numbers, so correcting a saved food
   *  must never rewrite what a past day says you ate. */
  source_food_id: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type EntryInput = Macros & {
  eaten_on: string;
  meal: Meal;
  name: string;
  servings: number;
  serving_label: string;
  source_food_id?: string | null;
  notes?: string;
};

export type RecipeItemInput = Macros & {
  name: string;
  quantity: number;
  serving_label: string;
  source_food_id?: string | null;
};

export type RecipeItem = RecipeItemInput & {
  source_food_id: string | null;
};

export type Food = Macros & {
  id: string;
  user_id: string;
  kind: FoodKind;
  name: string;
  brand: string;
  serving_label: string;
  /** Null where a serving has no honest gram weight — an egg, a scoop. */
  serving_grams: number | null;
  /** Set for a recipe, absent for a food. The server enforces the
   *  biconditional, so sending one without the other is a 400. */
  yield_servings: number | null;
  items: RecipeItem[];
  source: string;
  external_id: string | null;
  barcode: string | null;
  created_at: string;
  updated_at: string;
};

export type FoodInput = Macros & {
  kind: FoodKind;
  name: string;
  brand?: string;
  serving_label: string;
  serving_grams?: number | null;
  yield_servings?: number | null;
  items?: RecipeItemInput[];
};

export type Basis = {
  rmr_kcal: number;
  rmr_precision: string;
  weight_kg: number;
  weight_measured_on: string;
  activity: string;
  activity_factor: number;
  neat_kcal: number;
  training_kcal_per_day: number;
  training_days_covered: number;
  training_sessions: number;
  tdee_kcal: number;
  phase_kind: string;
  target_rate_pct_per_week: number;
  target_rate_kg_per_week: number;
  kcal_per_kg: number;
  energy_delta_kcal: number;
  clamped: boolean;
  clamp_reason?: string;
  relaxed?: string;
  protein_g_per_kg: number;
  fat_g_per_kg: number;

  /**
   * "Does this look right?" — when the phase's goal weight arrives at this
   * rate, and whether that beats its deadline.
   *
   * **Null is the ordinary case** (no goal weight, no live phase) and must
   * render as NOTHING, never an all-clear: "we did not check" and "it checks
   * out" are different answers.
   *
   * Computed server-side, so this and the phone agree by construction rather
   * than by a parity script.
   */
  projection: Projection | null;
};

export type Projection = {
  target_weight_kg: number;
  /** Unsigned — how far is left, whichever way the phase is going. */
  kg_to_go: number;
  /** `YYYY-MM-DD`, or "" when `unreachable`. Never a date in the past. */
  reached_on: string;
  weeks_to_go: number;
  already: boolean;
  unreachable: boolean;
  unreachable_reason?: string;
  deadline_on?: string;
  /** **Null when no deadline was set** — absent, not false. */
  meets_deadline: boolean | null;
  shortfall_kg?: number;
  days_late?: number;
};

export type Target = {
  user_id: string;
  effective_on: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
  source: TargetSource;
  /** The arithmetic that produced this target, FROZEN when it was accepted.
   *  Absent for a typed number, which has none to show. Never recomputed on
   *  read — weight and phase both move, so a live explanation would be a
   *  confident lie about a past decision. */
  basis?: Basis | null;
  created_at: string;
  updated_at: string;
};

export type DayTotals = Macros & {
  eaten_on: string;
  entries: number;
  target_kcal: number | null;
  target_protein_g: number | null;
};

export type Suggestion = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number;
  basis: Basis | null;
};

/** An incomplete profile is a 200 with a null suggestion and the field names
 *  that would fix it — not a 400. The request was fine; the remedy is a form. */
export type Suggested = {
  suggestion: Suggestion | null;
  missing: string[];
  activities: string[];
};

export type AdjustmentBasis = {
  observed_kg_per_week: number;
  observed_pct_per_week: number;
  target_kg_per_week: number;
  target_pct_per_week: number;
  trend_weight_kg: number;
  earlier_trend_weight_kg: number;
  weighins_recent_half: number;
  weighins_earlier_half: number;
  days_logged: number;
  days_considered: number;
  days_on_current_target: number;
  kcal_per_kg: number;
  /** What the arithmetic asked for, BEFORE the step cap and the resting floor.
   *  Shown so a capped proposal reads as "we stopped here" rather than as
   *  arithmetic whose last line does not follow. */
  raw_delta_kcal: number;
  capped: boolean;
  cap_reason?: string;
  relaxed?: string;
  protein_g_per_kg: number;
  fat_g_per_kg: number;
};

export type Adjustment = {
  from_kcal: number;
  to_kcal: number;
  delta_kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number;
  /** TOMORROW, never today — a target applied retroactively would judge a day
   *  already mostly eaten, and the remaining figure would jump under you. */
  effective_on: string;
  basis: AdjustmentBasis | null;
};

/** A withheld proposal is the ORDINARY outcome, and a 200. Each of these is a
 *  normal state, not an error, and the client's job is to say what would
 *  unblock it rather than to retry. */
export type BlockedBy =
  | "no_target"
  | "no_phase"
  | "too_soon"
  | "not_logging"
  | "not_weighing"
  | "on_track";

export type AdjustmentResponse = {
  adjustment: Adjustment | null;
  blocked_by: BlockedBy[];
};

/**
 * Body check-ins, read-only, and they live here rather than in a `body.ts`
 * this app does not have.
 *
 * Web has no check-in screens — weighing yourself is a phone-by-the-scale
 * thing and the platform split leaves it there. The analytical surface is the
 * only web consumer of a weigh-in, and it needs them for exactly one purpose:
 * the second axis. When web grows a body screen this moves out; until then a
 * whole module for one GET would be a file nobody can explain.
 */
export type Checkin = {
  user_id: string;
  measured_on: string;
  weight_kg: number | null;
  notes: string;
};

// ------------------------------------------------------------------ entries

export async function listEntries(
  getToken: Token,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<{ entries: Entry[]; meals: Meal[] }> {
  const q = new URLSearchParams(range);
  const b = await apiRequest<{ entries: Entry[]; meals: Meal[] }>(
    getToken,
    `/nutrition/entries?${q}`,
    {},
    signal,
  );
  // `?? []` at the parse boundary, the house rule: a drifted server omitting
  // the field would otherwise hand `undefined` to a `.map` inside a render.
  return { entries: b.entries ?? [], meals: b.meals ?? [] };
}

/**
 * Create or correct one entry.
 *
 * A PUT on a CLIENT-GENERATED id, same as the phone. Web has no outbox, so
 * idempotency buys less here — but the contract is the contract, and a web
 * correction has to be indistinguishable from a phone one or a row's history
 * would depend on which screen touched it last.
 */
export function saveEntry(
  getToken: Token,
  id: string,
  input: EntryInput,
): Promise<Entry> {
  return apiRequest<Entry>(getToken, `/nutrition/entries/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** 204 whether or not the row was there. Deleting something already gone is a
 *  success, not a 404 to surface. */
export function deleteEntry(getToken: Token, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/entries/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * The day roll-up.
 *
 * **Only days that have entries come back.** That is the server being honest,
 * and it is what `nutritionSeries.ts` builds the gaps from — do not fill the
 * missing dates in here.
 */
export async function listDays(
  getToken: Token,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<DayTotals[]> {
  const q = new URLSearchParams(range);
  const b = await apiRequest<{ days: DayTotals[] }>(
    getToken,
    `/nutrition/days?${q}`,
    {},
    signal,
  );
  return b.days ?? [];
}

// -------------------------------------------------------------------- foods

export async function listFoods(
  getToken: Token,
  q = "",
  signal?: AbortSignal,
): Promise<Food[]> {
  const query = new URLSearchParams(q ? { q } : {});
  const suffix = query.toString() ? `?${query}` : "";
  const b = await apiRequest<{ foods: Food[] }>(
    getToken,
    `/nutrition/foods${suffix}`,
    {},
    signal,
  );
  return b.foods ?? [];
}

export function saveFood(getToken: Token, id: string, input: FoodInput): Promise<Food> {
  return apiRequest<Food>(getToken, `/nutrition/foods/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteFood(getToken: Token, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/foods/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ------------------------------------------------------------------ targets

/**
 * The targets over a window, PLUS the one live at its start.
 *
 * That carry-in row is the whole reason this is not "the targets in these
 * dates": a target set three months ago means a month-long window contains
 * none of its own, and without it every day would render as untargeted.
 */
export async function listTargets(
  getToken: Token,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<Target[]> {
  const q = new URLSearchParams(range);
  const b = await apiRequest<{ targets: Target[] }>(
    getToken,
    `/nutrition/targets?${q}`,
    {},
    signal,
  );
  return b.targets ?? [];
}

export function suggestedTarget(
  getToken: Token,
  on: string,
  activity: string,
  signal?: AbortSignal,
): Promise<Suggested> {
  const q = new URLSearchParams({ on, activity });
  return apiRequest<Suggested>(
    getToken,
    `/nutrition/targets/suggested?${q}`,
    {},
    signal,
  );
}

/**
 * The weekly adjustment proposal, or the reasons it was withheld.
 *
 * Never an error and never a write. Accepting is an ordinary `saveTarget` with
 * `source: "adjustment"`; declining is sending nothing, because no dismissal
 * is stored.
 */
export function fetchAdjustment(
  getToken: Token,
  on: string,
  signal?: AbortSignal,
): Promise<AdjustmentResponse> {
  const q = new URLSearchParams({ on });
  return apiRequest<AdjustmentResponse>(
    getToken,
    `/nutrition/targets/adjustment?${q}`,
    {},
    signal,
  );
}

export function saveTarget(
  getToken: Token,
  date: string,
  body: {
    kcal: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    fibre_g: number | null;
    source: TargetSource;
    /** Travels with the target and is stored FROZEN. Null for a typed one. */
    basis: Basis | null;
  },
): Promise<Target> {
  return apiRequest<Target>(getToken, `/nutrition/targets/${encodeURIComponent(date)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteTarget(getToken: Token, date: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/targets/${encodeURIComponent(date)}`, {
    method: "DELETE",
  });
}

// ----------------------------------------------------------------- check-ins

export async function listCheckins(
  getToken: Token,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<Checkin[]> {
  const q = new URLSearchParams(range);
  const b = await apiRequest<{ checkins: Checkin[] }>(
    getToken,
    `/body/checkins?${q}`,
    {},
    signal,
  );
  return b.checkins ?? [];
}
