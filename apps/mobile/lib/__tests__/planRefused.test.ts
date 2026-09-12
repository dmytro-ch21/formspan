/**
 * N564/#1106 — a plan the server refuses stops counting as pending, is shown on
 * the repair list, and every way out of that state is real.
 *
 * Against a REAL SQLite database through `migratedFixture()`, and wherever the
 * state can be produced by the real push loop it is — a refused create or a
 * refused delete is driven through `syncPlans` with the API mocked to refuse,
 * not seeded as a row that merely looks refused. Seeded rows are used only for
 * states the loop cannot reach on demand (a tombstone still carrying an error).
 *
 * ## The properties, and why each is a trap
 *
 * 1. **Pending and blocked partition the owed plans.** `countPendingPlans` and
 *    the repair list share `BLOCKED_ROW`. A plan in both answers inflates two
 *    numbers; a plan in NEITHER is uncounted and invisible, and no screen would
 *    ever reveal it.
 * 2. **A refused plan TOMBSTONE lands in one place on purpose.** A refused
 *    delete is restored by `pushRow` and listed as a refused removal; a
 *    tombstone still carrying an old error is pending. Asserted both ways.
 * 3. **Every local edit clears the refusal.** Otherwise a fixed plan stays
 *    classed as blocked, out of pending, and — because the triggers are gated
 *    on `pending > 0` — is never sent.
 * 4. **The recovery changes something.** Each action is followed by a real
 *    sync, and the test asserts what that sync did and did not send.
 */

import { ApiError } from '../apiError';
import * as planModule from '../plan';
import {
  acknowledgeRefusedRemoval,
  countPendingPlans,
  countRefusedPlans,
  planSession,
  plannedFor,
  refusedPlans,
  syncPlans,
  unplanSession,
} from '../plan';
import { migratedFixture, type FixtureDb } from './support/sqlite';

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

