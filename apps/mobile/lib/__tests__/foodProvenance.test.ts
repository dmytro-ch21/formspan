/**
 * N532/#963 — a saved food remembers who shared it; the list sorts.
 *
 * Against a REAL SQLite database through `migratedFixture()`, same reason as
 * `savedFoods.test.ts`: every claim below is about what a column and an
 * ORDER BY actually do, and a regex over the query string would prove a
 * clause is present and nothing about whether SQLite honours it.
 */

import { ApiError } from '../apiError';
import {
  localFood,
  localFoods,
  logFood,
  recentlySharedFoods,
  saveFoodLocally,
  syncFood,
} from '../foodLog';
import type { Food } from '../nutrition';
import {
  DEFAULT_SAVED_FOODS_SORT,
  RECENTLY_SHARED_DAYS,
  RECENTLY_SHARED_LIMIT,
  SAVED_FOODS_SORTS,
  parseSavedFoodsSort,
} from '../savedFoodsSort';
import { migratedFixture, type FixtureDb } from './support/sqlite';

const USER = 'receiver';

let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const token = async () => 'tok';

/** What `GET /nutrition/foods` answers, per test. */
let serverFoods: Food[] = [];

beforeEach(async () => {
  mockUuidSeq = 0;
  serverFoods = [];
  mockFixture = await migratedFixture();
  mockApi.mockReset().mockImplementation(async (_t: unknown, url: string) => {
    if (url.startsWith('/nutrition/foods')) return { foods: serverFoods };
    if (url.startsWith('/nutrition/entries')) return { entries: [] };
    return {};
  });
});

/** A food as the server sends it — with provenance when `shared` is given. */
function serverFood(
  id: string,
  name: string,
  over: Partial<Food> = {},
): Food {
  return {
    id,
    kind: 'food',
    name,
    brand: '',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 100,
    protein_g: 10,
    carb_g: 10,
    fat_g: 2,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source: 'user',
    yield_servings: null,
    items: [],
    shared_by: null,
    shared_at: null,
    created_at: '2026-09-01T10:00:00Z',
    ...over,
  };
}

