/**
 * N84 — `fetchLoadHistory` is the mobile client's first caller of
 * `GET /v1/records/{exerciseID}/history`. Pins the request shape against
 * `apps/web/src/lib/api.ts`'s `fetchLoadHistory`, which this mirrors.
 */

import {
  describeEvidence,
  fetchLoadHistory,
  formatRecord,
  RECORD_LABEL,
  type PersonalRecord,
} from '../records';

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

/**
 * N462 — `RecordsCard` was already generic (`RECORD_LABEL[kind]` +
 * `formatRecord(record, units)`, no strength-only branch anywhere in that
 * component), so a `run` exercise's `furthest_distance`/`longest_time`
 * records were never blocked from rendering — nothing there needed to
 * change. What had no coverage was `formatRecord` and `describeEvidence`
 * actually producing the right thing for those two kinds, which is what
 * this pins.
 */
function runRecord(over: Partial<PersonalRecord>): PersonalRecord {
  return {
    kind: 'furthest_distance',
    value: 0,
    reps: null,
    weight_kg: null,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    achieved_at: '2026-08-01T10:00:00Z',
    session_id: 's1',
    is_recent: false,
    ...over,
  };
}

describe('formatRecord — running record kinds', () => {
  it('formats furthest_distance by reusing formatDistance, not a bespoke number', () => {
    const r = runRecord({ kind: 'furthest_distance', value: 5000, distance_m: 5000 });
    expect(formatRecord(r, 'metric')).toBe('5 km');
    expect(formatRecord(r, 'imperial')).toBe('3.11 mi');
  });

  it('formats longest_time under a minute in seconds', () => {
    const r = runRecord({ kind: 'longest_time', value: 45, seconds: 45 });
    expect(formatRecord(r, 'metric')).toBe('45s');
  });

  it('formats longest_time over a minute as minutes and seconds', () => {
    const r = runRecord({ kind: 'longest_time', value: 1932, seconds: 1932 });
    expect(formatRecord(r, 'metric')).toBe('32m 12s');
  });

  it('has a label for both running kinds', () => {
    expect(RECORD_LABEL.furthest_distance).toBe('Furthest');
    expect(RECORD_LABEL.longest_time).toBe('Longest');
  });

  it('reports no measured evidence for a running record — it carries no reps or weight', () => {
    // `describeEvidence` only reads reps/weight_kg; a running record has
    // neither, so the row's second line is correctly empty rather than
    // showing a stray "null × null".
    const r = runRecord({ kind: 'furthest_distance', value: 5000, distance_m: 5000 });
    expect(describeEvidence(r, 'metric')).toEqual({ measured: '', reported: '' });
  });
});
