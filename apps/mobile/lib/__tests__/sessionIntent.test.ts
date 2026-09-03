import { pushSession, readLocalSession, startLocalSession, upsert } from '../sessionStore';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * N474 — what the athlete meant a strength session to be (normal/light/deload),
 * against a REAL migrated SQLite database. Mirrors `runningPush.test.ts`'s
 * pattern: a real fixture underneath, the network call mocked so the create
 * push is a controlled assertion rather than an actual request.
 *
 * The point this file exists to pin: a light/deload session is written and
 * synced exactly like a normal one (it is still real training, still counted
 * for volume) — the ONLY thing different about it is the value carried in
 * this one column. See `progression_test.go`'s `TestProgress_*` suite on the
 * backend for the half of this feature that actually reads the column.
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
jest.mock('../sessions', () => ({
  // `requireActual` first — `sessionStore` also imports pure helpers from
  // this module, and listing only the network calls would leave those
  // undefined. See `bjjPush.test.ts`'s identical comment for the bug this
  // avoids.
  ...jest.requireActual('../sessions'),
  startSession: (...a: unknown[]) => mockStart(...a),
  replaceSets: (...a: unknown[]) => mockSets(...a),
  finishSession: jest.fn(),
  renameSession: jest.fn(),
  rescheduleSession: jest.fn(),
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
}));

const USER = 'u1';
const getToken = async () => 'token';

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockStart.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
  mockSets.mockReset().mockImplementation(async () => ({ session: {}, volume: {} }));
});

it('a session started with no intent reads back as normal', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Push day', sets: [] });
  expect(s.intent).toBe('normal');
  const reread = await readLocalSession(USER, s.id);
  expect(reread?.intent).toBe('normal');
});

it('a session started as light is stored and read back as light, not normal', async () => {
  const s = await startLocalSession(USER, {
    sport: 'strength',
    name: 'Push day',
    intent: 'light',
    sets: [],
  });
  expect(s.intent).toBe('light');
  const reread = await readLocalSession(USER, s.id);
  expect(reread?.intent).toBe('light');
});

it('a deload session survives the actual SQLite round-trip untouched', async () => {
  const s = await startLocalSession(USER, {
    sport: 'strength',
    name: 'Deload week',
    intent: 'deload',
    sets: [],
  });
  const row = await db.getFirstAsync<{ intent: string }>(
    `SELECT intent FROM local_sessions WHERE id = ?`,
    s.id,
  );
  expect(row?.intent).toBe('deload');
});

it('pushing a light session sends its intent on the create call, not silently as normal', async () => {
  const s = await startLocalSession(USER, {
    sport: 'strength',
    name: 'Push day',
    intent: 'light',
    sets: [],
  });
  await pushSession(USER, s.id, getToken);
  expect(mockStart).toHaveBeenCalledWith(
    getToken,
    expect.objectContaining({ intent: 'light' }),
  );
});

it('a server-pulled session carries its intent onto the local row (upsert)', async () => {
  // Same shape `runSync`'s pull loop upserts with — the server's copy,
  // `dirty: false`. Exercised directly here rather than through the whole
  // sync loop, the same scoping `pullClobber.test.ts` uses for this upsert.
  await upsert(
    {
      id: 'from-server',
      user_id: USER,
      workout_id: null,
      sport: 'strength',
      name: 'Legs',
      intent: 'deload',
      started_at: '2026-08-01T10:00:00Z',
      ended_at: '2026-08-01T11:00:00Z',
      notes: '',
      sets: [],
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-01T10:00:00Z',
      dirty: false,
    },
    USER,
    false,
    true,
  );
  const reread = await readLocalSession(USER, 'from-server');
  expect(reread?.intent).toBe('deload');
});