const NOW = new Date('2026-09-08T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('the pull carries provenance into the cache', () => {
  // N428's scenario: a fresh install has nothing local, syncs, and must show
  // who shared what — the provenance has to arrive by pull or it does not
  // arrive at all.
  it('a fresh install reads shared_by and shared_at off the pulled row', async () => {
    serverFoods = [
      serverFood('shared-1', 'Ana’s açaí bowl', {
        shared_by: 'ana_bjj',
        shared_at: daysAgo(2),
      }),
      serverFood('own-1', 'My porridge'),
    ];
    await syncFood(USER, token);

    const shared = (await localFood(USER, 'shared-1'))!;
    expect(shared.shared_by).toBe('ana_bjj');
    expect(shared.shared_at).toBe(daysAgo(2));
    // The athlete's own food reads as NOT shared — null, never undefined, so
    // a screen's "is this shared" test is a comparison rather than a guess.
    const own = (await localFood(USER, 'own-1'))!;
    expect(own.shared_by).toBeNull();
    expect(own.shared_at).toBeNull();
  });

  // The handle is resolved live on the server. A later pull that says the
  // sender has a NEW handle — or no handle at all — must replace what is
  // cached, or "resolved live" is a claim the phone quietly breaks.
  it('a later pull replaces the cached handle, including with null', async () => {
    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana_bjj', shared_at: daysAgo(1) })];
    await syncFood(USER, token);

    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana_renamed', shared_at: daysAgo(1) })];
    await syncFood(USER, token);
    expect((await localFood(USER, 's'))!.shared_by).toBe('ana_renamed');

    serverFoods = [serverFood('s', 'Bowl', { shared_by: null, shared_at: daysAgo(1) })];
    await syncFood(USER, token);
    const after = (await localFood(USER, 's'))!;
    expect(after.shared_by).toBeNull();
    // Still shared — the sender losing their handle does not un-share it.
    expect(after.shared_at).toBe(daysAgo(1));
  });

  // Mid-rollout: a server that predates N532 sends neither field. That is
  // "I have nothing to say", not "this was never shared", and the cache must
  // keep what a newer server already told it.
  it('a server that sends neither field leaves the stored provenance alone', async () => {
    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana_bjj', shared_at: daysAgo(1) })];
    await syncFood(USER, token);

    const older = serverFood('s', 'Bowl');
    delete older.shared_by;
    delete older.shared_at;
    serverFoods = [older];
    await syncFood(USER, token);

    const kept = (await localFood(USER, 's'))!;
    expect(kept.shared_by).toBe('ana_bjj');
    expect(kept.shared_at).toBe(daysAgo(1));
  });

  // The restore path, on the phone's own write. Correcting a shared food's
  // macros through the editor sends no provenance — and must not blank it.
  it('editing a shared food locally keeps who shared it', async () => {
    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana_bjj', shared_at: daysAgo(1) })];
    await syncFood(USER, token);

    const before = (await localFood(USER, 's'))!;
    await saveFoodLocally(USER, {
      id: 's',
      kind: before.kind,
      name: before.name,
      brand: before.brand,
      serving_label: before.serving_label,
      serving_grams: before.serving_grams,
      kcal: 999,
      protein_g: before.protein_g,
      carb_g: before.carb_g,
      fat_g: before.fat_g,
      fibre_g: before.fibre_g,
      saturated_fat_g: before.saturated_fat_g,
      sugar_g: before.sugar_g,
      added_sugar_g: before.added_sugar_g,
      sodium_mg: before.sodium_mg,
      cholesterol_mg: before.cholesterol_mg,
    });

    const after = (await localFood(USER, 's'))!;
    expect(after.kcal).toBe(999);
    expect(after.shared_by).toBe('ana_bjj');
    expect(after.shared_at).toBe(daysAgo(1));
  });

  it('a food saved on this phone has no provenance', async () => {
    const id = await saveFoodLocally(USER, {
      kind: 'food', name: 'Porridge', brand: '', serving_label: '60 g', serving_grams: 60,
      kcal: 220, protein_g: 7, carb_g: 40, fat_g: 4, fibre_g: 5,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    const f = (await localFood(USER, id))!;
    expect(f.shared_at).toBeNull();
    expect(await recentlySharedFoods(USER, NOW)).toEqual([]);
  });

  // The push must NOT try to send provenance back — the server ignores it,
  // but a client that thinks it owns the field is one that will one day
  // try to edit it.
  it('does not push provenance', async () => {
    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana_bjj', shared_at: daysAgo(1) })];
    await syncFood(USER, token);
    const before = (await localFood(USER, 's'))!;
    await saveFoodLocally(USER, { ...before, id: 's', kcal: 5 });
    mockApi.mockClear();
    await syncFood(USER, token);
    const put = mockApi.mock.calls.find(
      (c) => String(c[1]).startsWith('/nutrition/foods/') && (c[2] as { method?: string })?.method === 'PUT',
    );
    expect(put).toBeDefined();
    const body = JSON.parse((put![2] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('shared_by');
    expect(body).not.toHaveProperty('shared_at');
  });
});

describe('recentlySharedFoods', () => {
  it('lists only shared foods inside the window, newest share first', async () => {
    serverFoods = [
      serverFood('old', 'Old share', { shared_by: 'ana', shared_at: daysAgo(RECENTLY_SHARED_DAYS + 1) }),
      serverFood('edge', 'Edge share', { shared_by: 'ana', shared_at: daysAgo(RECENTLY_SHARED_DAYS - 1) }),
      serverFood('new', 'New share', { shared_by: 'ben', shared_at: daysAgo(1) }),
      serverFood('own', 'My own'),
    ];
    await syncFood(USER, token);

    const recent = await recentlySharedFoods(USER, NOW);
    expect(recent.map((f) => f.id)).toEqual(['new', 'edge']);
    expect(recent[0].shared_by).toBe('ben');
  });

  // The presence test is `shared_at`: a sender with no handle still shared it.
  it('includes a share whose sender has no handle', async () => {
    serverFoods = [serverFood('s', 'Bowl', { shared_by: null, shared_at: daysAgo(1) })];
    await syncFood(USER, token);
    expect((await recentlySharedFoods(USER, NOW)).map((f) => f.id)).toEqual(['s']);
  });

  it('is capped, so the spotlight stays a glance', async () => {
    serverFoods = Array.from({ length: RECENTLY_SHARED_LIMIT + 3 }, (_, i) =>
      serverFood(`s${i}`, `Share ${i}`, { shared_by: 'ana', shared_at: daysAgo(i) }),
    );
    await syncFood(USER, token);
    expect(await recentlySharedFoods(USER, NOW)).toHaveLength(RECENTLY_SHARED_LIMIT);
  });

  // The offset case `datetime()` exists for: the server's RFC3339 may carry
  // an offset rather than `Z`, and a text comparison would put an offset
  // timestamp on the wrong side of the window.
  it('compares timestamps as times, not as text', async () => {
    // The window's edge is `since` = NOW − 30 days = 2026-08-09T12:00:00Z.
    // 2026-08-09T10:00:00-04:00 is 2026-08-09T14:00:00Z — two hours INSIDE
    // the window as a time; as TEXT, "…T10…" sorts before "…T12…" and a
    // string comparison drops it. (An earlier vector sat mid-window and
    // survived the text-comparison mutation — a test that cannot fail.)
    serverFoods = [serverFood('s', 'Bowl', { shared_by: 'ana', shared_at: '2026-08-09T10:00:00-04:00' })];
    await syncFood(USER, token);
    expect((await recentlySharedFoods(USER, NOW)).map((f) => f.id)).toEqual(['s']);
  });
});

describe('localFoods sorts', () => {
  async function seedThree(): Promise<void> {
    serverFoods = [
      serverFood('b', 'Beans', { created_at: '2026-09-01T00:00:00Z' }),
      serverFood('a', 'Apple', { created_at: '2026-09-03T00:00:00Z' }),
      serverFood('c', 'Cod', { created_at: '2026-09-02T00:00:00Z' }),
    ];
    await syncFood(USER, token);
  }

  it('by name is alphabetical, and is still the default for callers that do not ask', async () => {
    await seedThree();
    expect((await localFoods(USER, '')).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect((await localFoods(USER, '', 'name')).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  // "Recent" orders by the SERVER's creation time, carried through the pull —
  // on a fresh install every row is cached in the same instant, and a sort on
  // that instant is a sort on nothing.
  it('by recent is newest-saved first, using the server’s created_at', async () => {
    await seedThree();
    expect((await localFoods(USER, '', 'recent')).map((f) => f.id)).toEqual(['a', 'c', 'b']);
  });

  it('by recent puts a food just saved on this phone first', async () => {
    await seedThree();
    const id = await saveFoodLocally(USER, {
      kind: 'food', name: 'Zucchini', brand: '', serving_label: '1', serving_grams: null,
      kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    });
    expect((await localFoods(USER, '', 'recent'))[0].id).toBe(id);
  });

  it('by most used counts entries logged from the food, and lists never-used ones at the end', async () => {
    await seedThree();
    const log = (foodId: string, on: string) =>
      logFood(USER, {
        eaten_on: on, meal: 'lunch', name: 'x', servings: 1, serving_label: '1',
        kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null,
        saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
        source_food_id: foodId,
      });
    await log('c', '2026-09-01');
    await log('c', '2026-09-02');
    await log('b', '2026-09-03');
    expect((await localFoods(USER, '', 'used')).map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });

  it('search composes with the sort', async () => {
    serverFoods = [
      serverFood('b', 'Brown rice', { created_at: '2026-09-01T00:00:00Z' }),
      serverFood('w', 'White rice', { created_at: '2026-09-03T00:00:00Z' }),
      serverFood('a', 'Apple', { created_at: '2026-09-02T00:00:00Z' }),
    ];
    await syncFood(USER, token);
    expect((await localFoods(USER, 'rice', 'recent')).map((f) => f.id)).toEqual(['w', 'b']);
    expect((await localFoods(USER, 'rice', 'name')).map((f) => f.id)).toEqual(['b', 'w']);
  });

  // The aggregate the "used" sort needs must not leak onto the food object.
  it('does not leak the usage count onto the food', async () => {
    await seedThree();
    const [first] = await localFoods(USER, '', 'used');
    expect(first).not.toHaveProperty('uses');
  });

  it('never lists another athlete’s foods', async () => {
    await seedThree();
    expect(await localFoods('someone-else', '', 'recent')).toEqual([]);
  });
});

describe('parseSavedFoodsSort', () => {
  it('defaults to recent, and every named sort round-trips', () => {
    expect(DEFAULT_SAVED_FOODS_SORT).toBe('recent');
    expect(parseSavedFoodsSort(null)).toBe('recent');
    expect(parseSavedFoodsSort(undefined)).toBe('recent');
    for (const s of SAVED_FOODS_SORTS) expect(parseSavedFoodsSort(s)).toBe(s);
  });

  // A stored value from a build with a fourth sort, or a hand-edited row,
  // must open the list rather than break it.
  it('falls back to the default on a value it does not know', () => {
    expect(parseSavedFoodsSort('alphabetical')).toBe('recent');
    expect(parseSavedFoodsSort('')).toBe('recent');
  });
});

// Keeps `ApiError` imported so the module graph matches the sibling suites;
// a transport failure on the pull must still not throw out of syncFood.
it('a failed pull does not throw and leaves the cache readable', async () => {
  mockApi.mockImplementation(async (_t: unknown, url: string) => {
    if (url.startsWith('/nutrition/foods')) throw new ApiError('down', 'internal', 500);
    return { entries: [] };
  });
  await expect(syncFood(USER, token)).resolves.toBeDefined();
  expect(await recentlySharedFoods(USER, NOW)).toEqual([]);
});
