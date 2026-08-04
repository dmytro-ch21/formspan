import { ApiError } from '../apiError';
import {
  countPendingPlans,
  listPlannedBetween,
  planSession,
  plannedFor,
  syncPlans,
  tombstonedPlanIDs,
  unplanSession,
} from '../plan';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The plan outbox, against a real database.
 *
 * The pure-logic decisions (which day, which order) are covered in
 * `plan.test.ts`. These are the ones that only real SQL and a real push loop
 * can prove, and every one of them is a bug this codebase has already shipped
 * once in the sessions or workouts outbox:
 *
 *  - a tombstone that hard-deletes a row the server knows about, so the next
 *    pull resurrects it;
 *  - a pull that overwrites a local edit still waiting to go out;
 *  - a permanent refusal that hides a plan forever while `pending` never
 *    reaches zero;
 *  - a 409 on a create whose response was lost, retried until the orchestrator
 *    gives up on a perfectly good row.
 */

let db: FixtureDb;
// `mock`-prefixed so the jest.mock factories may close over them.
let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

jest.mock('expo-crypto', () => ({
  randomUUID: () => `uuid-${++mockUuidSeq}`,
}));

// The workout dependency. Real in production (`unsyncedWorkoutIDs` reads
// `workout_cache`); here it is the knob that lets the deferral case be set up
// without seeding the whole workout outbox.
let mockUnsynced: string[] = [];
jest.mock('../sessionStore', () => ({
  unsyncedWorkoutIDs: async () => new Set(mockUnsynced),
}));

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockFetch = jest.fn();
jest.mock('../plansApi', () => ({
  createPlan: (...a: unknown[]) => mockCreate(...a),
  updatePlan: (...a: unknown[]) => mockUpdate(...a),
  deletePlan: (...a: unknown[]) => mockDelete(...a),
  fetchPlans: (...a: unknown[]) => mockFetch(...a),
}));

const USER = 'u1';
const getToken = async () => 'token';

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUnsynced = [];
  mockCreate.mockReset().mockResolvedValue(undefined);
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockDelete.mockReset().mockResolvedValue(undefined);
  // Default: the server has nothing. Individual tests override.
  mockFetch.mockReset().mockResolvedValue([]);
});

/** The raw row, for asserting on outbox flags the public API hides. */
async function row(id: string) {
  return db.getFirstAsync<{
    dirty: number;
    remote: number;
    deleted_at: string | null;
    last_error: string | null;
    updated_at: string;
  }>(`SELECT dirty, remote, deleted_at, last_error, updated_at FROM planned_sessions WHERE id = ?`, id);
}

describe('the outbox flags', () => {
  test('a new plan is dirty and not yet remote', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    expect(await row(p.id)).toMatchObject({ dirty: 1, remote: 0 });
    expect(await countPendingPlans(USER)).toBe(1);
  });

  test('a successful push clears dirty and marks it remote', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);

    const result = await syncPlans(USER, getToken);

    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await row(p.id)).toMatchObject({ dirty: 0, remote: 1 });
    expect(await countPendingPlans(USER)).toBe(0);
  });

  test('an already-remote plan is PATCHed, not re-created', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);

    // Make it dirty again the way a real edit would.
    await db.runAsync(
      `UPDATE planned_sessions SET day = ?, dirty = 1, updated_at = ? WHERE id = ?`,
      '2026-08-06',
      new Date().toISOString(),
      p.id,
    );
    await syncPlans(USER, getToken);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({ day: '2026-08-06' });
  });
});

