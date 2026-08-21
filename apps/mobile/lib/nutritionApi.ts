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
  /**
   * How this row was produced (N114).
   *
   * Only `user` and `ai` may be sent — the server answers 400 for anything
   * else, because `usda` and `off` are written by the importers that fetch
   * them and a client able to claim or strip `off` would undo the ODbL
   * separation that value exists for.
   *
   * **Omitting it on an update KEEPS what the server has stored**, and is
   * therefore the right thing to send when a screen has no opinion — not
   * `'user'`, which is a positive claim that would relabel an AI-drafted food
   * as one the athlete measured. On a new row, omitting it means `user`.
   */
  source?: 'user' | 'ai';
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
): Promise<StoredTarget[]> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return apiRequest<{ targets: StoredTarget[] }>(getToken, `/nutrition/targets?${q}`).then(
    (b) => b.targets ?? [],
  );
}

/**
 * A target as the SERVER sends one, which is `Target` plus its frozen basis.
 *
 * `Target` itself omits `basis` because the local SQLite cache has no column
 * for it, and most of this app only ever wants the numbers. But a screen that
 * DELETES a row has to be able to put back exactly what it removed, and a
 * restore that quietly dropped a derived target's arithmetic would strip an
 * explanation the athlete never chose to discard — the same loss the edit path
 * warns about, arriving through an undo button.
 *
 * Assignable to `Target`, so widening these two return types changes nothing
 * for any existing caller.
 */
export type StoredTarget = Target & { basis?: Basis | null };

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
  /**
   * The level this derivation actually ran at, and whether the athlete chose
   * it — see `lib/activityLevel.ts`.
   *
   * Top level rather than read off `suggestion.basis`, which carries the same
   * value: `basis` is null for an incomplete profile, and that athlete still
   * has a level to show and change. Reading it off the basis leaves the pills
   * unrenderable in exactly the state the rest of the screen is telling them to
   * go and fix.
   *
   * Optional on the TYPE only, so a response from a server predating N93 still
   * parses — `adoptServerActivity` treats an absent or unrecognised value as
   * "learned nothing" rather than as a choice.
   */
  activity?: string | null;
  activity_chosen?: boolean | null;
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

/**
 * Derive a target for `on`.
 *
 * **`activity` is an OVERRIDE and omitting it is the normal case.** With no
 * parameter the server derives at whatever the athlete has stored on their
 * profile, falling back to the documented default, and reports both back — which
 * is the only path by which a level chosen in the browser reaches this phone.
 * Sending one pins the derivation to it without writing anything.
 *
 * It used to be required, defaulting to a `useState('light')` the screen reset
 * on every navigation. That is N93: the parameter was the ONLY place the level
 * existed, so it could not survive leaving the tab, and the target moved with
 * it.
 */
export function suggestedTarget(
  getToken: TokenGetter,
  on: string,
  activity?: string,
): Promise<Suggested> {
  const q = new URLSearchParams({ on });
  // Appended conditionally: `new URLSearchParams({ on, activity })` with an
  // undefined activity serialises the STRING "undefined", which the server
  // rejects as an unknown level — a 400 on every request, from a value nobody
  // typed.
  if (activity) q.set('activity', activity);
  return apiRequest<Suggested>(getToken, `/nutrition/targets/suggested?${q}`);
}

/** Every line the weekly proposal shows its working with. */
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
  /** What the arithmetic asked for BEFORE the step cap and the resting floor.
   *  Shown when it was capped, so the last line reads as "we stopped here"
   *  rather than as arithmetic that does not follow. */
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

/**
 * A withheld proposal is the ORDINARY outcome, and a 200.
 *
 * Each of these is a normal state rather than an error, so the client's job is
 * to say what would unblock it — never to retry, and never to apologise.
 */
export type BlockedBy =
  | 'no_target'
  | 'no_phase'
  | 'too_soon'
  | 'not_logging'
  | 'not_weighing'
  | 'on_track';

export type AdjustmentResponse = {
  adjustment: Adjustment | null;
  blocked_by: BlockedBy[];
};

/**
 * The weekly adjustment proposal, or the reasons it was withheld.
 *
 * Never an error and never a write. Accepting is an ordinary {@link saveTarget}
 * with `source: 'adjustment'` against the proposal's own `effective_on`;
 * declining is sending nothing, because no dismissal is stored.
 */
export function fetchAdjustment(getToken: TokenGetter, on: string): Promise<AdjustmentResponse> {
  const q = new URLSearchParams({ on });
  return apiRequest<AdjustmentResponse>(getToken, `/nutrition/targets/adjustment?${q}`);
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
): Promise<StoredTarget> {
  return apiRequest<StoredTarget>(getToken, `/nutrition/targets/${date}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Remove the target set on a date.
 *
 * Not an undo of the last write — an undo of a ROW. Because the date is the
 * identity, this is the only way a target filed under the wrong DAY comes back
 * out of the record: typing over one can fix its numbers and never its date.
 *
 * **The phone is the first surface anywhere with a caller for this.**
 * `apps/web` has carried the same function in its wire layer since the endpoint
 * landed and calls it from nowhere, so the audit row listing deletion as
 * web-only was describing the contract rather than the product — it was
 * available on neither. What a delete costs, and how it is offered back, is
 * `lib/targetHistory.ts`'s `deletionEffect` and `app/goals/history.tsx`.
 *
 * 204 whether or not the row was there, so a retry against a row another device
 * already removed resolves rather than 404-ing.
 */
export function deleteTarget(getToken: TokenGetter, date: string): Promise<void> {
  return apiRequest<void>(getToken, `/nutrition/targets/${date}`, { method: 'DELETE' });
}
