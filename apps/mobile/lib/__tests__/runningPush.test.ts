import {
  pushSession,
  readLocalRunningDetail,
  saveLocalRunningDetail,
  startLocalSession,
} from '../sessionStore';
import type { RoutePoint, SessionDetail as RunningDetail } from '../running';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * GPS points buffer locally and survive a simulated network drop (N460/#771
 * acceptance criterion), against a REAL migrated SQLite database — not the
 * fully-mocked `../db` `bjjPush.test.ts` uses, because this criterion is
 * specifically about what SQLite still holds after a rejected push, and a
 * mock that merely records which SQL ran cannot answer that.
 *
 * Mirrors `planSync.test.ts`'s pattern: a real fixture underneath, the
 * network call (`running.putDetail`, via `sessionStore`'s `pushRunningDetail`
 * import) mocked so a "drop" is a controlled rejection rather than an
 * actual severed connection.
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

const mockStart = jest.fn();
const mockSets = jest.fn();
const mockFinish = jest.fn();
jest.mock('../sessions', () => ({
  // `requireActual` first — `sessionStore` also imports pure helpers
  // (`repairSet`, `emptySet`, ...) from this module, and listing only the
  // network calls would leave those undefined. See `bjjPush.test.ts`'s
  // identical comment for the bug this avoids.
  ...jest.requireActual('../sessions'),
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: (...a: unknown[]) => mockFinish(...a),
  renameSession: jest.fn(),
  rescheduleSession: jest.fn(),
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
}));

const mockPutRunningDetail = jest.fn();
jest.mock('../running', () => ({
  ...jest.requireActual('../running'),
  putDetail: (...a: unknown[]) => mockPutRunningDetail(...a),
}));

const USER = 'u1';
const getToken = async () => 'token';

/** A short, valid GPS track — enough to exercise the JSON round-trip. */
function track(points: number): RoutePoint[] {
  return Array.from({ length: points }, (_, i) => ({
    lat: 37 + i * 0.0009,
    lng: -122.4,
    elevation_m: null,
    recorded_at: new Date(Date.parse('2026-01-01T08:00:00Z') + i * 60_000).toISOString(),
  }));
}

function detail(id: string, points: number, durationSeconds: number): RunningDetail {
  return {
    session_id: id,
    route_points: track(points),
    splits: [],
    elevation_gain_m: null,
    avg_pace_sec_per_km: null,
    distance_m: null,
    duration_seconds: durationSeconds,
    source: 'phone_gps',
  };
}

/** The raw row's sync flags, for asserting on outbox state the public API hides. */
async function rowFlags(id: string) {
  return db.getFirstAsync<{ dirty: number; remote: number; running_json: string | null }>(
    `SELECT dirty, remote, running_json FROM local_sessions WHERE id = ?`,
    id,
  );
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockStart.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
  mockSets.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
  mockFinish.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
  mockPutRunningDetail.mockReset().mockImplementation(async () => ({ detail: {} }));
});

it('a GPS track saved locally survives a rejected push, untouched', async () => {
  const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
  // Get the session onto the server first — the ordinary state a run is in
  // by the time GPS points start arriving (create/sets already synced).
  await pushSession(USER, session.id, getToken);
  expect((await rowFlags(session.id))?.remote).toBe(1);

  // Mid-run: three points land while the phone still has signal, buffered
  // to SQLite exactly as `app/running/[id].tsx`'s `persistProgress` does.
  const d = detail(session.id, 3, 120);
  await saveLocalRunningDetail(USER, session.id, d);
  const buffered = await rowFlags(session.id);
  expect(buffered?.dirty).toBe(1);
  expect(JSON.parse(buffered!.running_json!)).toMatchObject({
    route_points: d.route_points,
    duration_seconds: 120,
  });

  // The network drop: the PUT to /running/sessions/{id} fails, the same
  // "Network request failed" shape `planSync.test.ts` uses to simulate one.
  mockPutRunningDetail.mockRejectedValueOnce(new Error('Network request failed'));

  await expect(pushSession(USER, session.id, getToken)).rejects.toThrow();

  // The track is UNCHANGED and still owed — nothing about a failed push may
  // touch what is already safely on disk, and the row must stay dirty so
  // the next sync attempt (offline or not) retries it rather than losing it.
  const afterDrop = await rowFlags(session.id);
  expect(afterDrop?.dirty).toBe(1);
  expect(afterDrop?.remote).toBe(1); // the session itself was never un-created
  expect(JSON.parse(afterDrop!.running_json!)).toEqual(JSON.parse(buffered!.running_json!));
  expect(await readLocalRunningDetail(USER, session.id)).toMatchObject({
    route_points: d.route_points,
    duration_seconds: 120,
  });
});

it('the same track pushes successfully once the network returns, with the full track in the PUT body', async () => {
  const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
  await pushSession(USER, session.id, getToken);

  const d = detail(session.id, 5, 300);
  await saveLocalRunningDetail(USER, session.id, d);

  // First attempt: still offline.
  mockPutRunningDetail.mockRejectedValueOnce(new Error('Network request failed'));
  await expect(pushSession(USER, session.id, getToken)).rejects.toThrow();
  expect((await rowFlags(session.id))?.dirty).toBe(1);

  // Connectivity returns — the retry is a PLAIN RE-PUSH, no special "resume"
  // path, because the outbox always sends "what the row says now".
  mockPutRunningDetail.mockReset().mockResolvedValue({ detail: {} });
  await pushSession(USER, session.id, getToken);

  expect(mockPutRunningDetail).toHaveBeenCalledTimes(1);
  // The PUT body carries the exact track and duration that were buffered —
  // nothing was lost or altered by the dropped attempt in between.
  const [, sentID, sentDetail] = mockPutRunningDetail.mock.calls[0];
  expect(sentID).toBe(session.id);
  expect(sentDetail).toMatchObject({
    route_points: d.route_points,
    duration_seconds: 300,
    source: 'phone_gps',
  });
  expect(await rowFlags(session.id)).toMatchObject({ dirty: 0, remote: 1 });
});

it('a strength session never attempts a running-detail push at all', async () => {
  const session = await startLocalSession(USER, { sport: 'strength', name: 'Push day', sets: [] });
  await pushSession(USER, session.id, getToken);

  expect(mockPutRunningDetail).not.toHaveBeenCalled();
  expect((await rowFlags(session.id))?.running_json).toBeNull();
});

it('a corrupt running blob degrades rather than failing the whole push', async () => {
  // Same posture as `bjjPush.test.ts`'s identical case: the session and its
  // timing are already worth keeping, and a blob that no longer parses is
  // not a reason to strand them.
  const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
  await db.runAsync(
    `UPDATE local_sessions SET running_json = ?, dirty = 1 WHERE id = ?`,
    '{not json',
    session.id,
  );

  await pushSession(USER, session.id, getToken);

  expect(mockPutRunningDetail).not.toHaveBeenCalled();
  expect((await rowFlags(session.id))?.dirty).toBe(0);
});
