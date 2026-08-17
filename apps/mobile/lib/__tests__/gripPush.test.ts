import { ApiError } from '../apiError';
import { pushSession } from '../sessionStore';

/**
 * The grip repair: the one server refusal a phone can settle by itself.
 *
 * T4 stopped `repairSet` nulling grips it does not recognise, because that is a
 * question only the server can answer — a build knows four, the server decides
 * how many exist, and guessing meant an older phone read a legitimate `mixed`,
 * nulled it, and wrote that null back over real data. So the client sends what
 * it holds and drops a grip only once the server has actually refused it, by
 * code.
 *
 * That trade moves the risk into THIS retry, and the retry is the part with no
 * screen behind it: an athlete never sees it happen. Review found two holes here
 * that the rest of the suite could not — a create path the repair never covered,
 * and a write with no compare-and-swap that could delete a mid-push edit — so
 * every case below pins one of them.
 */

const mockStart = jest.fn();
const mockSets = jest.fn();
const mockFinish = jest.fn();

jest.mock('../sessions', () => ({
  // `requireActual` FIRST, for the same reason bjjPush.test.ts gives: every set
  // here passes through the real `repairSet`, and these fixtures are
  // deliberately set-bearing. Listing only the API calls would leave it
  // undefined and crash on the first map.
  ...jest.requireActual('../sessions'),
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: (...a: unknown[]) => mockFinish(...a),
  renameSession: jest.fn(),
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock('../bjjSession', () => ({ putDetail: jest.fn() }));

type Row = {
  id: string; user_id: string; remote: number; dirty: number;
  deleted_at: string | null; updated_at: string; sets_json: string;
  sport: string; name: string; workout_id: string | null; name_dirty: number;
  started_at: string; ended_at: string | null; bjj_json: string | null;
};

let mockRow: Row | null = null;
const writes: { sql: string; params: unknown[] }[] = [];
/**
 * What the repair's UPDATE matches. 0 is a real state, not a contrivance: it is
 * what SQLite answers when `updated_at` has moved since this push read the row.
 */
let mockRepairMatches = 1;

jest.mock('../db', () => ({
  getDb: async () => ({
    getFirstAsync: async () => mockRow,
    getAllAsync: async () => [],
    runAsync: async (sql: string, ...params: unknown[]) => {
      writes.push({ sql, params });
      if (/SET sets_json = \?/.test(sql)) return { lastInsertRowId: 0, changes: mockRepairMatches };
      return { lastInsertRowId: 0, changes: 1 };
    },
  }),
}));

/** A grip no build in the wild knows, standing in for the one a future server adds. */
const FUTURE_GRIP = 'mixed';

const SETS = [
  {
    exercise_id: 'bench-press', position: 0, set_type: 'working', reps: 5, weight_kg: 100,
    seconds: null, distance_m: null, rir: null, rpe: null, notes: '', completed: true,
    grip: FUTURE_GRIP,
  },
  {
    exercise_id: 'bench-press', position: 1, set_type: 'working', reps: 5, weight_kg: 100,
    seconds: null, distance_m: null, rir: null, rpe: null, notes: '', completed: true,
    grip: 'neutral',
  },
];

const refused = () => new ApiError('unknown grip (set 1)', 'invalid_grip', 400);

const seed = (over: Partial<Row> = {}) => {
  writes.length = 0;
  mockRepairMatches = 1;
  mockRow = {
    id: 's1', user_id: 'u1', remote: 1, dirty: 1,
    deleted_at: null, updated_at: '2026-08-01T10:00:00Z', sets_json: JSON.stringify(SETS),
    sport: 'strength', name: 'Bench', workout_id: null, name_dirty: 0,
    started_at: '2026-08-01T09:00:00Z', ended_at: '2026-08-01T10:00:00Z',
    bjj_json: null, ...over,
  };
};

const grips = (sets: { grip?: unknown }[]) => sets.map((s) => s.grip);
const setsWritten = () => writes.filter((w) => /SET sets_json = \?/.test(w.sql));
const markedClean = () => writes.some((w) => /SET dirty = 0/.test(w.sql));

beforeEach(() => {
  mockStart.mockReset().mockResolvedValue({ session: {}, volume: {} });
  mockSets.mockReset().mockResolvedValue(undefined);
  mockFinish.mockReset().mockResolvedValue(undefined);
});

/**
 * The sets push, for a session the server already acknowledged. The path the
 * repair was originally written for.
 */
describe('a grip the server refuses on the sets push', () => {
  it('retries without the grips and lets the session land', async () => {
    seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockSets).toHaveBeenCalledTimes(2);
    expect(grips(mockSets.mock.calls[0][2])).toEqual([FUTURE_GRIP, 'neutral']);
    expect(grips(mockSets.mock.calls[1][2])).toEqual([null, null]);
    expect(markedClean()).toBe(true);
  });

  it('persists the repair, so the next push cannot send the refused grip again', async () => {
    seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    const written = setsWritten();
    expect(written).toHaveLength(1);
    expect(grips(JSON.parse(written[0].params[0] as string))).toEqual([null, null]);
  });

  it('falls through to the finish rather than returning', async () => {
    // Returning early here would let an unknown grip cost the session its
    // `ended_at` — and a session with no duration counts for nothing at all in
    // history. The same "optional half costing the mandatory one" shape the BJJ
    // reflection ordering exists to prevent.
    seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockFinish).toHaveBeenCalledWith(expect.anything(), 's1', '2026-08-01T10:00:00Z');
  });
});

/**
 * The create, which the repair did not cover at all until review found it.
 *
 * `remote = 0` is every session logged offline — the case this whole store
 * exists for — and `POST /v1/sessions` runs the same `validateSets` on the sets
 * in its body, before the repository. So the refusal arrived from the create,
 * outside the only catch that could settle it: permanently refused, dirty
 * forever, and unreachable by any screen, because no editor can turn a value it
 * does not recognise back into a legal one.
 */
describe('a grip the server refuses on the create', () => {
  it('retries the create without the grips', async () => {
    seed({ remote: 0 });
    mockStart.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(grips(mockStart.mock.calls[0][1].sets)).toEqual([FUTURE_GRIP, 'neutral']);
    expect(grips(mockStart.mock.calls[1][1].sets)).toEqual([null, null]);
  });

  it('carries the repair into the sets push that follows', async () => {
    // The repair replaces the list every later call reads, rather than being
    // local to the call that was refused — otherwise the create would land
    // repaired and the very next request would re-send the refused grip.
    seed({ remote: 0 });
    mockStart.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(grips(mockSets.mock.calls[0][2])).toEqual([null, null]);
    expect(markedClean()).toBe(true);
  });

  it('keeps the rest of the create intact', async () => {
    // Only the grips are dropped. A retry that lost `ended_at` would cost the
    // session its duration to settle a disagreement about a different field.
    seed({ remote: 0 });
    mockStart.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockStart.mock.calls[1][1]).toMatchObject({
      id: 's1',
      started_at: '2026-08-01T09:00:00Z',
      ended_at: '2026-08-01T10:00:00Z',
    });
  });
});

