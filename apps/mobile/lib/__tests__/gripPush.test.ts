import { ApiError } from '../apiError';
import { pushSession, saveLocalSets } from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

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
 * and a write with no compare-and-swap that could delete a mid-push edit.
 *
 * **Against a real database, deliberately.** The first version of this file
 * mocked `lib/db` with a hand-rolled object that returned a settable `changes`
 * for the repair's UPDATE — and that mock WAS the compare-and-swap. Deleting
 * `AND updated_at = ?` from the production SQL while leaving the JS guard in
 * place kept the whole suite green, so the test could not see the very hole it
 * was written for. Exactly the failure `support/sqlite.ts` was built to end: a
 * mock silently supplying the behaviour under test. The fixture runs the app's
 * own migrations, so the clause is enforced by SQLite or not at all.
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

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

/**
 * A grip no build in the wild knows, standing in for the one a future server
 * adds.
 *
 * Was `'mixed'` until N9 shipped it, at which point both halves of that
 * sentence became false — this build offers a chip for it and the server on the
 * same branch accepts it. Nothing here was mechanically disarmed (the refusal
 * is injected by mock, and the retry assertions also cover a known grip), but a
 * fixture whose premise is a lie is one rename away from testing the opposite
 * deploy window. Same rule as the repairSet probes: always outside the current
 * six.
 */
const FUTURE_GRIP = 'mixed_left';

const set = (position: number, grip: string | null) => ({
  exercise_id: 'bench-press', position, set_type: 'working', reps: 5, weight_kg: 100,
  seconds: null, distance_m: null, rir: null, rpe: null, notes: '', completed: true, grip,
});

const SETS = [set(0, FUTURE_GRIP), set(1, 'neutral')];
/** What an athlete ticking another set mid-push would leave behind. */
const LATER_SETS = [...SETS, set(2, FUTURE_GRIP)];

const AT = '2026-08-01T10:00:00Z';
/** Shaped like the wire's — `validateSets` writes "set 1: unknown grip". */
const refused = () => new ApiError('set 1: unknown grip', 'invalid_grip', 400);

