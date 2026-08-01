import { cacheWorkouts, cachedWorkouts } from '../sessionStore';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The workout cache, and the ownership it used to invent.
 *
 * `cachedWorkouts` returned `owner_user_id: userID` and a hardcoded
 * `visibility: 'private'`. `app/workout/[id].tsx` derives `canEdit` from
 * exactly that field — so offline, **every** cached workout looked editable,
 * including VOLA's ownerless templates and other athletes' public ones. The
 * Save button appeared for things the server refuses, and the "VOLA template"
 * label vanished because nothing was ever null.
 *
 * Run against a real database, because the bug was in what the columns hold.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const workout = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  owner_user_id: 'u1',
  name: 'Legs',
  sport: 'strength',
  goal: 'strength' as const,
  notes: '',
  visibility: 'private' as const,
  items: [],
  created_at: '',
  updated_at: '',
  ...over,
});

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

it("keeps a VOLA template's null owner, so it never looks editable", async () => {
  // The headline case. `canEdit` is `owner_user_id !== null && === userId`,
  // so inventing an owner here hands the athlete a Save button the server
  // will refuse — and hides the "VOLA template" label that explains why.
  await cacheWorkouts('u1', [workout({ id: 'vola1', owner_user_id: null })]);

  const [cached] = await cachedWorkouts('u1');
  expect(cached.owner_user_id).toBeNull();
});

it("keeps another athlete's ownership rather than claiming it", async () => {
  await cacheWorkouts('u1', [workout({ id: 'w2', owner_user_id: 'u2', visibility: 'public' })]);

  const [cached] = await cachedWorkouts('u1');
  expect(cached.owner_user_id).toBe('u2');
  expect(cached.visibility).toBe('public');
});

it('keeps your own ownership, so your templates stay editable', async () => {
  await cacheWorkouts('u1', [workout({ owner_user_id: 'u1' })]);
  expect((await cachedWorkouts('u1'))[0].owner_user_id).toBe('u1');
});

it('re-caching an updated workout corrects a changed visibility', async () => {
  await cacheWorkouts('u1', [workout({ visibility: 'private' })]);
  await cacheWorkouts('u1', [workout({ visibility: 'public' })]);
  expect((await cachedWorkouts('u1'))[0].visibility).toBe('public');
});

it('returns every discipline when no sport is given', async () => {
  // What the Plan tab needs — it lists across disciplines.
  await cacheWorkouts('u1', [
    workout({ id: 'a', sport: 'strength' }),
    workout({ id: 'b', sport: 'bjj' }),
  ]);
  expect((await cachedWorkouts('u1')).map((w) => w.id).sort()).toEqual(['a', 'b']);
});

it('narrows to one discipline when asked', async () => {
  await cacheWorkouts('u1', [
    workout({ id: 'a', sport: 'strength' }),
    workout({ id: 'b', sport: 'bjj' }),
  ]);
  expect((await cachedWorkouts('u1', 'bjj')).map((w) => w.id)).toEqual(['b']);
});

it("does not serve one athlete's cache to another", async () => {
  await cacheWorkouts('u1', [workout()]);
  expect(await cachedWorkouts('u2')).toEqual([]);
});
