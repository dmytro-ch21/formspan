import {
  readCollapsedGroups,
  readLocalSession,
  saveCollapsedGroups,
  saveLocalSets,
  startLocalSession,
  upsert,
  type LocalSession,
} from '../sessionStore';
import type { LoggedSet } from '../sessions';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Per-exercise "Done" (N530/#961): the persisted half, against real SQLite.
 *
 * Three properties, each of which a mock could have supplied for free:
 *
 *  1. It round-trips, and it survives what a screen re-open does (a fresh
 *     read of the same row).
 *  2. **It writes nothing to any set** — `sets_json` is byte-identical before
 *     and after, `dirty` is untouched, `updated_at` is untouched. This is the
 *     ticket's "assert no `completed` flag changes", asserted on the stored
 *     bytes rather than on a field.
 *  3. A pull (the upsert with the server's copy) does not reset it, because
 *     `collapsed_json` is deliberately absent from the upsert's SET list.
 */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'u1';

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'back-squat',
  position: 0,
  set_type: 'working',
  reps: 8,
  weight_kg: 100,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  grip: undefined,
  notes: '',
  completed: false,
  performed_at: null,
  ...over,
});

type Stored = { sets_json: string; dirty: number; updated_at: string; collapsed_json: string };
const stored = async (id: string): Promise<Stored> =>
  (await mockFixture.getFirstAsync<Stored>(
    `SELECT sets_json, dirty, updated_at, collapsed_json FROM local_sessions WHERE id = ?`,
    id,
  ))!;

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

it('a fresh session has nothing collapsed', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  expect(await readCollapsedGroups(USER, s.id)).toEqual([]);
  expect((await stored(s.id)).collapsed_json).toBe('[]');
});

it('round-trips, and reads the same on a fresh read of the row', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  await saveCollapsedGroups(USER, s.id, ['back-squat#0']);
  expect(await readCollapsedGroups(USER, s.id)).toEqual(['back-squat#0']);
  // Toggle back open — the screen's own re-expand.
  await saveCollapsedGroups(USER, s.id, []);
  expect(await readCollapsedGroups(USER, s.id)).toEqual([]);
});

it('writes NOTHING to any set — sets_json, dirty and updated_at are byte-identical', async () => {
  // One ticked, one not. Done must leave the unticked one unticked.
  const sets = [set({ completed: true, performed_at: '2026-09-08T10:00:00.000Z' }), set({ position: 1 })];
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets });
  // Mark the row clean first, so a stray `dirty = 1` in the save would show.
  await mockFixture.runAsync(`UPDATE local_sessions SET dirty = 0 WHERE id = ?`, s.id);
  const before = await stored(s.id);

  await saveCollapsedGroups(USER, s.id, ['back-squat#0']);

  const after = await stored(s.id);
  expect(after.sets_json).toBe(before.sets_json);
  expect(after.dirty).toBe(0);
  expect(after.updated_at).toBe(before.updated_at);
  expect(after.collapsed_json).toBe('["back-squat#0"]');
  // And read back through the app's own gate: the completed flags are exactly
  // what was written at start.
  const back = (await readLocalSession(USER, s.id))!;
  expect(back.sets.map((x) => x.completed)).toEqual([true, false]);
});

it('a set edit after Done leaves the fold in place', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  await saveCollapsedGroups(USER, s.id, ['back-squat#0']);
  await saveLocalSets(USER, s.id, [set({ completed: true })]);
  expect(await readCollapsedGroups(USER, s.id)).toEqual(['back-squat#0']);
});

it("a pull of the server's copy does not reset it", async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  // A clean, acknowledged row — the state the pull writes over.
  await mockFixture.runAsync(`UPDATE local_sessions SET dirty = 0, remote = 1 WHERE id = ?`, s.id);
  await saveCollapsedGroups(USER, s.id, ['back-squat#0']);

  const fromServer: LocalSession = {
    ...s,
    sets: [set({ completed: true })],
    updated_at: '2099-01-01T00:00:00.000Z',
    dirty: false,
  };
  await upsert(fromServer, USER, false, true);

  // The pull landed…
  expect(JSON.parse((await stored(s.id)).sets_json)[0].completed).toBe(true);
  // …and the fold survived it.
  expect(await readCollapsedGroups(USER, s.id)).toEqual(['back-squat#0']);
});

it('reads [] for a session this device does not hold, and for another user', async () => {
  expect(await readCollapsedGroups(USER, 'nope')).toEqual([]);
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  await saveCollapsedGroups(USER, s.id, ['back-squat#0']);
  expect(await readCollapsedGroups('someone-else', s.id)).toEqual([]);
});

it('a save scoped to another user changes nothing', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  await saveCollapsedGroups('someone-else', s.id, ['back-squat#0']);
  expect((await stored(s.id)).collapsed_json).toBe('[]');
});

it('an unreadable blob reads as nothing collapsed', async () => {
  const s = await startLocalSession(USER, { sport: 'strength', name: 'Legs', sets: [set()] });
  await mockFixture.runAsync(`UPDATE local_sessions SET collapsed_json = 'garbage' WHERE id = ?`, s.id);
  expect(await readCollapsedGroups(USER, s.id)).toEqual([]);
});