const seed = async (remote = 1) => {
  mockFixture = await migratedFixture();
  await mockFixture.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, name_dirty, bjj_json)
     VALUES (?, 'u1', NULL, 'strength', 'Bench', '2026-08-01T09:00:00Z', ?, '',
             ?, 1, ?, NULL, ?, 0, NULL)`,
    's1',
    AT,
    JSON.stringify(SETS),
    remote,
    AT,
  );
};

const rowNow = async () =>
  (await mockFixture.getFirstAsync<{
    sets_json: string;
    dirty: number;
    remote: number;
    updated_at: string;
  }>(`SELECT sets_json, dirty, remote, updated_at FROM local_sessions WHERE id = 's1'`))!;

const grips = (sets: { grip?: unknown }[]) => sets.map((s) => s.grip);
const storedGrips = async () => grips(JSON.parse((await rowNow()).sets_json));

beforeEach(() => {
  // Dropped, not merely replaced by the next `seed()`. Left pointing at the
  // previous test's database, a case that forgot to seed would find no dirty
  // row, push nothing, and be satisfied by the state its predecessor left — a
  // vacuous pass, demonstrated: deleting one `await seed()` kept all eleven
  // green. Only the first test in the file failed loudly. `cacheRace.test.ts`
  // resets it for the same reason.
  mockFixture = undefined as never;
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
    await seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockSets).toHaveBeenCalledTimes(2);
    expect(grips(mockSets.mock.calls[0][2])).toEqual([FUTURE_GRIP, 'neutral']);
    expect(grips(mockSets.mock.calls[1][2])).toEqual([null, null]);
    expect((await rowNow()).dirty).toBe(0);
  });

  it('persists the repair, so the next push cannot send the refused grip again', async () => {
    await seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(await storedGrips()).toEqual([null, null]);
  });

  it('falls through to the finish rather than returning', async () => {
    // Returning early here would let an unknown grip cost the session its
    // `ended_at` — and a session with no duration counts for nothing at all in
    // history. The same "optional half costing the mandatory one" shape the BJJ
    // reflection ordering exists to prevent.
    await seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockFinish).toHaveBeenCalledWith(expect.anything(), 's1', AT);
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
    await seed(0);
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
    await seed(0);
    mockStart.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(grips(mockSets.mock.calls[0][2])).toEqual([null, null]);
    expect((await rowNow()).dirty).toBe(0);
  });

  it('keeps the rest of the create intact', async () => {
    // Only the grips are dropped. A retry that lost `ended_at` would cost the
    // session its duration to settle a disagreement about a different field.
    await seed(0);
    mockStart.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(mockStart.mock.calls[1][1]).toMatchObject({
      id: 's1',
      started_at: '2026-08-01T09:00:00Z',
      ended_at: AT,
    });
  });
});

/**
 * The compare-and-swap, and the data loss it exists to prevent.
 *
 * `saveLocalSets` bumps `updated_at` on every edit and a live session pushes on
 * every debounced save, so an athlete ticking a set mid-push is the ordinary
 * state. Without the swap, the repair writes the sets read at the START of the
 * push back over that newer edit — the athlete's last reps deleted locally, to
 * settle a refusal about a grip.
 *
 * The edit below is a REAL `saveLocalSets` against the real row, landing exactly
 * where it would in production: after the push has read the sets, before the
 * repair writes them back. Nothing here simulates the swap — SQLite decides.
 */
describe('an edit that lands mid-push', () => {
  it('declines the repair rather than writing stale sets over it', async () => {
    await seed();
    mockSets.mockImplementationOnce(async () => {
      await saveLocalSets('u1', 's1', LATER_SETS as never);
      throw refused();
    });

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow(ApiError);

    const after = await rowNow();
    // The third set survives, and so do the grips on all three. Had the repair
    // written its stale list, this would be two sets with null grips — an
    // athlete's last logged set gone, silently, with the sync reporting only a
    // grip complaint.
    expect(JSON.parse(after.sets_json)).toEqual(LATER_SETS);
    // No retry, because the list to retry with was never established.
    expect(mockSets).toHaveBeenCalledTimes(1);
    // And the row stays dirty, so the next sync re-reads the athlete's newer
    // sets and repairs THOSE. The cost of declining is one cycle, not the edit.
    expect(after.dirty).toBe(1);
  });

  it('still repairs when nothing changed underneath it', async () => {
    // The other half: without this, "never repair at all" would pass the test
    // above. Same fixture, same code path, no concurrent edit.
    await seed();
    mockSets.mockRejectedValueOnce(refused());

    await pushSession('u1', 's1', async () => 'tok');

    expect(await storedGrips()).toEqual([null, null]);
    expect((await rowNow()).dirty).toBe(0);
  });

  /*
   * The SAME race on a push that SUCCEEDS, which is the commoner one and had
   * nothing pinning it at all.
   *
   * `pushRow` ends by clearing `dirty` under the identical
   * `AND updated_at = ?`, and its comment says why: "or we'd mark a newer edit
   * as already sent and silently drop it". Review measured that clause deleted
   * against the whole suite — **1256 tests, all green**. So the guard the grip
   * repair was modelled on was itself unguarded, and the failure needs no
   * refused grip to happen: finish a set while an ordinary push is in flight,
   * the row is marked clean, and that set never reaches the server. It is the
   * `completed`-flag shape again, and `retryBlockedRow` explicitly leans on
   * this swap to know whether a repair actually worked.
   *
   * Not introduced by T4 — but T4 is the branch that built the fixture able to
   * see it, and it was one case away.
   */
  it('does not mark the row clean when an edit landed during a SUCCESSFUL push', async () => {
    await seed();
    mockSets.mockImplementationOnce(async () => {
      await saveLocalSets('u1', 's1', LATER_SETS as never);
    });

    await pushSession('u1', 's1', async () => 'tok');

    const after = await rowNow();
    expect(JSON.parse(after.sets_json)).toEqual(LATER_SETS);
    // Still owed to the server. Cleared here, the third set is on this phone
    // and nowhere else, with nothing left saying so.
    expect(after.dirty).toBe(1);
  });
});

describe('refusals that are not about a grip', () => {
  it('never repairs, and never writes', async () => {
    await seed();
    mockSets.mockRejectedValue(new ApiError('RPE must be 1-10', 'invalid_input', 400));

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

    expect(mockSets).toHaveBeenCalledTimes(1);
    expect(await storedGrips()).toEqual([FUTURE_GRIP, 'neutral']);
    expect((await rowNow()).dirty).toBe(1);
  });

  it('forgets `remote` on a 404, so the next sync recreates the session', async () => {
    await seed();
    mockSets.mockRejectedValue(new ApiError('gone', 'not_found', 404));

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

    expect((await rowNow()).remote).toBe(0);
  });

  it('forgets `remote` on a 404 the RETRY hits', async () => {
    // Reachable because the server validates sets before it checks the session
    // exists: "deleted on another device AND holding a refused grip" answers
    // `invalid_grip` first and 404 only on the way back. Missing it there would
    // cost a sync cycle, since nothing would recreate the session.
    await seed();
    mockSets
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(new ApiError('gone', 'not_found', 404));

    await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

    expect((await rowNow()).remote).toBe(0);
  });
});