/**
 * The compare-and-swap, and the data-loss it exists to prevent.
 *
 * `saveLocalSets` bumps `updated_at` on every edit and a live session pushes on
 * every debounced save, so an athlete ticking a set mid-push is the ordinary
 * state. Without the swap, the repair writes the sets read at the START of the
 * push back over that newer edit — the athlete's last reps deleted locally, to
 * settle a refusal about a grip.
 */
describe('an edit that lands mid-push', () => {
  it('declines the repair rather than writing stale sets over it', async () => {
    seed();
    mockRepairMatches = 0; // `updated_at` moved: a save landed while we were pushing
    mockSets.mockRejectedValueOnce(refused());

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow(ApiError);

    // No retry, because the list to retry with was never established.
    expect(mockSets).toHaveBeenCalledTimes(1);
    // And the row stays dirty, so the next sync re-reads the athlete's newer
    // sets and repairs THOSE. The cost of declining is one cycle, not the edit.
    expect(markedClean()).toBe(false);
  });
});

describe('refusals that are not about a grip', () => {
  it('never repairs, and never writes', async () => {
    seed();
    mockSets.mockRejectedValue(new ApiError('RPE must be 1-10', 'invalid_input', 400));

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

    expect(mockSets).toHaveBeenCalledTimes(1);
    expect(setsWritten()).toHaveLength(0);
    expect(markedClean()).toBe(false);
  });

  it('still forgets `remote` on a 404 — including one the RETRY hits', async () => {
    // Reachable because the server validates sets before it checks the session
    // exists: "deleted on another device AND holding a refused grip" answers
    // `invalid_grip` first and 404 only on the way back. Missing it there would
    // cost a sync cycle, since nothing would recreate the session.
    seed();
    mockSets
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(new ApiError('gone', 'not_found', 404));

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

    expect(writes.some((w) => /SET remote = 0/.test(w.sql))).toBe(true);
  });
});
