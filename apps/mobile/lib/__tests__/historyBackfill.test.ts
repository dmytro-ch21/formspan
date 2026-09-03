import { syncSessions, upsert, type LocalSession } from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * N85 — the fresh-install backfill in `runSync`.
 *
 * `docs/decisions/phone-impossible-audit.md` row 12: the routine sync pull
 * only ever asked the server for the most recent 20 sessions, so a phone that
 * had never held a row for this athlete — a fresh install, or a restore —
 * could never reach anything older. `runSync` now pages through a LARGER
 * window (200 rows at a time, capped at 10 pages) exactly once: when the
 * local table is empty for this user. Once anything lands, later syncs are
 * unaffected — this file pins that self-limiting behaviour, since it is the
 * whole reason no separate "has backfilled" flag exists.
 */

const AT = '2026-08-01T10:00:00.000Z';

const mockList = jest.fn();
jest.mock('../sessions', () => ({
  ...jest.requireActual('../sessions'),
  listSessions: (...a: unknown[]) => mockList(...a),
  startSession: jest.fn(),
  replaceSets: jest.fn(),
  finishSession: jest.fn().mockResolvedValue(undefined),
  renameSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
}));
jest.mock('../bjjSession', () => ({ putDetail: jest.fn() }));
jest.mock('../workouts', () => ({
  createWorkout: jest.fn(),
  replaceItems: jest.fn(),
  renameWorkout: jest.fn(),
  deleteWorkout: jest.fn(),
  listWorkouts: jest.fn(async () => []),
  getWorkout: jest.fn(),
}));

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const token = async () => 'tok';

/** A remote session shaped page, as `listSessions` returns it. */
const remoteRow = (id: string, over: Partial<LocalSession> = {}) => ({
  id,
  user_id: 'u1',
  workout_id: null,
  sport: 'strength',
  name: `Session ${id}`,
  intent: 'normal',
  started_at: AT,
  ended_at: AT,
  notes: '',
  sets: [],
  updated_at: AT,
  ...over,
});

/** `n` distinct rows, `id{offset}`..`id{offset+n-1}`, mirroring what a real
 * page of `limit=200&offset=X` would return. */
function page(n: number, offset: number) {
  return Array.from({ length: n }, (_, i) => remoteRow(`s${offset + i}`));
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockList.mockReset();
});

const localCount = async () => {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_sessions WHERE user_id = 'u1'`,
  );
  return row?.n ?? 0;
};

describe('a device that has never held a session for this athlete', () => {
  it('pages through the server in bounded requests rather than one pull', async () => {
    // Three full 200-row pages, then a short one — the loop must ask for a
    // fourth page (proving it kept going) and stop there (proving it noticed
    // the short page rather than always spending all 10).
    mockList
      .mockResolvedValueOnce(page(200, 0))
      .mockResolvedValueOnce(page(200, 200))
      .mockResolvedValueOnce(page(200, 400))
      .mockResolvedValueOnce(page(50, 600));

    const result = await syncSessions('u1', token);

    expect(mockList).toHaveBeenCalledTimes(4);
    expect(mockList).toHaveBeenNthCalledWith(1, token, { limit: 200, offset: 0 });
    expect(mockList).toHaveBeenNthCalledWith(2, token, { limit: 200, offset: 200 });
    expect(mockList).toHaveBeenNthCalledWith(3, token, { limit: 200, offset: 400 });
    expect(mockList).toHaveBeenNthCalledWith(4, token, { limit: 200, offset: 600 });

    expect(result.pulled).toBe(650);
    expect(await localCount()).toBe(650);
  });

  it('stops after 10 pages even if the server never runs out — the ceiling is real, not decorative', async () => {
    // Every page full, forever, so the ONLY thing that can end the loop is the
    // page-count cap. If a future edit deletes that cap, this test's call
    // count silently becomes 11, 12, ... and fails loudly rather than the
    // sync just taking longer.
    mockList.mockResolvedValue(page(200, 0));
    // ^ same 200 rows every call, on purpose: the point is the CALL COUNT,
    // and re-upserting the same 200 ids each time keeps `result.pulled`
    // legible (also 2,000) without needing 2,000 distinct fixtures.

    await syncSessions('u1', token);

    expect(mockList).toHaveBeenCalledTimes(10);
    expect(mockList).toHaveBeenNthCalledWith(10, token, { limit: 200, offset: 1800 });
  });

  it('makes exactly one request when the athlete truly has one session', async () => {
    mockList.mockResolvedValueOnce(page(1, 0));

    await syncSessions('u1', token);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenNthCalledWith(1, token, { limit: 200, offset: 0 });
  });
});

describe('a device that already holds history', () => {
  it('makes the ordinary small pull, not a backfill — self-limiting with no separate flag', async () => {
    // Seeded via the app's own upsert, exactly the way a prior sync would
    // have left it — not a raw INSERT, so this is the same path production
    // takes to reach "non-empty".
    await upsert(
      {
        id: 'existing',
        user_id: 'u1',
        workout_id: null,
        sport: 'strength',
        name: 'Old one',
        intent: 'normal',
        started_at: AT,
        ended_at: AT,
        notes: '',
        sets: [],
        created_at: AT,
        updated_at: AT,
        dirty: false,
      } as unknown as LocalSession,
      'u1',
      false,
      true,
    );

    mockList.mockResolvedValueOnce([]);

    await syncSessions('u1', token);

    // ROUTINE_PULL_LIMIT, not BACKFILL_PAGE — a device with SOME history
    // never pages, regardless of how many pages a fresh install would have
    // needed for the same eventual total.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenNthCalledWith(1, token, { limit: 20, offset: 0 });
  });

  it('a full 20-row routine page still does not trigger a second request', async () => {
    // Guards against the loop condition accidentally reading `remote.length
    // < BACKFILL_PAGE` (200) instead of `< limit` (20) on the non-fresh path
    // — which would silently turn every ordinary sync into a 200-row ask the
    // moment 20 rows came back full.
    await upsert(
      {
        id: 'existing',
        user_id: 'u1',
        workout_id: null,
        sport: 'strength',
        name: 'Old one',
        intent: 'normal',
        started_at: AT,
        ended_at: AT,
        notes: '',
        sets: [],
        created_at: AT,
        updated_at: AT,
        dirty: false,
      } as unknown as LocalSession,
      'u1',
      false,
      true,
    );

    mockList.mockResolvedValueOnce(page(20, 0));

    await syncSessions('u1', token);

    expect(mockList).toHaveBeenCalledTimes(1);
  });
});

it('another user’s local rows do not disguise a fresh install as an established one', async () => {
  // The COUNT the fresh-install check runs is scoped to `user_id` for exactly
  // this reason — a shared device, or a test fixture, that already holds rows
  // for someone else must not leave a brand-new athlete's own history capped.
  await upsert(
    {
      id: 'someone-elses',
      user_id: 'u2',
      workout_id: null,
      sport: 'strength',
      name: 'Not u1',
      intent: 'normal',
      started_at: AT,
      ended_at: AT,
      notes: '',
      sets: [],
      created_at: AT,
      updated_at: AT,
      dirty: false,
    } as unknown as LocalSession,
    'u2',
    false,
    true,
  );

  mockList.mockResolvedValueOnce(page(1, 0));

  await syncSessions('u1', token);

  expect(mockList).toHaveBeenNthCalledWith(1, token, { limit: 200, offset: 0 });
});
