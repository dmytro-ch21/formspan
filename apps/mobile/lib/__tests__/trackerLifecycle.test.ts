import type { Tracker } from '../trackerModel';
import {
  archiveTrackerLocally,
  cacheArchivedTrackers,
  cacheTrackers,
  createTrackerLocally,
  destroyTrackerLocally,
  localArchivedTrackers,
  localTrackers,
  logTap,
  localEntries,
  MAX_LIVE_TRACKERS,
  reorderTrackers,
  restoreTrackerLocally,
  syncTrackers,
} from '../trackers';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Creating, stopping, restarting and destroying a tracker — against a real
 * SQLite database, and against a recorded set of API calls.
 *
 * Separate from `trackers.test.ts`, which is about the ENTRY outbox. This is
 * about the DEFINITION's life, which N78 is the ticket for.
 *
 * The two properties this file exists to pin down, because both are silent when
 * broken and expensive when shipped:
 *
 * - **Stopping keeps history; destroying does not.** They are two words for
 *   the athlete and two very different things for their data.
 * - **A destroy the device owes survives being made offline.** A local delete
 *   would leave nothing carrying the intent, and the next pull would hand the
 *   tracker back.
 */

let mockFixture: FixtureDb;
let db: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const USER = 'user_a';
const TODAY = '2026-08-20';
const token = async () => 'tok';

const draft = (over: Partial<Parameters<typeof createTrackerLocally>[1]> = {}) => ({
  name: 'Creatine',
  icon: '🥄',
  color_key: 'mint',
  unit: 'g' as const,
  increment: 5,
  target: 5,
  render_style: 'auto' as const,
  count_noun: 'dose',
  ...over,
});

