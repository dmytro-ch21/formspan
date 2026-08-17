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
  test('a plan the server has never seen is dropped in the sync, with NO server call', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);

    await unplanSession(USER, p.id);

    // Tombstoned, not hard-deleted — see `unplanSession` for the race that
    // makes the hard delete unsafe outside the serialised sync. It is already
    // invisible to every screen.
    expect((await row(p.id))?.deleted_at).not.toBeNull();
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);

    await syncPlans(USER, getToken);

    // The sync makes the decision, where `remote` is finally trustworthy: the
    // server never saw it, so there is nothing to tell anyone.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await row(p.id)).toBeNull();
    expect(await countPendingPlans(USER)).toBe(0);
  });

  test('deleting DURING an in-flight create does not resurrect the plan', async () => {
    // The race that made the hard-delete branch unsafe. `remote` is only set
    // once `createRemotePlan` RESOLVES, so a delete landing mid-flight used to
    // read `remote = 0`, hard-delete, leave no tombstone — and the pull in the
    // same run would re-insert the plan the athlete had just removed.
    const p = await planSession(USER, '2026-08-05', 'strength', null);

    // The delete is fired from INSIDE the create's await, which is the only
    // way to land it in the window. Doing it after `syncPlans(...)` returns a
    // promise does not work: the push loop's SELECT has not run yet, so the
    // delete simply wins and no create is ever in flight — the first version
    // of this test made exactly that mistake and proved nothing.
    mockCreate.mockImplementationOnce(async () => {
      await unplanSession(USER, p.id);
    });

    await syncPlans(USER, getToken);

    // The create succeeded, so the server HAS the plan and the device must
    // still have something that will tell it to delete it. With a hard delete
    // there would be no tombstone, the server copy would be orphaned, and the
    // pull would bring it back as a brand new plan.
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
    expect(await countPendingPlans(USER)).toBe(1);

    // The server still lists it — the delete has not been sent yet.
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

    // Deleted server-side, gone locally, and never resurrected in between.
    expect(mockDelete).toHaveBeenCalledWith(getToken, p.id);
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
    expect(await row(p.id)).toBeNull();
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

/*
 * The closing compare-and-swap — T5.
 *
 * `pushRow` ends by clearing `dirty` only `AND updated_at = ?` and only
 * `AND deleted_at IS NULL`. Both clauses guard the same instant: the window
 * between the snapshot `runSync` took and the UPDATE that says "sent". A plan
 * screen writes through on every change, so something landing in that window is
 * ordinary, not exotic.
 *
 * Measured against #256's merge, by deleting each clause WITH its binding —
 * deleting a clause alone is a parameter-arity error, which measures the
 * harness rather than the guard. The whole mobile suite stayed green,
 * 1280/1280, for both. The two sibling swaps in `sessionStore` were pinned;
 * this was the last unheld one.
 *
 * **The tombstone half turned out to be worse than unheld: it was held by a
 * clock race.** `deleting DURING an in-flight create` above does catch that
 * deletion — but only when `planSession` and `unplanSession` land in the SAME
 * millisecond, because otherwise the `updated_at` clause declines first and the
 * tombstone clause is never reached. Measured with the clause removed: **5 of 6
 * runs of this file alone, and 0 of 1 under the full suite**, where everything
 * is slower and the timestamps separate. So it reads as covered, goes green in
 * CI on the run that matters, and the coverage is a coin toss nobody declared.
 * The test below forces the collision instead of hoping for it: 8 of 8.
 *
 * What it costs when it goes: the row is marked clean, the change exists on this
 * phone and nowhere else, and `countPendingPlans` reads zero — so nothing ever
 * retries and nothing reports a fault.
 */
describe('an edit or a delete that lands mid-push', () => {
  /** The snapshot's timestamp, so a test can decide what "unchanged" means. */
  const AT = '2026-08-01T10:00:00.000Z';

  /** Remote, clean, then dirtied at `AT` — the state a push starts from. */
  async function pushableAt(id: string, notes: string) {
    await db.runAsync(
      `UPDATE planned_sessions SET notes = ?, dirty = 1, updated_at = ? WHERE id = ?`,
      notes,
      AT,
      id,
    );
  }

  /** The server still holds it: the delete or edit has not been sent yet. */
  function serverStillHas(id: string) {
    mockFetch.mockResolvedValueOnce([
      {
        id,
        user_id: USER,
        day: '2026-08-05',
        sport: 'strength',
        workout_id: null,
        notes: '',
        created_at: AT,
        updated_at: AT,
      },
    ]);
  }

  test('an edit is not marked as already sent', async () => {
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await pushableAt(p.id, 'first');

    // The second edit lands while the PATCH is in flight, which is the whole
    // race: the push is sending `first` and the athlete has since typed
    // `second`. Marking the row clean here loses `second` permanently.
    mockUpdate.mockImplementationOnce(async () => {
      await db.runAsync(
        `UPDATE planned_sessions SET notes = ?, dirty = 1, updated_at = ? WHERE id = ?`,
        'second',
        '2026-08-01T10:00:01.000Z',
        p.id,
      );
    });
    serverStillHas(p.id);

    await syncPlans(USER, getToken);

    const after = await row(p.id);
    expect(after?.dirty).toBe(1);
    expect(await countPendingPlans(USER)).toBe(1);
  });

  test('a DELETE is not marked as already sent, even in the same millisecond', async () => {
    // The clause `updated_at` cannot cover. `unplanSession` stamps `updated_at`
    // with its own clock, so in the ordinary case the first clause declines and
    // this second one is never reached — which is exactly why the existing
    // coverage was a coin toss. It exists for the collision: a delete inside
    // the same millisecond as the snapshot writes an IDENTICAL timestamp, the
    // first clause matches, and only `deleted_at IS NULL` can still say no.
    //
    // Two `Date.now()` calls cannot be forced into one millisecond on demand,
    // so the tombstone is written by the real `unplanSession` and only the
    // clock is then closed by hand. That is the difference between 5-of-6 and
    // 8-of-8: the guard under test is untouched, the race is no longer left to
    // how busy the machine is.
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await pushableAt(p.id, 'edited');

    mockUpdate.mockImplementationOnce(async () => {
      await unplanSession(USER, p.id);
      await db.runAsync(`UPDATE planned_sessions SET updated_at = ? WHERE id = ?`, AT, p.id);
    });
    serverStillHas(p.id);

    await syncPlans(USER, getToken);

    const after = await row(p.id);
    // Still a tombstone, and still owed. Cleared, the plan is gone from this
    // phone, alive on the server forever, and `pending` reads zero so no sync
    // ever tries again.
    expect(after?.deleted_at).not.toBeNull();
    expect(after?.dirty).toBe(1);
    expect(await countPendingPlans(USER)).toBe(1);
  });

  test('a push with nothing landing underneath it DOES go clean', async () => {
    // Or "never clear dirty at all" would satisfy both tests above.
    const p = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken);
    await pushableAt(p.id, 'first');
    serverStillHas(p.id);

    await syncPlans(USER, getToken);

    expect((await row(p.id))?.dirty).toBe(0);
    expect(await countPendingPlans(USER)).toBe(0);
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

    const result = await syncPlans(USER, getToken);

    const [plan] = await plannedFor(USER, '2026-08-05');
    expect(plan.day).toBe('2026-08-05');
    // `pulled` is what the dirty guard uniquely controls: the upsert's own
    // `WHERE planned_sessions.dirty = 0` also refuses the write, so asserting
    // only on the day passes with this guard deleted. Counting it as skipped
    // is what pins the guard rather than its backstop.
    expect(result.pulled).toBe(0);
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

    const result = await syncPlans(USER, getToken);

    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(0);
    const after = await db.getFirstAsync<{ day: string; sport: string; notes: string }>(
      `SELECT day, sport, notes FROM planned_sessions WHERE id = ?`,
      p.id,
    );
    expect(after).toMatchObject({ day: '2026-08-05', sport: 'strength', notes: '' });
    // `pulled` is what the tombstone guard uniquely controls. The upsert's own
    // WHERE also refuses to write a buried row, so asserting only on the row's
    // contents passes with the guard deleted — the two mask each other. This
    // counts the row as skipped rather than merely unchanged.
    expect(result.pulled).toBe(0);
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

describe('the sweep refuses to act on a response it cannot trust', () => {
  test("another account's plans never trigger the sweep", async () => {
    // `getToken` follows the CURRENT Clerk user while the run holds the one it
    // started with, and `setSyncIdentity` does not abort a run in flight. So an
    // account switch mid-run returns user B's plans while the sweep is scoped
    // to user A — none of A's ids appear in the response, and without this
    // check every one of A's plans in the window is deleted.
    const mine = await planSession(USER, '2026-08-05', 'strength', null);
    await syncPlans(USER, getToken); // clean + remote

    mockFetch.mockResolvedValueOnce([
      {
        id: 'someone-elses-plan',
        user_id: 'a-different-account',
        day: '2026-08-06',
        sport: 'bjj',
        workout_id: null,
        notes: '',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    ]);

    await syncPlans(USER, getToken);

    // Survived. A stale local row is cosmetic and the next good sync fixes it;
    // a wrongly-deleted plan is not recoverable.
    expect(await row(mine.id)).not.toBeNull();
    expect(await plannedFor(USER, '2026-08-05')).toHaveLength(1);
    // And the foreign row was not adopted into this account either.
    expect(await row('someone-elses-plan')).toBeNull();
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