jest.mock('../sessionStore', () => ({
  unsyncedWorkoutIDs: async () => new Set<string>(),
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

const U = 'u1';
const getToken = async () => 'token';
const REFUSED = 'unknown sport';
const REFUSED_DELETE = 'plan is managed by your coach';

/*
 * A small, COHERENT fake server rather than one-shot mocks, and the reason is
 * that the first version of the invariant test failed on its own apparatus:
 * every helper runs a real `syncPlans`, which pushes EVERY dirty row — so a
 * `mockRejectedValueOnce` refused one row once and the next helper's sync
 * quietly accepted it, and a server list of `[]` had the sweep delete a plan
 * the server was supposed to still hold. Refusals here are per id and last,
 * and the list is whatever the server has accepted and not deleted.
 */
let refuseCreate: Set<string>;
let refuseDelete: Set<string>;
let serverPlans: Map<string, ReturnType<typeof serverCopy>>;

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  refuseCreate = new Set();
  refuseDelete = new Set();
  serverPlans = new Map();
  mockCreate.mockReset().mockImplementation(async (_t: unknown, input: { id: string; day: string }) => {
    if (refuseCreate.has(input.id)) throw new ApiError(REFUSED, 'invalid_input', 400);
    serverPlans.set(input.id, serverCopy(input.id, input.day));
  });
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockDelete.mockReset().mockImplementation(async (_t: unknown, id: string) => {
    if (refuseDelete.has(id)) throw new ApiError(REFUSED_DELETE, 'forbidden', 403);
    serverPlans.delete(id);
  });
  mockFetch.mockReset().mockImplementation(async () => [...serverPlans.values()]);
});

const rowOf = (id: string) =>
  db.getFirstAsync<{ dirty: number; deleted_at: string | null; last_error: string | null; remote: number }>(
    `SELECT dirty, deleted_at, last_error, remote FROM planned_sessions WHERE id = ?`,
    id,
  );

/** The server's copy of a plan, for a pull that must still list it. */
const serverCopy = (id: string, day: string) => ({
  id,
  user_id: U,
  day,
  sport: 'strength',
  workout_id: null,
  class_plan_id: null,
  time_of_day_minutes: null,
  notes: '',
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
});

/**
 * A plan the server refused to create — through the real push loop. Call
 * counts are cleared on the way out, so a test counts only its own requests.
 */
async function refusedPlan(day = '2026-08-05') {
  const p = await planSession(U, day, 'strength', null);
  refuseCreate.add(p.id);
  await syncPlans(U, getToken);
  // Apparatus check: the loop really recorded the refusal and kept it owed, or
  // every assertion below is about a row that was never refused.
  expect(await rowOf(p.id)).toMatchObject({ dirty: 1, last_error: REFUSED, deleted_at: null });
  expect(serverPlans.has(p.id)).toBe(false);
  jest.clearAllMocks();
  return p;
}

/** A plan on the server whose removal the server refused — through the real loop. */
async function refusedRemoval(day = '2026-08-06') {
  const p = await planSession(U, day, 'strength', null);
  await syncPlans(U, getToken); // accepted: now remote and clean
  expect(serverPlans.has(p.id)).toBe(true);
  await unplanSession(U, p.id);
  refuseDelete.add(p.id);
  // The server still lists it, because it refused the delete — so the sweep
  // cannot tidy away the row under test.
  await syncPlans(U, getToken);
  expect(await rowOf(p.id)).toMatchObject({ dirty: 0, last_error: REFUSED_DELETE, deleted_at: null });
  jest.clearAllMocks();
  return p;
}

/** A tombstone that still carries an older refusal — not reachable on demand, so seeded. */
async function seedErroredTombstone(id: string) {
  await db.runAsync(
    `INSERT INTO planned_sessions
       (id, user_id, day, sport, workout_id, notes, created_at, updated_at, dirty, remote, deleted_at, last_error)
     VALUES (?, ?, '2026-08-07', 'strength', NULL, '', '2026-08-01T10:00:00.000Z',
             '2026-08-02T10:00:00.000Z', 1, 0, '2026-08-02T10:00:00.000Z', ?)`,
    id,
    U,
    REFUSED,
  );
}

describe('a refused plan stops counting as pending and is listed instead', () => {
  it('a refused plan is not pending, is counted, and is listed with the server’s own reason', async () => {
    const p = await refusedPlan();
    expect(await countPendingPlans(U)).toBe(0);
    expect(await countRefusedPlans(U)).toBe(1);
    const listed = await refusedPlans(U);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: p.id, reason: REFUSED, refused: 'plan', day: '2026-08-05' });
  });

  it('a merely queued plan is pending and not listed — the control', async () => {
    await planSession(U, '2026-08-05', 'strength', null);
    expect(await countPendingPlans(U)).toBe(1);
    expect(await countRefusedPlans(U)).toBe(0);
    expect(await refusedPlans(U)).toEqual([]);
  });

  it('a transiently failing plan stays pending — only a permanent refusal is ever blocked', async () => {
    const p = await planSession(U, '2026-08-05', 'strength', null);
    mockCreate.mockImplementationOnce(async () => {
      throw new Error('Network request failed');
    });
    await syncPlans(U, getToken);
    expect(await rowOf(p.id)).toMatchObject({ dirty: 1, last_error: null });
    expect(await countPendingPlans(U)).toBe(1);
    expect(await countRefusedPlans(U)).toBe(0);
  });

  it('names the template when the device has it cached', async () => {
    // The name is a correlated subquery, not a JOIN — a JOIN to workout_cache
    // makes the shared predicates' unqualified columns ambiguous. This proves
    // the statement runs with a workout attached, and reads the right name.
    await db.runAsync(
      `INSERT INTO workout_cache (id, user_id, sport, name, items_json, dirty, remote, updated_at, cached_at, last_error)
       VALUES ('w1', ?, 'strength', 'Push day', '[]', 1, 0, '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z', 'its own refusal')`,
      U,
    );
    const p = await planSession(U, '2026-08-05', 'strength', 'w1');
    await db.runAsync(`UPDATE planned_sessions SET last_error = ? WHERE id = ?`, REFUSED, p.id);
    const listed = await refusedPlans(U);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: p.id, workoutName: 'Push day', workoutId: 'w1' });
  });

  it('never lists or counts another athlete’s refused plans', async () => {
    await refusedPlan();
    await db.runAsync(
      `INSERT INTO planned_sessions (id, user_id, day, sport, notes, created_at, updated_at, dirty, remote, last_error)
       VALUES ('theirs', 'someone_else', '2026-08-05', 'strength', '', '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z', 1, 0, ?)`,
      REFUSED,
    );
    expect(await countRefusedPlans(U)).toBe(1);
    expect((await refusedPlans(U)).map((r) => r.id)).not.toContain('theirs');
  });
});

