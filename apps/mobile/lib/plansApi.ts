import { ApiError, parseRetryAfterMs } from './apiError';
import { netFetch } from './authedFetch';
import { newTraceId, traceparent } from './trace';
import type { TokenGetter } from './useAuthToken';

/**
 * The wire half of the training plan — `/v1/plans`.
 *
 * Split from `lib/plan.ts` (the local store and the sync reconciliation) the
 * same way `lib/sessions.ts` is split from `lib/sessionStore.ts`: this module
 * knows the HTTP contract and nothing about SQLite.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/** A plan as the server sends it. `day` is a bare `YYYY-MM-DD`. */
export type RemotePlan = {
  id: string;
  user_id: string;
  day: string;
  sport: string;
  workout_id: string | null;
  /**
   * N442: a coach's class plan this day is scheduled from, instead of a
   * workout template — mutually exclusive with `workout_id` server-side.
   * Read-only from this client's point of view: mobile never sets it, only
   * reads it back on a pull. See `lib/plan.ts`'s `CREATE_PLANNED` comment.
   */
  class_plan_id: string | null;
  /**
   * N126/#520: minutes since local midnight, wall-clock, no timezone — see
   * `lib/plan.ts`'s `PlannedSession.timeOfDayMinutes` for the full contract.
   * `null` means no time was given.
   */
  time_of_day_minutes: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
};

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
    // An `ApiError`, never a plain `Error`. `isNotFound` and
    // `isPermanentRejection` both return false for anything that is not an
    // `ApiError`, so throwing a plain one here would make every classification
    // branch in the push path below dead code — a 404 on delete would not
    // count as success and the tombstone would fail forever, and a permanent
    // refusal would be retried for the life of the install. That is not
    // hypothetical: `lib/workouts.ts` carries a long comment about shipping
    // exactly this bug, and a mocked test hid it by supplying the contract the
    // real module did not honour.
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
      parseRetryAfterMs(res.headers?.get('Retry-After')),
    );
  }
  return body as T;
}

/** Plans in an inclusive day range. Both bounds are `YYYY-MM-DD`. */
export async function fetchPlans(
  getToken: TokenGetter,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<RemotePlan[]> {
  const q = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const body = await request<{ plans: RemotePlan[] }>(getToken, `/plans?${q}`, {}, signal);
  return body.plans ?? [];
}

/**
 * Create one, with the id the device already stored.
 *
 * The id is ours, not the server's — that is what makes a retried push
 * idempotent rather than a second plan, and it is why the local row can be
 * referred to before any server has seen it.
 */
export async function createPlan(
  getToken: TokenGetter,
  input: {
    id: string;
    day: string;
    sport: string;
    workout_id: string | null;
    time_of_day_minutes: number | null;
    notes: string;
  },
): Promise<RemotePlan> {
  return request<RemotePlan>(getToken, '/plans', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Update one.
 *
 * `workout_id` is three-state on the wire: absent leaves it, a string sets it,
 * an explicit `null` clears it. This client always sends the full triple
 * because it is reconciling a whole local row rather than patching one field.
 */
export async function updatePlan(
  getToken: TokenGetter,
  id: string,
  input: {
    day: string;
    sport: string;
    workout_id: string | null;
    time_of_day_minutes: number | null;
    notes: string;
  },
): Promise<RemotePlan> {
  return request<RemotePlan>(getToken, `/plans/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deletePlan(getToken: TokenGetter, id: string): Promise<void> {
  await request<void>(getToken, `/plans/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
