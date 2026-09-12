/**
 * N568 (#1129) — the body read cache, against real SQLite.
 *
 * Every rule here is about what the phone may claim to know about a server
 * record it cannot see: never fetched vs fetched-and-empty, which fetch last
 * confirmed a row, a row the server dropped, and whose row it is. An array
 * literal would hand each of those whatever the author believed, so rows are
 * written through the app's own writers and read back through the panel's reads.
 */

import type { Checkin, Phase } from '../body';
import {
  cacheCheckins,
  cachePhases,
  localCheckinView,
  localPhaseView,
  refreshBody,
} from '../bodyCache';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const mockApi = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.reject(new TypeError('Network request failed')));
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = () => Promise.resolve('tok');

const A = 'athlete-a';
const B = 'athlete-b';

const T1 = '2026-09-01T08:00:00.000Z';
const T2 = '2026-09-11T08:00:00.000Z';

function checkin(user: string, on: string, kg: number | null): Checkin {
  return {
    user_id: user,
    measured_on: on,
    weight_kg: kg,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    upper_arm_cm: null,
    forearm_cm: null,
    measured_side: 'left',
    photo_url: 'https://expires.example/photo',
    notes: 'private',
  };
}

function phase(user: string, id: string, over: Partial<Phase> = {}): Phase {
  return {
    id,
    user_id: user,
    kind: 'cut',
    started_on: '2026-08-01',
    target_on: '2026-11-01',
    target_weight_kg: 78,
    ended_on: null,
    notes: '',
    ...over,
  };
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockApi.mockReset();
  mockApi.mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
});

describe('three states, never two', () => {
  it('never fetched: both views are unknown — not empty', async () => {
    expect(await localCheckinView(A, '2026-09-11')).toEqual({ state: 'unknown' });
    expect(await localPhaseView(A)).toEqual({ state: 'unknown' });
  });

  it('fetched, with rows: the newest on or before the day, carrying the time of the fetch that returned it', async () => {
    await cacheCheckins(A, '2026-08-12', '2026-09-11', [checkin(A, '2026-09-05', 82.4), checkin(A, '2026-09-10', 82.1)], T2);

    expect(await localCheckinView(A, '2026-09-11')).toEqual({
      state: 'known',
      fetchedAt: T2,
      from: '2026-08-12',
      to: '2026-09-11',
      latest: { measured_on: '2026-09-10', weight_kg: 82.1, fetched_at: T2 },
    });
    // "On or before": a panel for the 7th is not told about the 10th.
    const earlier = await localCheckinView(A, '2026-09-07');
    expect(earlier.state === 'known' && earlier.latest?.measured_on).toBe('2026-09-05');
  });

  it('fetched and genuinely empty: known, with nothing in it and the window it covered', async () => {
    await cacheCheckins(A, '2026-08-12', '2026-09-11', [], T2);
    await cachePhases(A, [], T2);

    expect(await localCheckinView(A, '2026-09-11')).toEqual({
      state: 'known',
      fetchedAt: T2,
      from: '2026-08-12',
      to: '2026-09-11',
      latest: null,
    });
    expect(await localPhaseView(A)).toEqual({ state: 'known', fetchedAt: T2, active: null });
  });

  it('stores neither the expiring photo link nor the notes', async () => {
    await cacheCheckins(A, '2026-09-01', '2026-09-11', [checkin(A, '2026-09-05', 82.4)], T2);
    const row = mockFixture.raw.prepare('SELECT * FROM body_checkins_cache').get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['fetched_at', 'measured_on', 'user_id', 'weight_kg']);
  });
});

describe('a cached row the server no longer has', () => {
  it('is deleted by the next fetch that covers it — and a row outside that window keeps its OLDER time', async () => {
    await cacheCheckins(A, '2026-07-01', '2026-09-01', [checkin(A, '2026-07-20', 84), checkin(A, '2026-08-30', 83)], T1);

    // Ten days later Today fetches its 30 days; the 30 Aug check-in was deleted
    // on the web, and 20 Jul is outside the window so the server was not asked.
    await cacheCheckins(A, '2026-08-12', '2026-09-11', [], T2);

    const rows = mockFixture.raw
      .prepare('SELECT measured_on, fetched_at FROM body_checkins_cache WHERE user_id = ? ORDER BY measured_on')
      .all(A);
    expect(rows).toEqual([{ measured_on: '2026-07-20', fetched_at: T1 }]);

    const view = await localCheckinView(A, '2026-09-11');
    // The marker is the new fetch; the row is still only as fresh as T1.
    expect(view).toMatchObject({ state: 'known', fetchedAt: T2, latest: { measured_on: '2026-07-20', fetched_at: T1 } });
  });

  it('phases are fetched whole, so a phase not returned is gone, and an ended phase is not the active one', async () => {
    await cachePhases(A, [phase(A, 'old', { ended_on: '2026-07-31', started_on: '2026-06-01' }), phase(A, 'live')], T1);
    expect(await localPhaseView(A)).toMatchObject({ state: 'known', active: { id: 'live', fetched_at: T1 } });

    await cachePhases(A, [phase(A, 'live', { ended_on: '2026-09-10' })], T2);
    expect(await localPhaseView(A)).toEqual({ state: 'known', fetchedAt: T2, active: null });
    const ids = mockFixture.raw.prepare('SELECT id FROM body_phases_cache WHERE user_id = ?').all(A);
    expect(ids).toEqual([{ id: 'live' }]);
  });
});