describe('deleting', () => {
  test('a plan the server has never seen is dropped with NO server call', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);

    await unplanSession(USER, p.id);

    expect(await row(p.id)).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await countPendingPlans(USER)).toBe(0);
  });

  test('a plan the server HAS seen becomes a tombstone, then is pushed', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);

    await unplanSession(USER, p.id);

    // Tombstoned, not gone — the server still has to be told.
    expect(await row(p.id)).toMatchObject({ dirty: 1 });
    expect((await row(p.id))?.deleted_at).not.toBeNull();
    // ...and invisible to every screen immediately.
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
    expect(await countPendingPlans(USER)).toBe(1);

    await syncPlans(USER, getToken);

    expect(mockDelete).toHaveBeenCalledWith(getToken, p.id);
    expect(await row(p.id)).toBeNull();
  });

  test('a 404 on delete counts as success', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await unplanSession(USER, p.id);

    mockDelete.mockRejectedValueOnce(new ApiError('gone', 'not_found', 404));

    const result = await syncPlans(USER, getToken);

    // The server agreeing it is gone IS the state being asked for.
    expect(result.failed).toBe(0);
    expect(await row(p.id)).toBeNull();
  });

  test('a permanent refusal RESTORES the plan rather than hiding it forever', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await unplanSession(USER, p.id);

    mockDelete.mockRejectedValueOnce(new ApiError('nope', 'forbidden', 403));
    // A server that REFUSED the delete still has the plan, so its list still
    // contains it. Saying otherwise would be an incoherent server, and would
    // have the "deleted elsewhere" sweep tidy away the row this test is about.
    mockFetch.mockResolvedValueOnce([
      {
        id: p.id,
        user_id: USER,
        day: '2026-08-05',
        sport: 'strength',
        workout_id: null,
        notes: '',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    ]);

    const result = await syncPlans(USER, getToken);

    expect(result.failed).toBe(1);
    // The plan was NOT deleted, so it must come back — otherwise it is hidden
    // for the life of the install while `pending` never reaches zero.
    const after = await row(p.id);
    expect(after?.deleted_at).toBeNull();
    expect(after?.dirty).toBe(0);
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(1);
  });
});

