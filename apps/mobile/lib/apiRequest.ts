import { ApiError } from './apiError';
import { API_BASE, netFetch, type NetFetchOptions } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import { newTraceId, traceparent } from './trace';

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
  opts: NetFetchOptions = {},
): Promise<T> {
  const token = await getToken();

  // `Content-Type` is set for every body EXCEPT FormData, where it must be
  // left to the runtime.
  //
  // A multipart body's Content-Type carries a generated boundary token, and
  // fetch appends it only when it is the one writing the header. Setting the
  // header by hand yields `multipart/form-data` with no boundary, which the
  // server cannot parse — and the failure reads as a malformed upload rather
  // than as a missing header, so it gets diagnosed on the wrong side of the
  // wire. Two FormData bodies now: the meal photo and the machine photo (N44).
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;

  const res = await netFetch(
    `${API_BASE}${path}`,
    {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        ...(isForm ? null : { 'Content-Type': 'application/json' }),
        traceparent: traceparent(newTraceId()),
      },
    },
    opts,
  );

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
