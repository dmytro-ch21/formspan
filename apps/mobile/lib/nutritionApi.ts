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