describe('two accounts on one phone', () => {
  it("neither athlete's cache answers for the other, and one athlete's fetch never touches the other's rows", async () => {
    await cacheCheckins(A, '2026-08-12', '2026-09-11', [checkin(A, '2026-09-10', 82.1)], T1);
    await cachePhases(A, [phase(A, 'a-cut')], T1);

    // B has never fetched on this phone: unknown, not A's values.
    expect(await localCheckinView(B, '2026-09-11')).toEqual({ state: 'unknown' });
    expect(await localPhaseView(B)).toEqual({ state: 'unknown' });

    // B fetches and has nothing. B is empty; A is untouched.
    await cacheCheckins(B, '2026-08-12', '2026-09-11', [], T2);
    await cachePhases(B, [], T2);
    expect(await localCheckinView(B, '2026-09-11')).toMatchObject({ state: 'known', latest: null });
    expect(await localPhaseView(B)).toMatchObject({ state: 'known', active: null });
    expect(await localCheckinView(A, '2026-09-11')).toMatchObject({ latest: { measured_on: '2026-09-10' } });
    expect(await localPhaseView(A)).toMatchObject({ active: { id: 'a-cut' } });
  });

  it('a write whose rows name another athlete is refused whole — no rows, and no fetched marker either', async () => {
    expect(await cacheCheckins(A, '2026-08-12', '2026-09-11', [checkin(B, '2026-09-10', 60)], T1)).toBe(false);
    expect(await cachePhases(A, [phase(B, 'b-bulk')], T1)).toBe(false);

    expect(await localCheckinView(A, '2026-09-11')).toEqual({ state: 'unknown' });
    expect(await localPhaseView(A)).toEqual({ state: 'unknown' });
    expect(mockFixture.raw.prepare('SELECT count(*) AS n FROM body_checkins_cache').get()).toEqual({ n: 0 });
    expect(mockFixture.raw.prepare('SELECT count(*) AS n FROM body_phases_cache').get()).toEqual({ n: 0 });
  });
});

describe('refreshBody — the only writer', () => {
  function serve(checkins: Checkin[], phases: Phase[]) {
    mockApi.mockImplementation((_t: unknown, path: unknown) =>
      String(path).startsWith('/body/checkins')
        ? Promise.resolve({ checkins })
        : Promise.resolve({ phases }),
    );
  }

  it('keeps what a successful fetch returned, and hands the caller the same answer', async () => {
    serve([checkin(A, '2026-09-10', 82.1)], [phase(A, 'live')]);
    const before = Date.now();

    const got = await refreshBody(getToken, A, { from: '2026-08-12', to: '2026-09-11' });

    expect(got.checkins.map((c) => c.measured_on)).toEqual(['2026-09-10']);
    const view = await localCheckinView(A, '2026-09-11');
    expect(view).toMatchObject({ state: 'known', latest: { measured_on: '2026-09-10', weight_kg: 82.1 } });
    expect(view.state === 'known' && Date.parse(view.fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(await localPhaseView(A)).toMatchObject({ state: 'known', active: { id: 'live' } });
  });

  it('a failed fetch writes nothing: the last-known values stay, with their older time', async () => {
    await cacheCheckins(A, '2026-08-01', '2026-09-01', [checkin(A, '2026-08-30', 83)], T1);
    await cachePhases(A, [phase(A, 'live')], T1);

    await expect(refreshBody(getToken, A, { from: '2026-08-12', to: '2026-09-11' })).rejects.toThrow(
      'Network request failed',
    );

    expect(await localCheckinView(A, '2026-09-11')).toMatchObject({
      fetchedAt: T1,
      latest: { measured_on: '2026-08-30', fetched_at: T1 },
    });
    expect(await localPhaseView(A)).toMatchObject({ fetchedAt: T1, active: { id: 'live' } });
  });

  it('a cache that cannot be written does not turn a successful fetch into an error', async () => {
    serve([checkin(A, '2026-09-10', 82.1)], []);
    mockFixture.raw.exec('DROP TABLE body_checkins_cache');

    await expect(refreshBody(getToken, A, { from: '2026-08-12', to: '2026-09-11' })).resolves.toMatchObject({
      checkins: [expect.objectContaining({ measured_on: '2026-09-10' })],
    });
  });

  it('with no signed-in athlete it fetches without filing the answer under anyone', async () => {
    serve([checkin(A, '2026-09-10', 82.1)], []);
    await refreshBody(getToken, null, { from: '2026-08-12', to: '2026-09-11' });
    expect(mockFixture.raw.prepare('SELECT count(*) AS n FROM body_cache_fetches').get()).toEqual({ n: 0 });
  });
});