describe('a refused plan TOMBSTONE is placed deliberately', () => {
  it('a refused DELETE is put back, listed as a refused removal, and NOT pending', async () => {
    const p = await refusedRemoval();
    // Back on the calendar — pushRow's pre-existing restore.
    expect(await plannedFor(U, '2026-08-06')).toHaveLength(1);
    // Not owed, so never pending: resending would be refused identically.
    expect(await countPendingPlans(U)).toBe(0);
    // And explained, rather than reappearing without a word.
    expect(await countRefusedPlans(U)).toBe(1);
    expect(await refusedPlans(U)).toEqual([
      expect.objectContaining({ id: p.id, refused: 'removal', reason: REFUSED_DELETE }),
    ]);
  });

  it('a tombstone still carrying an old refusal is PENDING and not listed', async () => {
    // It is owed and goes out on its own, it has nothing to open, and listing
    // it would show the athlete a plan they have already removed.
    await seedErroredTombstone('tomb');
    expect(await countPendingPlans(U)).toBe(1);
    expect(await countRefusedPlans(U)).toBe(0);
    expect(await refusedPlans(U)).toEqual([]);

    // …and "goes out on its own" is true: never sent, so the next run drops it.
    await syncPlans(U, getToken);
    expect(await rowOf('tomb')).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('pending + blocked covers every owed plan exactly once', () => {
  it('holds across a queued plan, a refused plan, a refused tombstone, a refused removal and a clean plan', async () => {
    // Order matters: the two helpers run real syncs, which would push anything
    // queued before them. So the synced states are built first and the
    // unsynced ones after.
    const refused = await refusedPlan('2026-08-05');
    const removal = await refusedRemoval('2026-08-06');
    const clean = await planSession(U, '2026-08-08', 'strength', null);
    await syncPlans(U, getToken);
    expect(await rowOf(clean.id)).toMatchObject({ dirty: 0, remote: 1 });
    const queued = await planSession(U, '2026-08-04', 'strength', null);
    await seedErroredTombstone('tomb');

    // Every owed plan, read independently of both predicates.
    const owed = (
      await db.getAllAsync<{ id: string }>(
        `SELECT id FROM planned_sessions WHERE user_id = ? AND dirty = 1`,
        U,
      )
    ).map((r) => r.id);
    expect(owed.sort()).toEqual([queued.id, refused.id, 'tomb'].sort());

    const listed = (await refusedPlans(U)).map((r) => r.id);
    const listedAndOwed = listed.filter((id) => owed.includes(id));
    const pending = await countPendingPlans(U);

    // Exactly once: no owed plan both pending and listed, none in neither.
    expect(pending + listedAndOwed.length).toBe(owed.length);
    // And the named placements, so the sum cannot balance by two wrong answers.
    expect(pending).toBe(2); // queued + errored tombstone
    expect(listed.sort()).toEqual([refused.id, removal.id].sort());
    // The count agrees with the list it summarises.
    expect(await countRefusedPlans(U)).toBe(listed.length);
    // A clean plan is in neither.
    expect(listed).not.toContain(clean.id);
  });
});

describe('every local plan edit clears last_error', () => {
  /*
   * The complete list of local edits a plan has on this device, pinned against
   * the module's exports below: `planSession` (a new row, NULL by default — a
   * re-plan after a refusal is a new id) and `unplanSession`. There is no
   * update path on the phone. The remaining exports read, count, sync or act
   * on the repair list, and are classified so a new export must be placed.
   */
  const EDITS = ['planSession', 'unplanSession'];
  const NOT_EDITS = [
    'acknowledgeRefusedRemoval', // repair-list action, tested below; clears the error itself
    'countPendingPlans',
    'countRefusedPlans',
    'listPlannedBetween',
    'plannedFor',
    'refusedPlans',
    'syncPlans',
    'tombstonedPlanIDs',
  ];

  it('the edit list is complete — a new export must be classified', () => {
    const exported = Object.entries(planModule)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    // If this fails, a function was added to plan.ts. If it writes
    // planned_sessions on an athlete's behalf, add it to EDITS and to the
    // table below — and make it clear `last_error`.
    expect(exported).toEqual([...EDITS, ...NOT_EDITS].sort());
  });

  it('a REMOVED, previously refused plan is pending again and actually goes out', async () => {
    const p = await refusedPlan();
    expect(await countPendingPlans(U)).toBe(0);

    await unplanSession(U, p.id);

    expect(await rowOf(p.id)).toMatchObject({ last_error: null, dirty: 1 });
    expect(await countPendingPlans(U)).toBe(1);
    expect(await countRefusedPlans(U)).toBe(0);
  });

  it('a removed plan that WAS on the server clears the refusal too', async () => {
    // A refused removal, removed again: the old reason is about the old request.
    const p = await refusedRemoval();
    await unplanSession(U, p.id);
    expect(await rowOf(p.id)).toMatchObject({ last_error: null, dirty: 1 });
    expect(await countPendingPlans(U)).toBe(1);
    expect(await countRefusedPlans(U)).toBe(0);
  });

  it('a re-planned day is a new, pending row with no refusal', async () => {
    await refusedPlan();
    const again = await planSession(U, '2026-08-05', 'bjj', null);
    expect(await rowOf(again.id)).toMatchObject({ last_error: null, dirty: 1 });
    expect(await countPendingPlans(U)).toBe(1);
  });
});

describe('the recovery actions change something', () => {
  it('CONTROL: left alone, the next sync re-sends the refused create — the thing retry would do', async () => {
    // Proves the test below can fail: without the removal, a sync does send.
    await refusedPlan();
    await syncPlans(U, getToken);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('removing a refused plan takes it off the list, and the next sync sends NOTHING and drops it', async () => {
    const p = await refusedPlan();

    await unplanSession(U, p.id); // what the sync screen's "Remove from plan" calls

    expect(await refusedPlans(U)).toEqual([]);
    await syncPlans(U, getToken);
    // Never on the server, so nothing to tell it: no create, no delete.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await rowOf(p.id)).toBeNull();
    expect(await countPendingPlans(U)).toBe(0);
    expect(await countRefusedPlans(U)).toBe(0);
  });

  it('keeping a refused removal keeps the plan, clears the reason, and sends nothing', async () => {
    const p = await refusedRemoval();

    expect(await acknowledgeRefusedRemoval(U, p.id)).toBe(true);

    expect(await rowOf(p.id)).toMatchObject({ last_error: null, dirty: 0, deleted_at: null });
    expect(await plannedFor(U, '2026-08-06')).toHaveLength(1);
    expect(await refusedPlans(U)).toEqual([]);
    expect(await countRefusedPlans(U)).toBe(0);
    expect(await countPendingPlans(U)).toBe(0);

    await syncPlans(U, getToken);
    expect(mockDelete).not.toHaveBeenCalled();
    // And it survives that sync: the server still holds it, so no sweep.
    expect(await plannedFor(U, '2026-08-06')).toHaveLength(1);
  });

  it('keeping only ever acts on a refused removal — never clears a plan that is still owed', async () => {
    // The compare-and-swap. Called on a refused CREATE (still owed), clearing
    // its reason would move it back into pending, and the triggers would
    // re-send a request the server refuses — the defect this ticket fixes.
    const p = await refusedPlan();
    expect(await acknowledgeRefusedRemoval(U, p.id)).toBe(false);
    expect(await rowOf(p.id)).toMatchObject({ last_error: REFUSED, dirty: 1 });
    expect(await countPendingPlans(U)).toBe(0);
  });

  it('keeping is scoped to the athlete', async () => {
    const p = await refusedRemoval();
    expect(await acknowledgeRefusedRemoval('someone_else', p.id)).toBe(false);
    expect(await rowOf(p.id)).toMatchObject({ last_error: REFUSED_DELETE });
  });
});
