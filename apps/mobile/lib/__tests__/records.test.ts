/**
 * N84 — `fetchLoadHistory` is the mobile client's first caller of
 * `GET /v1/records/{exerciseID}/history`. Pins the request shape against
 * `apps/web/src/lib/api.ts`'s `fetchLoadHistory`, which this mirrors.
 */

import { fetchLoadHistory } from '../records';

const mockFetch = jest.fn();
jest.mock('../authedFetch', () => ({
  ...jest.requireActual('../authedFetch'),
  netFetch: (...a: unknown[]) => mockFetch(...a),
}));
jest.mock('../trace', () => ({ newTraceId: () => 't', traceparent: () => 'tp' }));

const token = async () => 'tok';

function respond(body: unknown) {
  mockFetch.mockResolvedValue({ status: 200, ok: true, json: async () => body });
}

beforeEach(() => mockFetch.mockReset());

describe('fetchLoadHistory', () => {
  it('requests the exercise-scoped history route, tz included', async () => {
    respond({ exercise_id: 'back-squat', load_type: 'weight_reps', points: [] });
    await fetchLoadHistory(token, 'back-squat', { tz: 'America/Los_Angeles' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/records/back-squat/history?');
    expect(url).toContain('tz=America%2FLos_Angeles');
  });

  it('encodes an exercise id that needs it', async () => {
    respond({ exercise_id: 'a b', load_type: 'weight_reps', points: [] });
    await fetchLoadHistory(token, 'a b', { tz: 'UTC' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/records/a%20b/history?');
  });

  it('carries from/to through as query params when given', async () => {
    respond({ exercise_id: 'back-squat', load_type: 'weight_reps', points: [] });
    await fetchLoadHistory(token, 'back-squat', { from: '2026-01-01', to: '2026-02-01', tz: 'UTC' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-02-01');
  });

  it('resolves to the parsed history on success', async () => {
    const history = {
      exercise_id: 'back-squat',
      load_type: 'weight_reps',
      points: [{ session_id: 's1', started_at: '2026-08-01T10:00:00Z', top_weight_kg: 100 }],
    };
    respond(history);
    const r = await fetchLoadHistory(token, 'back-squat', { tz: 'UTC' });
    expect(r.points).toHaveLength(1);
  });
});