const wire = (over: Record<string, unknown> = {}) => ({
  id: 't_water', preset: 'water', name: 'Water', icon: '💧', color_key: 'water',
  unit: 'ml', increment: 250, target: 2000, render_style: 'glyphs', sort_order: 10,
  count_noun: 'cup', user_id: USER, archived_at: null,
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

/** Every path the API layer was asked for, in order. */
const calls = () => mockApi.mock.calls.map((c) => `${(c[2]?.method as string) ?? 'GET'} ${c[1]}`);

beforeEach(async () => {
  mockFixture = await migratedFixture();
  db = mockFixture;
  mockUuidSeq = 0;
  mockApi.mockReset();
  mockApi.mockResolvedValue({});
});

async function defRow(id: string) {
  return db.getFirstAsync<{
    name: string; count_noun: string; archived_at: string | null;
    destroyed_at: string | null; restore_pending: number; dirty: number; remote: number;
    sort_order: number;
  }>(
    `SELECT name, count_noun, archived_at, destroyed_at, restore_pending, dirty, remote, sort_order
       FROM daily_trackers WHERE id = ?`,
    id,
  );
}

describe('creating a tracker', () => {
  it('is written locally, owed to the server, and on Today at once', async () => {
    const id = await createTrackerLocally(USER, draft());

    const view = await localTrackers(USER);
    expect(view.state).toBe('ready');
    expect(view.state === 'ready' && view.trackers.map((t) => t.name)).toEqual(['Creatine']);

    const row = await defRow(id);
    // dirty + not remote: the outbox owes a CREATE. Both halves matter — dirty
    // alone would be an edit to something the server has.
    expect(row).toMatchObject({ dirty: 1, remote: 0, count_noun: 'dose' });
    // Nothing was awaited on the network. "A created tracker appears on Today
    // without further setup — that is the feature, not a follow-up."
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('goes to the END of the list, not the top', async () => {
    await cacheTrackers(USER, [wire({ sort_order: 10 })] as never);
    const id = await createTrackerLocally(USER, draft());
    const row = await defRow(id);
    expect(row!.sort_order).toBeGreaterThan(10);
    const view = await localTrackers(USER);
    // A new tracker jumping above the water somebody has logged for a month is
    // not what "add one" means.
    expect(view.state === 'ready' && view.trackers.map((t) => t.name)).toEqual([
      'Water',
      'Creatine',
    ]);
  });

  it('refuses the ninth, and stopping one makes room', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_TRACKERS; i++) {
      ids.push(await createTrackerLocally(USER, draft({ name: `T${i}` })));
    }
    await expect(createTrackerLocally(USER, draft({ name: 'one too many' }))).rejects.toThrow(
      /Stop one first/,
    );
    // The cap is checked HERE and not only on the server so an athlete who
    // fills up offline is told at the moment they tap Create, rather than by a
    // 409 on a sync screen an hour after the form was thrown away.
    await archiveTrackerLocally(USER, ids[0]);
    await expect(createTrackerLocally(USER, draft({ name: 'now it fits' }))).resolves.toEqual(
      expect.any(String),
    );
  });
});

describe('stopping and restarting', () => {
  it('keeps every entry, and takes the card off Today', async () => {
    const id = await createTrackerLocally(USER, draft());
    const t = { id, increment: 5 } as Tracker;
    await logTap(USER, t, TODAY);
    await logTap(USER, t, TODAY);

    await archiveTrackerLocally(USER, id);

    const view = await localTrackers(USER);
    // 'ready' with zero rows, NOT 'unknown': this device has asked and the
    // answer is genuinely none. Rendering the two identically would tell an
    // athlete who stopped their only tracker that the app is still loading.
    expect(view).toEqual({ state: 'ready', trackers: [] });
    expect(await localArchivedTrackers(USER)).toHaveLength(1);
    // The whole promise of the word "stop".
    expect(await localEntries(USER, TODAY)).toHaveLength(2);
  });

  it('restores with its history, and marks the restore for the push', async () => {
    const id = await createTrackerLocally(USER, draft());
    await logTap(USER, { id, increment: 5 } as Tracker, TODAY);
    await archiveTrackerLocally(USER, id);

    await restoreTrackerLocally(USER, id);

    const row = await defRow(id);
    expect(row).toMatchObject({ archived_at: null, restore_pending: 1, dirty: 1 });
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
    expect(await localArchivedTrackers(USER)).toHaveLength(0);
  });

  it('refuses to restore past the cap', async () => {
    const first = await createTrackerLocally(USER, draft({ name: 'first' }));
    await archiveTrackerLocally(USER, first);
    for (let i = 0; i < MAX_LIVE_TRACKERS; i++) {
      await createTrackerLocally(USER, draft({ name: `T${i}` }));
    }
    // Without this the cap is walkable: stop eight, restore them one at a time.
    await expect(restoreTrackerLocally(USER, first)).rejects.toThrow(/Stop one to make room/);
    const row = await defRow(first);
    expect(row!.archived_at).not.toBeNull();
  });
});

describe('destroying', () => {
  it('is a tombstone, not a local delete, and takes the entries', async () => {
    const id = await createTrackerLocally(USER, draft());
    await logTap(USER, { id, increment: 5 } as Tracker, TODAY);

    await destroyTrackerLocally(USER, id);

    const row = await defRow(id);
    // The ROW SURVIVES — this is the property. A hard delete here loses the
    // intent the moment a push fails, and offline it always does, so the next
    // pull hands the tracker back.
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ dirty: 1 });
    expect(row!.destroyed_at).not.toBeNull();
    // Invisible everywhere the athlete looks, from the moment they confirm.
    expect(await localTrackers(USER)).toEqual({ state: 'unknown' });
    expect(await localArchivedTrackers(USER)).toHaveLength(0);
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('reads as "never asked" rather than "you have none", with only a tombstone left', async () => {
    // The discriminating case for `localTrackers`' union. A tombstone is not
    // evidence the athlete has no trackers — it is a delete this device owes —
    // so counting it would render a confident empty state on a device that has
    // never successfully listed.
    const id = await createTrackerLocally(USER, draft());
    await destroyTrackerLocally(USER, id);
    expect(await localTrackers(USER)).toEqual({ state: 'unknown' });
  });
});

describe('the push', () => {
  it('creates, then archives, a tracker stopped before it ever synced', async () => {
    const id = await createTrackerLocally(USER, draft());
    await archiveTrackerLocally(USER, id);

    await syncTrackers(USER, token);

    // Create FIRST — the server has never heard of this id, so a bare DELETE
    // would 404 and classify as permanent. Both calls, in this order.
    expect(calls()).toEqual(['POST /trackers', `DELETE /trackers/${id}`]);
  });

  it('restores BEFORE patching, because a PATCH does not un-archive anything', async () => {
    await cacheTrackers(USER, [wire()] as never);
    await archiveTrackerLocally(USER, 't_water');
    await syncTrackers(USER, token);
    mockApi.mockClear();

    await restoreTrackerLocally(USER, 't_water');
    await syncTrackers(USER, token);

    expect(calls()).toEqual(['POST /trackers/t_water/restore', 'PATCH /trackers/t_water']);
    // And the flag is cleared, so the next ordinary edit does not restore again.
    expect((await defRow('t_water'))!.restore_pending).toBe(0);
  });

  it('destroys and then removes the row, and does not push the edits first', async () => {
    await cacheTrackers(USER, [wire()] as never);
    await destroyTrackerLocally(USER, 't_water');

    await syncTrackers(USER, token);

    // ONE call, and it is the purge. A tracker the athlete deleted must not
    // have its name or target pushed first — those are edits to a thing that is
    // going away, and one of them failing would strand the delete.
    expect(calls()).toEqual(['DELETE /trackers/t_water?purge=true']);
    expect(await defRow('t_water')).toBeNull();
  });

  it('destroys a never-synced tracker without asking the server', async () => {
    const id = await createTrackerLocally(USER, draft());
    await destroyTrackerLocally(USER, id);

    await syncTrackers(USER, token);

    // The server never saw it. Sending a DELETE would earn a 404, which the
    // outbox classifies as permanent — so skipping it is correctness, not a
    // saved round trip.
    expect(calls()).toEqual([]);
    expect(await defRow(id)).toBeNull();
  });

  it('sends the athlete\'s own noun on both the create and the patch', async () => {
    const id = await createTrackerLocally(USER, draft({ count_noun: 'serving' }));
    await syncTrackers(USER, token);
    const created = JSON.parse(mockApi.mock.calls[0][2].body as string);
    expect(created.count_noun).toBe('serving');

    mockApi.mockClear();
    // A field the wire layer forgets is a field that silently reverts on the
    // next pull, which reads as the app losing the athlete's word.
    const { updateTrackerLocally } = jest.requireActual('../trackers');
    await updateTrackerLocally(USER, id, { count_noun: 'scoop' });
    await syncTrackers(USER, token);
    const patched = JSON.parse(mockApi.mock.calls[0][2].body as string);
    expect(patched.count_noun).toBe('scoop');
  });
});

describe('reordering', () => {
  it('renumbers every row so no two share a position', async () => {
    const a = await createTrackerLocally(USER, draft({ name: 'A' }));
    const b = await createTrackerLocally(USER, draft({ name: 'B' }));
    const c = await createTrackerLocally(USER, draft({ name: 'C' }));

    await reorderTrackers(USER, [c, a, b]);

    const view = await localTrackers(USER);
    expect(view.state === 'ready' && view.trackers.map((t) => t.name)).toEqual(['C', 'A', 'B']);
    // Distinct values, not a swap of two. Two rows sharing a sort_order — which
    // happens the moment anything is created while a reorder is unsynced — are
    // ordered by id instead, and the list appears to reorder itself.
    const orders = (
      await db.getAllAsync<{ sort_order: number }>(
        `SELECT sort_order FROM daily_trackers WHERE user_id = ?`,
        USER,
      )
    ).map((r) => r.sort_order);
    expect(new Set(orders).size).toBe(3);
    // And every row is owed to the server, or the order is local-only.
    const dirty = await db.getFirstAsync<{ n: number }>(
      `SELECT count(*) AS n FROM daily_trackers WHERE user_id = ? AND dirty = 1`,
      USER,
    );
    expect(dirty!.n).toBe(3);
  });
});

describe('caching the archived list', () => {
  it('does NOT archive the live trackers it was not given', async () => {
    // The failure this separate function exists to prevent, and it is a whole
    // Today disappearing: `cacheTrackers` archives everything the response did
    // not contain, which against a response that deliberately contains only
    // archived rows means every live tracker the athlete has.
    await cacheTrackers(USER, [wire()] as never);
    await cacheArchivedTrackers(USER, [
      wire({ id: 't_old', name: 'Old', preset: '', archived_at: '2026-08-10T00:00:00.000Z' }),
    ] as never);

    const view = await localTrackers(USER);
    expect(view.state === 'ready' && view.trackers.map((t) => t.id)).toEqual(['t_water']);
    expect((await localArchivedTrackers(USER)).map((t) => t.id)).toEqual(['t_old']);
  });
});