describe('pulling', () => {
  test('a plan made elsewhere lands locally, clean', async () => {
    mockFetch.mockResolvedValueOnce([
      {
        id: 'from-web',
        user_id: USER,
        day: '2026-08-07',
        sport: 'bjj',
        workout_id: null,
        notes: 'comp class',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    ]);

    const result = await syncPlans(USER, getToken);

    expect(result.pulled).toBe(1);
    const [plan] = await plannedFor(USER, '2026-08-07');
    expect(plan).toMatchObject({ id: 'from-web', sport: 'bjj', notes: 'comp class' });
    // Clean and remote — pulling must not make it look owed.
    expect(await row('from-web')).toMatchObject({ dirty: 0, remote: 1 });
  });

  test('the pull never overwrites a local edit still waiting to go out', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    // The server's copy says the 6th, ours says the 5th and is still dirty.
    //
    // Its `updated_at` is deliberately in the FUTURE, which is what makes this
    // test about the dirty guard and nothing else. With a past timestamp the
    // "refuse to go backwards" check would reject the snapshot anyway, and the
    // test would pass with the dirty guard deleted — it did, until a mutation
    // run caught it.
    mockFetch.mockResolvedValueOnce([
      {
        id: p.id,
        user_id: USER,
        day: '2026-08-06',
        sport: 'strength',
        workout_id: null,
        notes: '',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2099-01-01T00:00:00.000Z',
      },
    ]);
    // Fail the push so the row stays dirty through the pull.
    mockCreate.mockRejectedValueOnce(new Error('network'));

    await syncPlans(USER, getToken);

    const [plan] = await plannedFor(USER, '2026-08-05');
    expect(plan.day).toBe('2026-08-05');
  });

  test('a stale snapshot does not move a newer local row backwards', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken); // now clean + remote

    // A snapshot from BEFORE the local row's updated_at.
    mockFetch.mockResolvedValueOnce([
      {
        id: p.id,
        user_id: USER,
        day: '1999-01-01',
        sport: 'strength',
        workout_id: null,
        notes: '',
        created_at: '1999-01-01T00:00:00.000Z',
        updated_at: '1999-01-01T00:00:00.000Z',
      },
    ]);

    await syncPlans(USER, getToken);

    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(1);
  });

  test('a tombstone is not resurrected by the pull', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await unplanSession(USER, p.id);

    // The server still lists it — the delete has not landed yet. Fail the
    // delete so the tombstone survives into the pull.
    mockDelete.mockRejectedValueOnce(new Error('network'));
    mockFetch.mockResolvedValueOnce([
      {
        id: p.id,
        user_id: USER,
        day: '2026-08-05',
        sport: 'strength',
        workout_id: null,
        notes: '',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    ]);

    await syncPlans(USER, getToken);

    expect(await tombstonedPlanIDs(USER)).toContain(p.id);
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
  });

  test('a CLEAN tombstone is not resurrected either', async () => {
    // Every tombstone this module writes is also dirty, so the `dirty` guard
    // masks the tombstone guard and the test above passes with the latter
    // deleted — verified by mutating it. This forces the state the tombstone
    // guard alone defends: `deleted_at` set, nothing owed.
    //
    // Unreachable through the public API today. It is asserted anyway because
    // the guard is the documented defence against a resurrection bug this
    // codebase has already shipped once, and a future path that clears `dirty`
    // without clearing `deleted_at` would silently revive deleted plans.
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await db.runAsync(
      `UPDATE planned_sessions SET deleted_at = ?, dirty = 0 WHERE id = ?`,
      new Date().toISOString(),
      p.id,
    );

    // A DIFFERENT day on the server, which is what makes this observable: the
    // guard's unique effect is that a buried row is skipped *entirely*.
    // Without it the row is upserted — still invisible, because the upsert
    // does not clear `deleted_at`, but silently rewritten underneath the
    // tombstone. Asserting only on visibility passes either way; asserting the
    // row is untouched is what actually pins the guard.
    mockFetch.mockResolvedValueOnce([
      {
        id: p.id,
        user_id: USER,
        day: '2026-08-09',
        sport: 'bjj',
        workout_id: null,
        notes: 'rewritten',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2099-01-01T00:00:00.000Z',
      },
    ]);

    await syncPlans(USER, getToken);

    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
    const after = await db.getFirstAsync<{ day: string; sport: string; notes: string }>(
      `SELECT day, sport, notes FROM planned_sessions WHERE id = ?`,
      p.id,
    );
    expect(after).toMatchObject({ day: '2026-08-05', sport: 'strength', notes: '' });
  });

  test('a plan deleted elsewhere disappears locally', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken); // clean + remote

    // The server no longer lists it.
    mockFetch.mockResolvedValueOnce([]);
    await syncPlans(USER, getToken);

    // Without this the plan would sit on the phone forever: the pull only
    // writes what it receives, so a deletion elsewhere is otherwise invisible.
    expect(await row(p.id)).toBeNull();
  });

  test('a never-pushed local plan survives a pull that does not mention it', async () => {
    // The counterpart to the test above, and the reason that sweep is scoped
    // to `remote = 1`: a plan the server has never seen is not "missing from
    // the response", it was never in it.
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    mockCreate.mockRejectedValueOnce(new Error('network'));

    await syncPlans(USER, getToken);

    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(1);
    expect(await row(p.id)).toMatchObject({ dirty: 1, remote: 0 });
  });
});

