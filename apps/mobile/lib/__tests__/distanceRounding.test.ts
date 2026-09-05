/**
 * N507/#884 — the retry-side half of the fix, against a REAL migrated
 * SQLite database (same pattern as `runningPush.test.ts`, not the fully
 * mocked `../db` other suites use, because this criterion is specifically
 * about what a row already sitting on disk does when it is next read).
 *
 * `Set.distance_m` is `*int` on the wire, so a fractional value — a
 * haversine sum, a HealthKit `HKQuantity.doubleValue` — used to decode-fail
 * server-side into a generic, PERMANENT "invalid JSON body" 400: the exact
 * "Run / Session / invalid JSON body" rows stuck on the Sync screen with
 * "Try again" doing nothing.
 *
 * The investigation this ticket asked for: does `repairSet`/`parseSets`
 * re-run on retry and pick up a freshly-rounded value on its own, or does a
 * stale fractional value already written to local SQLite need an explicit
 * repair/migration step? Answer, proven here: `parseSets` — the ONE gate
 * every stored session's sets go through before a push, per its own doc
 * comment in `sessionStore.ts` — calls `repairSet` fresh from the row on
 * EVERY push, and `repairSet` now rounds `distance_m` (see `roundDistanceM`
 * in `lib/sessions.ts`). So a row already stuck with a fractional value from
 * before this shipped heals the moment anything pushes it again — an
 * ordinary background sync or the Sync screen's "Try again" — with no
 * separate migration needed.
 */
import { getDb } from '../db';
import { migratedFixture, type FixtureDb } from './support/sqlite';
import { pushSession, readLocalSession, startLocalSession } from '../sessionStore';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));

const mockStart = jest.fn();
const mockSets = jest.fn();
jest.mock('../sessions', () => ({
  // `requireActual` first — `sessionStore` also imports pure helpers
  // (`repairSet`, `emptySet`, `roundDistanceM`, ...) from this module, and
  // listing only the network calls would leave those undefined. See
  // `runningPush.test.ts`'s identical comment for the bug this avoids.
  ...jest.requireActual('../sessions'),
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: jest.fn().mockResolvedValue({ session: {}, volume: {} }),
  renameSession: jest.fn(),
  rescheduleSession: jest.fn(),
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
}));

const USER = 'u1';
const getToken = async () => 'token';

/** The exact stuck shape: a fractional distance_m written directly to
 *  `sets_json`, bypassing `saveLocalSets`/its callers entirely — those now
 *  round too, and going through them here would test the WRITE-time fix
 *  instead of this, the READ-time repair for a row already on disk before
 *  the fix shipped. */
async function writeStuckFractionalSet(id: string): Promise<void> {
  const db = await getDb();
  const stuckSets = [
    {
      exercise_id: 'run',
      position: 0,
      set_type: 'working',
      reps: null,
      weight_kg: null,
      seconds: 1500,
      distance_m: 2011.4523,
      rir: null,
      rpe: null,
      notes: '',
      completed: true,
    },
  ];
  await db.runAsync(
    `UPDATE local_sessions SET sets_json = ?, dirty = 1, last_error = ? WHERE id = ? AND user_id = ?`,
    JSON.stringify(stuckSets),
    'invalid JSON body',
    id,
    USER,
  );
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockStart.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
  mockSets.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
});

it('a session already stuck on-device with a fractional distance_m heals on the next retry, with no migration', async () => {
  const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
  // Get the session onto the server first, mirroring the ordinary state a
  // run already synced its CREATE and is now stuck only on its SETS push —
  // exactly what a permanent 400 on the sets replace looks like.
  await pushSession(USER, session.id, getToken);
  mockSets.mockClear();

  await writeStuckFractionalSet(session.id);

  // "Try again" / the next background sync: a plain re-push, nothing special.
  await pushSession(USER, session.id, getToken);

  expect(mockSets).toHaveBeenCalledTimes(1);
  const [, , sentSets] = mockSets.mock.calls[0];
  expect(sentSets).toHaveLength(1);
  expect(sentSets[0].distance_m).toBe(2011);
  expect(Number.isInteger(sentSets[0].distance_m)).toBe(true);

  // The row goes clean — the fix actually unsticks it, not merely "would
  // have sent a nicer number".
  const db = await getDb();
  const row = await db.getFirstAsync<{ dirty: number }>(
    `SELECT dirty FROM local_sessions WHERE id = ?`,
    session.id,
  );
  expect(row?.dirty).toBe(0);
});

it('the stuck row is unreadable as fractional even on the SCREEN, not only on push — repairSet runs on every read', async () => {
  // `toSession` (what the session screen renders) goes through the exact
  // same `parseSets` gate as `pushRow` — see that function's own doc
  // comment for why a repair belongs there and nowhere else.
  const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
  await writeStuckFractionalSet(session.id);

  const read = await readLocalSession(USER, session.id);
  expect(read?.sets[0].distance_m).toBe(2011);
});
