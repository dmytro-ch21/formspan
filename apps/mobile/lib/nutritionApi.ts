/**
 * The nutrition endpoints, as the phone sees them.
 *
 * A thin wire layer and nothing more: no caching, no merging, no local state.
 * `foodLog.ts` owns all of that, the same way `sessionStore.ts` owns it for
 * sessions and `body.ts` deliberately owns none of it for check-ins.
 *
 * Every write is a PUT on a CLIENT-GENERATED id, which is what makes an offline
 * retry safe — sending the same row twice is the same as sending it once.
 */

import { apiRequest } from './apiRequest';
import type { Entry, Food, Macros, Meal, Target } from './nutrition';
import type { TokenGetter } from './useAuthToken';

export type EntryInput = Macros & {
  eaten_on: string;
  meal: Meal;
  name: string;
  servings: number;
  serving_label: string;
  source_food_id?: string | null;
  notes?: string;
};

export type FoodInput = Macros & {
  kind?: 'food' | 'recipe';
  name: string;
  brand?: string;
  serving_label: string;
  serving_grams?: number | null;
};

export function listEntries(
  getToken: TokenGetter,
  range: { from: string; to: string },
): Promise<Entry[]> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return apiRequest<{ entries: Entry[] }>(getToken, `/nutrition/entries?${q}`).then(
    (b) => b.entries ?? [],
  );
}

export function saveEntry(getToken: TokenGetter, id: string, input: EntryInput): Promise<Entry> {
  return apiRequest<Entry>(getToken, `/nutrition/entries/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * Delete one entry.
 *
 * The server answers 204 whether or not the row was there, so this resolves for
 * a row somebody already removed from another device — which is exactly what an
 * outbox retry looks like.
 */
export function deleteEntry(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/entries/${id}`, { method: 'DELETE' });
}

export function listFoods(getToken: TokenGetter, q = ''): Promise<Food[]> {
  const query = new URLSearchParams(q ? { q } : {});
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<{ foods: Food[] }>(getToken, `/nutrition/foods${suffix}`).then(
    (b) => b.foods ?? [],
  );
}

export function saveFood(getToken: TokenGetter, id: string, input: FoodInput): Promise<Food> {
  return apiRequest<Food>(getToken, `/nutrition/foods/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * **No production caller yet** — there is no delete-a-saved-food affordance on
 * the phone. Kept because the wire layer mirrors the contract rather than the
 * screens built against it so far, and noted here so its absence reads as a
 * missing screen rather than as dead code somebody should tidy away.
 */
export function deleteFood(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/foods/${id}`, { method: 'DELETE' });
}

/**
 * The targets live over a window, PLUS the one live at its start.
 *
 * That carry-in row is why this is not just "the targets in these dates": a
 * target set three months ago means a week-long window has none of its own, and
 * without it the app would report "no target" for a week the athlete was very
 * much eating to one.
 */
export function listTargets(
  getToken: TokenGetter,
  range: { from: string; to: string },
): Promise<Target[]> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return apiRequest<{ targets: Target[] }>(getToken, `/nutrition/targets?${q}`).then(
    (b) => b.targets ?? [],
  );
}

/** The target live on a day: the newest row on or before it. */
export function targetOn(targets: Target[], on: string): Target | null {
  let best: Target | null = null;
  for (const t of targets) {
    if (t.effective_on <= on && (!best || t.effective_on > best.effective_on)) best = t;
  }
  return best;
}

/**
 * The arithmetic behind a target, computed but never written.
 *
 * `suggestion` is null when the profile cannot support a derivation, and
 * `missing` names the fields that would fix it. That is a 200, not a 400: the
 * request was fine, the profile is incomplete, and the client's remedy is a
 * form rather than a retry.
 */
export type Suggested = {
  suggestion: Suggestion | null;
  missing: string[];
  activities: string[];
};

export type Suggestion = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number;
  basis: Basis | null;
};

/** Every line the explanation screen renders, frozen onto the target on accept. */
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
   * phase's own rate, and whether that beats its deadline.
   *
   * **Null is the ordinary case**: no goal weight, or no live phase. Render
   * NOTHING for null — never an all-clear. "We did not check" and "it checks
   * out" are different answers and only one of them is reassuring, which is the
   * same rule that governs every other absent value in this module.
   *
   * Computed server-side so this app and web agree by construction rather than
   * by a parity script — the lesson N16 records for `offered_grips`.
   */
  projection: Projection | null;
};

export type Projection = {
  target_weight_kg: number;
  /** Unsigned — how far is left, whichever way the phase is going. */
  kg_to_go: number;
  /** `YYYY-MM-DD`, or '' when `unreachable`. Never a computed date in the past. */
  reached_on: string;
  weeks_to_go: number;
  /** Within 0.1 kg of the goal — a scale resolves no better than that. */
  already: boolean;
  /** The rate is zero, or points away from the goal. */
  unreachable: boolean;
  unreachable_reason?: string;
  deadline_on?: string;
  /** **Null when no deadline was set** — absent, not false. */
  meets_deadline: boolean | null;
  shortfall_kg?: number;
  days_late?: number;
};

export function suggestedTarget(
  getToken: TokenGetter,
  on: string,
  activity: string,
): Promise<Suggested> {
  const q = new URLSearchParams({ on, activity });
  return apiRequest<Suggested>(getToken, `/nutrition/targets/suggested?${q}`);
}

/**
 * Accept a target from a given date.
 *
 * The basis travels with it and is stored FROZEN. Recomputing an explanation on
 * read would be a lie about the past — weight, phase and training history all
 * move, so "why am I eating 2,410" must answer with the numbers that produced
 * it, not with today's.
 */
export function saveTarget(
  getToken: TokenGetter,
  date: string,
  body: {
    kcal: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    fibre_g: number | null;
    source: 'derived' | 'manual' | 'adjustment';
    basis: Basis | null;
  },
): Promise<Target> {
  return apiRequest<Target>(getToken, `/nutrition/targets/${date}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
