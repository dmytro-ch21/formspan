import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The card's derived numbers, from `GET /v1/sessions/{id}/card`.
 *
 * Everything is nullable because every one of them has a legitimate absent
 * state, and absent is not zero: no score means "not enough history", not "you
 * scored nothing", and no calories means "we do not know your bodyweight"
 * rather than "you burned none".
 */
export type SessionCardNumbers = {
  calories: { kcal: number; precision: 'estimated' | 'coarse' } | null;
  score: { value: number; basis: 'effort' | 'volume'; compared: number } | null;
  detail: { name: string; figure?: string; outcome?: string; count?: number }[];
  more: number;
};

/**
 * ONLINE-ONLY, and failure is silent at the call site.
 *
 * These numbers decorate a card that is already complete without them — the
 * session, its duration, its volume and its PRs all come from the local store.
 * A gym dead-spot should cost the athlete the calorie figure, not the
 * celebration, so the caller renders what it has and never blocks on this.
 */
export async function getSessionCard(
  getToken: TokenGetter,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SessionCardNumbers> {
  return apiRequest<SessionCardNumbers>(
    getToken,
    `/sessions/${encodeURIComponent(sessionID)}/card`,
    { signal },
  );
}
