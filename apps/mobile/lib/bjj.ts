import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * BJJ rank, client half of `internal/modules/bjj`.
 *
 * `current` on {@link Standing} is DERIVED server-side from `promotions`, not
 * stored — see the backend's `StandingFrom`. This client never computes a
 * rank itself, for the same reason the server doesn't let a date decide it:
 * two independent derivations are two chances to disagree.
 */
export type Belt = 'white' | 'blue' | 'purple' | 'brown' | 'black';

/** Belts, in rank order — for a picker that doesn't hardcode the list again. */
export const BELTS: Belt[] = ['white', 'blue', 'purple', 'brown', 'black'];

export const MAX_STRIPES = 4;
export const MAX_DEGREE = 6;

export type Rank = {
  belt: Belt;
  stripes: number;
  /** Black-belt degrees. 0 on every other belt. */
  degree: number;
};

/** What the add/edit form sends — a Rank plus the promotion's own facts. */
export type PromotionInput = Rank & {
  /** "YYYY-MM-DD", or null when the athlete doesn't remember. */
  promoted_on: string | null;
  academy: string;
  instructor: string;
  note: string;
};

export type Promotion = PromotionInput & {
  id: string;
  created_at: string;
  updated_at: string;
};

export type Standing = {
  /** Null means no rank recorded — a real state, not a loading placeholder. */
  current: Rank | null;
  time_at_current_days: number | null;
  promotions: Promotion[];
};

export function getStanding(getToken: TokenGetter): Promise<Standing> {
  return apiRequest<Standing>(getToken, '/bjj/standing');
}

export function createPromotion(
  getToken: TokenGetter,
  input: PromotionInput,
): Promise<Promotion> {
  return apiRequest<Promotion>(getToken, '/bjj/promotions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePromotion(
  getToken: TokenGetter,
  id: string,
  input: PromotionInput,
): Promise<Promotion> {
  return apiRequest<Promotion>(getToken, `/bjj/promotions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deletePromotion(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/bjj/promotions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * The obvious next step from a current rank — one more stripe, or the next
 * belt once a stripe run is full.
 *
 * A suggestion for the add-promotion form to start from, not a value the
 * server ever sees or trusts: the athlete can change every field before
 * saving, and a jump (three stripes to a new belt, say) is exactly the case
 * this exists to make one tap instead of five.
 *
 * Black is degrees, not stripes — advancing past `MAX_DEGREE` has nowhere
 * further to go, so it holds rather than wrapping to white.
 */
export function nextRank(current: Rank): Rank {
  if (current.belt === 'black') {
    return { belt: 'black', stripes: 0, degree: Math.min(current.degree + 1, MAX_DEGREE) };
  }
  if (current.stripes < MAX_STRIPES) {
    return { belt: current.belt, stripes: current.stripes + 1, degree: 0 };
  }
  const next = BELTS[Math.min(BELTS.indexOf(current.belt) + 1, BELTS.length - 1)];
  return { belt: next, stripes: 0, degree: 0 };
}

/**
 * "3 years", "6 months", "12 days" — the coarsest unit that doesn't round to
 * zero. Matches how a grappler actually states time at a belt; nobody says
 * "1,097 days".
 */
export function describeTimeAtBelt(days: number): string {
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} ${years === 1 ? 'year' : 'years'}`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} ${months === 1 ? 'month' : 'months'}`;
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
