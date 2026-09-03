import {
  pushSession,
  readLocalRunningDetail,
  saveLocalRunningDetail,
  startLocalSession,
} from '../sessionStore';
import { ApiError } from '../apiError';
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
const mockDeleteSession = jest.fn();
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
  deleteSession: (...a: unknown[]) => mockDeleteSession(...a),
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
  mockDeleteSession.mockReset().mockImplementation(async () => ({}));
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

/**
 * N465's own dedup backstop, exercised at the point it actually bites: the
 * detail PUT's 409 (`running.ErrAlreadyExists`, migration 000087's per-user
 * unique index) reaching this device's outbox. See
 * `abandonDuplicateHealthKitImport`'s doc comment in `sessionStore.ts` for
 * the full argument — this is the fix for the gap `backend-reviewer` and
 * `frontend-reviewer` both found independently: without it, the generic
 * session (already created and pushed by the time this 409 fires) was left
 * behind forever, permanently dirty, a real duplicate in Training History.
 */
describe('a HealthKit import whose UUID already belongs to a different session (409)', () => {
  function healthkitDetail(id: string, uuid: string): RunningDetail {
    return {
      session_id: id,
      route_points: [],
      splits: [],
      elevation_gain_m: null,
      avg_pace_sec_per_km: null,
      distance_m: 5000,
      duration_seconds: 1500,
      source: 'healthkit',
      healthkit_uuid: uuid,
    };
  }

  it('deletes the local AND server-side session outright, rather than leaving it permanently dirty', async () => {
    const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
    await saveLocalRunningDetail(USER, session.id, healthkitDetail(session.id, 'hk-dup-1'));
    mockPutRunningDetail.mockRejectedValueOnce(
      new ApiError('already exists', 'already_exists', 409),
    );

    await expect(pushSession(USER, session.id, getToken)).resolves.toBeUndefined();

    expect(mockDeleteSession).toHaveBeenCalledWith(getToken, session.id);
    // Gone entirely — not a tombstone. Nothing is left for the next sync to
    // retry, and nothing is left in Training History to read as a duplicate.
    expect(await rowFlags(session.id)).toBeNull();
  });

  it('falls back to an ordinary tombstone when the server delete itself fails transiently', async () => {
    const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
    await saveLocalRunningDetail(USER, session.id, healthkitDetail(session.id, 'hk-dup-2'));
    mockPutRunningDetail.mockRejectedValueOnce(
      new ApiError('already exists', 'already_exists', 409),
    );
    mockDeleteSession.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(pushSession(USER, session.id, getToken)).resolves.toBeUndefined();

    // Not hard-deleted — the server delete never confirmed, so the ordinary
    // tombstone path (pushRow's own `deleted_at` branch) has to retry it.
    const row = await db.getFirstAsync<{ deleted_at: string | null; dirty: number }>(
      `SELECT deleted_at, dirty FROM local_sessions WHERE id = ?`,
      session.id,
    );
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.dirty).toBe(1);
  });

  it('a 404 on the server delete (already gone) is treated the same as success', async () => {
    const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
    await saveLocalRunningDetail(USER, session.id, healthkitDetail(session.id, 'hk-dup-3'));
    mockPutRunningDetail.mockRejectedValueOnce(
      new ApiError('already exists', 'already_exists', 409),
    );
    mockDeleteSession.mockRejectedValueOnce(new ApiError('not found', 'not_found', 404));

    await expect(pushSession(USER, session.id, getToken)).resolves.toBeUndefined();

    expect(await rowFlags(session.id)).toBeNull();
  });

  it('a 409 on a NON-healthkit session is not treated as a duplicate — gated on source', async () => {
    // This endpoint has no other 409 source today (see the comment at the
    // call site in sessionStore.ts), but the gate must hold anyway: a 409
    // reaching a phone_gps push must not silently delete a real, tracked run.
    const session = await startLocalSession(USER, { sport: 'running', name: 'Run', sets: [] });
    await saveLocalRunningDetail(USER, session.id, detail(session.id, 3, 120));
    mockPutRunningDetail.mockRejectedValueOnce(
      new ApiError('already exists', 'already_exists', 409),
    );

    await expect(pushSession(USER, session.id, getToken)).rejects.toThrow();

    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect((await rowFlags(session.id))?.dirty).toBe(1);
  });
});
