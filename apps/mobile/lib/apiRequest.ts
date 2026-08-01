import { ApiError } from './apiError';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * One authenticated JSON request, throwing the house `ApiError`.
 *
 * Extracted because this was about to become a third hand-rolled copy of the
 * same twelve lines. The copies had already drifted: the newest one threw a
 * bare `Error`, which `apiError.ts` explicitly forbids — "every module that
 * talks to the API should throw this rather than a bare Error. A plain Error
 * forces callers to pattern-match on the message, which is exactly what the
 * API conventions forbid." That drift cost a real bug once before, in the two
 * error classifiers that disagreed about 401.
 *
 * Keeps the server's message and, more importantly, its error *code* — codes
 * are contract, messages are not.
 */
export async function apiRequest<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();

  const res = await netFetch(`${API_BASE}${path}`, {
    ...init,
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
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
    );
  }
  return body as T;
}