describe('the workout dependency', () => {
  test('a plan whose template has not synced is DEFERRED, not failed', async () => {
    await planSession(USER, '2026-08-05', 'strength', 'w-unsynced');
    mockUnsynced = ['w-unsynced'];

    const result = await syncPlans(USER, getToken);

    // Deferred, not failed: the FK error would be a 4xx, which classifies as
    // permanent, and the orchestrator would give up on training that is fine.
    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    // Still owed, so the next pass picks it up.
    expect(await countPendingPlans(USER)).toBe(1);
  });

  test('once the template lands, the plan goes out', async () => {
    await planSession(USER, '2026-08-05', 'strength', 'w-unsynced');
    mockUnsynced = ['w-unsynced'];
    await syncPlans(USER, getToken);

    mockUnsynced = [];
    const result = await syncPlans(USER, getToken);

    expect(result.pushed).toBe(1);
    expect(await countPendingPlans(USER)).toBe(0);
  });

  test('a TOMBSTONE is never deferred by its template', async () => {
    // Deleting a plan does not depend on its workout existing anywhere, and
    // holding the tombstone back would keep the plan on screen — and on the
    // server — until an unrelated template synced.
    const p = await planSession(USER, '2026-08-05', 'strength', 'w-unsynced');
    mockUnsynced = [];
    await syncPlans(USER, getToken);

    await unplanSession(USER, p.id);
    mockUnsynced = ['w-unsynced'];

    const result = await syncPlans(USER, getToken);

    expect(result.deferred).toBe(0);
    expect(mockDelete).toHaveBeenCalled();
    expect(await row(p.id)).toBeNull();
  });
});

describe('errors', () => {
  test('a lost create response (409) is reconciled, not retried forever', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    mockCreate.mockRejectedValueOnce(new ApiError('exists', 'already_exists', 409));

    const result = await syncPlans(USER, getToken);

    // The id is ours, so a 409 means OUR row is already on the server.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(0);
    expect(await row(p.id)).toMatchObject({ dirty: 0, remote: 1 });
  });

  test('a transient failure is NOT recorded on the row', async () => {
    // A phone in a basement is the ordinary case; writing "Network request
    // failed" onto every row would turn the repair list into a list of
    // everything ever planned offline.
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    mockCreate.mockRejectedValueOnce(new Error('Network request failed'));

    await syncPlans(USER, getToken);

    expect((await row(p.id))?.last_error).toBeNull();
    expect((await row(p.id))?.dirty).toBe(1);
  });

  test('a permanent refusal IS recorded on the row', async () => {
    // Keyed on the payload rather than `mockRejectedValueOnce`, which the
    // first row through the loop would consume regardless of which row the
    // test means — the ordering trap that made an earlier version of this
    // assert against the wrong plan.
    await planSession(USER, '2026-08-05', 'strength', null);
    const bad = await planSession(USER, '2026-08-06', 'strength', null);
    mockCreate.mockImplementation(async (_t: unknown, input: { id: string }) => {
      if (input.id === bad.id) throw new ApiError('bad sport', 'invalid_input', 400);
    });

    await syncPlans(USER, getToken);

    expect((await row(bad.id))?.last_error).toBe('bad sport');
  });

  test('a row that is refused and later accepted stops being reported broken', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    mockCreate.mockRejectedValueOnce(new ApiError('bad', 'invalid_input', 400));
    await syncPlans(USER, getToken);
    expect((await row(p.id))?.last_error).toBe('bad');

    await syncPlans(USER, getToken);
    expect((await row(p.id))?.last_error).toBeNull();
  });

  test('a failing pull does not lose a successful push', async () => {
    await planSession(USER, '2026-08-05', 'strength', null);
    mockFetch.mockRejectedValueOnce(new Error('network'));

    const result = await syncPlans(USER, getToken);

    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(1);
    expect(await countPendingPlans(USER)).toBe(0);
  });
});

describe('user scoping', () => {
  test('one account never syncs or sees another account’s plans', async () => {
    await planSession('other', '2026-08-05', 'strength', null);
    await planSession(USER, '2026-08-05', 'bjj', null);

    const result = await syncPlans(USER, getToken);

    expect(result.pushed).toBe(1);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ sport: 'bjj' });
    expect(await listPlannedBetween(USER, '2026-08-01', '2026-08-31')).toHaveLength(1);
    expect(await countPendingPlans('other')).toBe(1);
  });
});
