import { ApiError } from '../apiError';
import { pushSession } from '../sessionStore';

/**
 * The BJJ reflection is optional. The session's duration is not.
 *
 * A BJJ session is logged after the fact, so `ended_at` is known the moment
 * it is created — and training history derives every duration from
 * `ended_at - started_at`, which means a session missing it counts for
 * nothing at all. The reflection (what you drilled, what happened live) is
 * a separate, skippable step that pushes to its own endpoint.
 *
 * Those two facts collided in the first version of the push: the reflection
 * PUT ran *before* the finish call, so a permanently-refused reflection —
 * one tag naming a technique the catalog later retired, say — threw before
 * the finish was ever reached. The optional half silently cost the
 * mandatory half its mat time, forever, with the athlete seeing only a
 * generic sync failure.
 *
 * These pin the fix from both directions: `ended_at` rides along on the
 * create, and the finish is ordered ahead of the reflection.
 */

const mockStart = jest.fn();
const mockSets = jest.fn();
const mockFinish = jest.fn();
const mockPutDetail = jest.fn();

jest.mock('../sessions', () => ({
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: (...a: unknown[]) => mockFinish(...a),
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock('../bjjSession', () => ({
  putDetail: (...a: unknown[]) => mockPutDetail(...a),
}));

type Row = {
  id: string; user_id: string; remote: number; dirty: number;
  deleted_at: string | null; updated_at: string; sets_json: string;
  sport: string; name: string; workout_id: string | null;
  started_at: string; ended_at: string | null; bjj_json: string | null;
};

let mockRow: Row | null = null;
const calls: string[] = [];

jest.mock('../db', () => ({
  getDb: async () => ({
    getFirstAsync: async () => mockRow,
    getAllAsync: async () => [],
    runAsync: async (sql: string) => {
      if (/SET dirty = 0/.test(sql)) calls.push('mark-clean');
    },
  }),
}));

const REFLECTION = JSON.stringify({
  kind: 'rolling',
  tags: [{ category: 'sweep', event: 'scored', position: '', count: 2 }],
});

const seed = (over: Partial<Row> = {}) => {
  calls.length = 0;
  mockRow = {
    id: 's1', user_id: 'u1', remote: 0, dirty: 1,
    deleted_at: null, updated_at: '2026-08-01T10:00:00Z', sets_json: '[]',
    sport: 'bjj', name: 'Evening rolls', workout_id: null,
    started_at: '2026-08-01T09:00:00Z', ended_at: '2026-08-01T10:00:00Z',
    bjj_json: REFLECTION, ...over,
  };
};

beforeEach(() => {
  mockStart.mockReset().mockImplementation(async () => {
    calls.push('create');
    return { session: {}, volume: {} };
  });
  mockSets.mockReset().mockImplementation(async () => { calls.push('sets'); });
  mockFinish.mockReset().mockImplementation(async () => { calls.push('finish'); });
  mockPutDetail.mockReset().mockImplementation(async () => { calls.push('detail'); });
});

it('sends ended_at on the create, so the session lands complete in one request', async () => {
  seed();
  await pushSession('u1', 's1', async () => 'tok');

  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(mockStart.mock.calls[0][1]).toMatchObject({
    id: 's1',
    started_at: '2026-08-01T09:00:00Z',
    ended_at: '2026-08-01T10:00:00Z',
  });
});

it('finishes the session BEFORE pushing the reflection', async () => {
  seed();
  await pushSession('u1', 's1', async () => 'tok');

  expect(calls.indexOf('finish')).toBeLessThan(calls.indexOf('detail'));
});

it('keeps the session duration when the reflection is permanently refused', async () => {
  // The blocking case. A 400 on the reflection must not take the session's
  // mat time with it — by the time it throws, both the create and the
  // finish have already carried `ended_at` to the server.
  seed();
  mockPutDetail.mockRejectedValue(new ApiError('bad tag', 'invalid_input', 400));

  await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

  expect(mockStart.mock.calls[0][1]).toMatchObject({ ended_at: '2026-08-01T10:00:00Z' });
  expect(mockFinish).toHaveBeenCalledWith(expect.anything(), 's1', '2026-08-01T10:00:00Z');
  // And the row stays dirty, so the reflection is retried rather than lost.
  expect(calls).not.toContain('mark-clean');
});

it('skips the reflection call entirely for a non-BJJ session', async () => {
  seed({ sport: 'strength', bjj_json: null });
  await pushSession('u1', 's1', async () => 'tok');

  expect(mockPutDetail).not.toHaveBeenCalled();
  expect(calls).toContain('mark-clean');
});

it('drops a corrupt reflection rather than failing the whole push', async () => {
  // The session and its timing are already worth keeping; a blob that no
  // longer parses is not a reason to strand them.
  seed({ bjj_json: '{not json' });
  await pushSession('u1', 's1', async () => 'tok');

  expect(mockPutDetail).not.toHaveBeenCalled();
  expect(calls).toContain('finish');
  expect(calls).toContain('mark-clean');
});
