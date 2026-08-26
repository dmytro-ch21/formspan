/**
 * N62 — `fetchExercises` used to hand-roll its failure into a bare `Error`
 * while `fetchExercise` (singular, added by N47) went through `apiRequest`
 * and threw `ApiError`. Same file, two different answers to "the request
 * failed" — exactly what `apiError.ts` says having two copies produces.
 *
 * This pins the fix at the unit level: the request shape (still filtered by
 * sport/q, still going to `/exercises`) and the error identity (`ApiError`
 * for a real response, `OfflineError` for no answer at all) rather than a
 * bare `Error` either way.
 */

import { ApiError, OfflineError } from '../apiError';
import { fetchExercises } from '../exercises';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

const SQUAT = {
  id: 'back-squat',
  name: 'Back Squat',
  sport: 'strength',
  movement_pattern: 'squat',
  primary_muscles: ['quads'],
  secondary_muscles: [],
  equipment: ['barbell'],
  load_type: 'weight_reps',
  is_unilateral: false,
  instructions: '',
  media: [],
};

beforeEach(() => mockApi.mockReset());

describe('fetchExercises', () => {
  it('asks the exercises route with no query string when the filter is empty', async () => {
    mockApi.mockResolvedValue({ exercises: [] });
    await fetchExercises(getToken, {});
    expect(mockApi).toHaveBeenCalledWith(getToken, '/exercises', { signal: undefined }, undefined);
  });

  it('carries sport and q through as query params', async () => {
    mockApi.mockResolvedValue({ exercises: [] });
    await fetchExercises(getToken, { sport: 'strength', q: 'squat' });
    expect(mockApi).toHaveBeenCalledWith(
      getToken,
      '/exercises?sport=strength&q=squat',
      { signal: undefined },
      undefined,
    );
  });

  it('returns the exercises', async () => {
    mockApi.mockResolvedValue({ exercises: [SQUAT] });
    expect(await fetchExercises(getToken, {})).toEqual([SQUAT]);
  });

  it('returns an empty list rather than throwing when the envelope has none', async () => {
    mockApi.mockResolvedValue({});
    expect(await fetchExercises(getToken, {})).toEqual([]);
  });

  /**
   * The point of the ticket. A bare `Error` carries no status or code, so a
   * caller cannot tell "the server rejected this" from "nothing answered" —
   * `apiRequest` is what gives that back, and this is what would have failed
   * on the old implementation (it threw a plain `Error` for any non-ok
   * response instead of preserving `ApiError`'s status/code).
   */
  it('throws ApiError, carrying the status and code, for a real server response', async () => {
    mockApi.mockRejectedValue(new ApiError('exercise catalog unavailable', 'internal', 500));
    const err = await fetchExercises(getToken, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('internal');
  });

  /** No answer at all is a different thing than a real rejection, and stays that way. */
  it('propagates OfflineError rather than collapsing it into a generic Error', async () => {
    mockApi.mockRejectedValue(new OfflineError());
    await expect(fetchExercises(getToken, {})).rejects.toBeInstanceOf(OfflineError);
  });

  it('forwards the abort signal and net options through to apiRequest', async () => {
    mockApi.mockResolvedValue({ exercises: [] });
    const controller = new AbortController();
    const opts = { timeoutMs: 5000 };
    await fetchExercises(getToken, {}, controller.signal, opts);
    expect(mockApi).toHaveBeenCalledWith(
      getToken,
      '/exercises',
      { signal: controller.signal },
      opts,
    );
  });
});
