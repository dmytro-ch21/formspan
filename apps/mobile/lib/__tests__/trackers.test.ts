import { ApiError, OfflineError } from '../apiError';
import type { Tracker } from '../trackerModel';
import {
  byTracker,
  cacheTrackers,
  localEntries,
  localTrackers,
  logTap,
  pendingTrackerCount,
  removeLastTap,
  removeTap,
  syncTrackers,
  updateTrackerLocally,
} from '../trackers';

import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The tracker outbox, against a real SQLite database.
 *
 * Two things this file is careful about, both of which this repo has been
 * burned by:
 *
 * - **Anything about SQL behaviour is a fixture test, never a regex over the
 *   query string.** A text assertion proves a clause is present, not that
 *   SQLite honours it, and an array mock can silently supply the behaviour
 *   under test.
 * - **The day is the LOCAL day.** The suite runs under
 *   `TZ=America/Los_Angeles` for exactly this, and `process.env.TZ = …` inside
 *   a test does not work — jest hands the sandbox a copied `process` and the
 *   runtime is never notified, so the zone silently stays UTC and the test
 *   passes against the thing it covers.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const USER = 'user_a';
const OTHER = 'user_b';
const TODAY = '2026-08-20';

const water: Tracker = {
  id: 't_water', preset: 'water', name: 'Water', icon: '💧', color_key: 'water',
  unit: 'ml', increment: 250, target: 2000, render_style: 'auto', sort_order: 10,
  count_noun: 'cup', provisioned: true, cutoff_minutes: null,
};

const wire = (over: Partial<Record<string, unknown>> = {}) => ({
  ...water,
  user_id: USER,
  archived_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

const token = async () => 'tok';

async function row(id: string) {
  return db.getFirstAsync<{
    dirty: number; remote: number; deleted_at: string | null;
    last_error: string | null; updated_at: string;
  }>(`SELECT dirty, remote, deleted_at, last_error, updated_at FROM tracker_entries WHERE id = ?`, id);
}

async function definition(id: string) {
  return db.getFirstAsync<{
    name: string; icon: string; color_key: string; unit: string;
    increment: number; target: number | null; render_style: string;
    sort_order: number; dirty: number; remote: number;
  }>(`SELECT * FROM daily_trackers WHERE id = ?`, id);
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  mockApi.mockReset().mockResolvedValue({});
});

describe('a tap works offline', () => {
  it('writes locally, owes a push, and never touches the network', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);

    expect(mockApi).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ dirty: 1, remote: 0, deleted_at: null });
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
  });

  it('stores the increment AS IT WAS, so changing it does not rewrite last week', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, TODAY);
    await updateTrackerLocally(USER, water.id, { increment: 500 });

    const entries = await localEntries(USER, TODAY);
    expect(entries[0].amount).toBe(250);
  });

  it('gives every tap its own id, so a retry cannot duplicate a cup', async () => {
    await cacheTrackers(USER, [wire()]);
    const a = await logTap(USER, water, TODAY);
    const b = await logTap(USER, water, TODAY);
    expect(a).not.toBe(b);
  });
});

describe('the day boundary is the athlete\'s local day', () => {
  it('files a 23:58 tap under the day that is ending, not tomorrow', async () => {
    // 2026-08-20 23:58 in America/Los_Angeles is 2026-08-21 06:58 UTC. A day
    // derived from the timestamp — `toISOString().slice(0,10)` — puts this
    // glass of water on tomorrow, and then two days are wrong at once. This is
    // the assertion the whole TZ=America/Los_Angeles suite setting exists for.
    const lateEvening = new Date(2026, 7, 20, 23, 58, 0);
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-08-21'); // the wrong answer

    await cacheTrackers(USER, [wire()]);
    // The real call path: no `on` argument, so the default is used — which is
    // where the bug would live.
    jest.useFakeTimers().setSystemTime(lateEvening);
    try {
      await logTap(USER, water);
    } finally {
      jest.useRealTimers();
    }

    const entries = await localEntries(USER, '2026-08-20');
    expect(entries).toHaveLength(1);
    expect(entries[0].logged_on).toBe('2026-08-20');
    expect(await localEntries(USER, '2026-08-21')).toHaveLength(0);
  });

  it('the mirror case: a tap just after midnight lands on the NEW day', async () => {
    // The 23:58 test above covers one direction; this is the other, and review
    // found it because only the first was written. Today computes its day key
    // during RENDER and never unmounts, so a phone left open across midnight
    // holds yesterday's key until something re-renders it — and the first tap
    // at 00:05 would file a cup under the day that just ended.
    //
    // The same shape bit #398 today: a date frozen at first render filed
    // tomorrow's target under yesterday. A stale READ is a nuisance; a stale
    // WRITE is data. This is the case a test written at 2pm never exercises,
    // which is the whole argument for pinning the clock rather than trusting
    // whenever the suite happens to run.
    await cacheTrackers(USER, [wire()]);
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 21, 0, 5, 0));
    try {
      await logTap(USER, water);
    } finally {
      jest.useRealTimers();
    }

    expect(await localEntries(USER, '2026-08-20')).toHaveLength(0);
    const next = await localEntries(USER, '2026-08-21');
    expect(next).toHaveLength(1);
    expect(next[0].logged_on).toBe('2026-08-21');
  });

  it('the new day starts empty', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, '2026-08-20');
    expect(await localEntries(USER, '2026-08-21')).toHaveLength(0);
  });
});

describe('tapping a filled cup removes it', () => {
  it('tombstones even a tap whose first push has not happened yet', async () => {
    // The conservative half, and it is deliberate. A row that is `dirty = 1,
    // remote = 0` is either never-attempted or attempt-IN-FLIGHT, and the flags
    // cannot tell those apart. Hard-deleting the second case loses the delete:
    // the push succeeds, the server keeps a cup this device has forgotten, and
    // nothing is left carrying the intent to remove it.
    //
    // The cost is a doomed DELETE in the outbox after a tap-and-untap offline,
    // which for a cup row is common. It is one idempotent request the server
    // answers 204 to, and it is the same trade `foodLog.removeEntry` makes.
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    await removeTap(USER, id);

    const after = await row(id);
    expect(after?.deleted_at).not.toBeNull();
    // Invisible immediately, whatever the row is doing.
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('hard-deletes a tap the server permanently refused, with no request owed', async () => {
    // The branch that IS reachable with `dirty = 0, remote = 0`: a push the
    // server rejected outright clears `dirty` and leaves `remote` at 0. Nothing
    // is owed and nothing is in flight, so the row can simply go.
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    mockApi.mockRejectedValue(new ApiError('nope', 'invalid_input', 400));
    await syncTrackers(USER, token);
    expect(await row(id)).toMatchObject({ dirty: 0, remote: 0 });

    mockApi.mockReset().mockResolvedValue({});
    await removeTap(USER, id);

    expect(await row(id)).toBeNull();
    expect(await pendingTrackerCount(USER)).toBe(0);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('tombstones a tap the server HAS seen, so it does not come back on a pull', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    await syncTrackers(USER, token); // now remote = 1
    expect(await row(id)).toMatchObject({ dirty: 0, remote: 1 });

    await removeTap(USER, id);

    const after = await row(id);
    expect(after?.deleted_at).not.toBeNull();
    expect(after?.dirty).toBe(1);
    // Invisible from the moment it is tapped, even though the row survives.
    expect(await localEntries(USER, TODAY)).toHaveLength(0);
  });

  it('removes the NEWEST tap when no particular cup is named', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, TODAY);
    const second = await logTap(USER, water, TODAY);
    await removeLastTap(USER, water.id, TODAY);

    const left = await localEntries(USER, TODAY);
    expect(left).toHaveLength(1);
    expect(left.map((e) => e.id)).not.toContain(second);
  });

  it('removing something already gone is not an error', async () => {
    await expect(removeTap(USER, 'never-existed')).resolves.toBeUndefined();
  });
});

describe('the local partial update leaves unmentioned fields alone', () => {
  // The same guarantee the backend's Patch gives, on this side of the wire.
  // Enumerated per field rather than spot-checked, because the failure mode is
  // always the field nobody thought about — `exercise.updateWithin` blanked
  // authored data three times exactly that way.
  const FIELDS: { key: string; patch: Record<string, unknown>; read: string; want: unknown }[] = [
    { key: 'name', patch: { name: 'Aqua' }, read: 'name', want: 'Aqua' },
    { key: 'icon', patch: { icon: '🥤' }, read: 'icon', want: '🥤' },
    { key: 'color_key', patch: { color_key: 'coffee' }, read: 'color_key', want: 'coffee' },
    { key: 'unit', patch: { unit: 'cup' }, read: 'unit', want: 'cup' },
    { key: 'increment', patch: { increment: 500 }, read: 'increment', want: 500 },
    { key: 'target', patch: { target: 3000 }, read: 'target', want: 3000 },
    { key: 'render_style', patch: { render_style: 'bar' }, read: 'render_style', want: 'bar' },
    { key: 'sort_order', patch: { sort_order: 99 }, read: 'sort_order', want: 99 },
  ];

  it.each(FIELDS)('patching $key changes only $key', async ({ patch, read, want }) => {
    await cacheTrackers(USER, [wire()]);
    const before = await definition(water.id);
    await updateTrackerLocally(USER, water.id, patch);
    const after = await definition(water.id);

    expect(after?.[read as keyof typeof after]).toEqual(want);
    for (const other of FIELDS) {
      if (other.read === read) continue;
      expect({ [other.read]: after?.[other.read as keyof typeof after] }).toEqual({
        [other.read]: before?.[other.read as keyof typeof before],
      });
    }
  });

  it('clears a target with an explicit null, and leaves it alone when absent', async () => {
    await cacheTrackers(USER, [wire()]);
    await updateTrackerLocally(USER, water.id, { target: null });
    expect((await definition(water.id))?.target).toBeNull();

    // A later patch that does not mention target must not reinstate one — the
    // distinction between "no target" and "do not touch my target".
    await updateTrackerLocally(USER, water.id, { name: 'Coffee' });
    const after = await definition(water.id);
    expect(after?.target).toBeNull();
    expect(after?.name).toBe('Coffee');
  });

  it('marks the row owed, so a target changed offline is pushed later', async () => {
    await cacheTrackers(USER, [wire()]);
    await updateTrackerLocally(USER, water.id, { target: 2500 });
    expect((await definition(water.id))?.dirty).toBe(1);
    expect(await pendingTrackerCount(USER)).toBe(1);
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe('the pull does not clobber what this device owes', () => {
  it('keeps a locally edited target when the server sends the old one', async () => {
    await cacheTrackers(USER, [wire()]);
    await updateTrackerLocally(USER, water.id, { target: 3000 });
    // The server still believes 2000; this list was assembled before the edit.
    await cacheTrackers(USER, [wire({ target: 2000 })]);
    expect((await definition(water.id))?.target).toBe(3000);
  });

  it('archives a tracker the server no longer lists, without touching its entries', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, TODAY);
    await syncTrackers(USER, token);

    await cacheTrackers(USER, []);

    const view = await localTrackers(USER);
    expect(view.state).toBe('ready');
    if (view.state === 'ready') expect(view.trackers).toHaveLength(0);
    // The history survives. Archiving is not deleting.
    const kept = await db.getAllAsync(`SELECT id FROM tracker_entries`);
    expect(kept).toHaveLength(1);
  });

  it('does not archive a tracker created here and not yet pushed', async () => {
    // Absent from the server's list is not evidence of deletion for a row the
    // server has never heard of.
    await db.runAsync(
      `INSERT INTO daily_trackers (id, user_id, name, color_key, increment, dirty, remote)
       VALUES ('t_local', ?, 'Creatine', 'water', 5, 1, 0)`,
      USER,
    );
    await cacheTrackers(USER, []);
    const view = await localTrackers(USER);
    expect(view.state === 'ready' && view.trackers.map((t) => t.id)).toEqual(['t_local']);
  });
});

describe('an unfetched device says "unknown", never "you have no trackers"', () => {
  it('is unknown before anything has been cached', async () => {
    expect(await localTrackers(USER)).toEqual({ state: 'unknown' });
  });

  it('is a genuine empty once something has been, and then archived', async () => {
    await cacheTrackers(USER, [wire()]);
    await cacheTrackers(USER, []);
    expect(await localTrackers(USER)).toEqual({ state: 'ready', trackers: [] });
  });
});

describe('every read and write is scoped to the athlete', () => {
  it('does not show one athlete another athlete\'s trackers or taps', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, TODAY);

    expect(await localTrackers(OTHER)).toEqual({ state: 'unknown' });
    expect(await localEntries(OTHER, TODAY)).toHaveLength(0);
    expect(await pendingTrackerCount(OTHER)).toBe(0);
  });

  it('refuses to edit a tracker belonging to somebody else on this device', async () => {
    await cacheTrackers(USER, [wire()]);
    await expect(updateTrackerLocally(OTHER, water.id, { target: 1 })).rejects.toThrow();
    expect((await definition(water.id))?.target).toBe(2000);
  });

  it('does not let one athlete tombstone another\'s tap', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    await removeTap(OTHER, id);
    expect(await localEntries(USER, TODAY)).toHaveLength(1);
  });
});

describe('the push', () => {
  it('sends definitions before entries, because tracker_id is a real foreign key', async () => {
    await db.runAsync(
      `INSERT INTO daily_trackers (id, user_id, name, color_key, increment, dirty, remote, updated_at)
       VALUES ('t_local', ?, 'Creatine', 'water', 5, 1, 0, '2026-08-01T00:00:00.000Z')`,
      USER,
    );
    await logTap(USER, { ...water, id: 't_local', increment: 5 }, TODAY);

    await syncTrackers(USER, token);

    const paths = mockApi.mock.calls.map((c) => String(c[1]));
    expect(paths[0]).toBe('/trackers');
    expect(paths[1]).toContain('/trackers/t_local/entries/');
  });

  it('marks a pushed tap sent, and stops owing it', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    const result = await syncTrackers(USER, token);

    expect(result.failed).toBe(0);
    expect(await row(id)).toMatchObject({ dirty: 0, remote: 1, last_error: null });
    expect(await pendingTrackerCount(USER)).toBe(0);
  });

  it('hard-deletes a tombstone only once the server confirms', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    await syncTrackers(USER, token);
    await removeTap(USER, id);

    mockApi.mockRejectedValueOnce(new OfflineError());
    await syncTrackers(USER, token);
    // Still here, still owed: the tombstone IS the record that a delete is due.
    expect((await row(id))?.deleted_at).not.toBeNull();

    mockApi.mockResolvedValue({});
    await syncTrackers(USER, token);
    expect(await row(id)).toBeNull();
  });

  it('leaves a tap owed when the device is offline, and stops walking the queue', async () => {
    await cacheTrackers(USER, [wire()]);
    await logTap(USER, water, TODAY);
    await logTap(USER, water, TODAY);
    mockApi.mockRejectedValue(new OfflineError());

    const result = await syncTrackers(USER, token);

    expect(result.errorKind).toBe('offline');
    // One attempt, then it stops — there is no point walking a queue with no
    // connection, and each attempt is a timeout the athlete waits through.
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(await pendingTrackerCount(USER)).toBe(2);
  });

  it('stops owing a permanently rejected row but keeps the reason', async () => {
    await cacheTrackers(USER, [wire()]);
    const id = await logTap(USER, water, TODAY);
    mockApi.mockRejectedValue(new ApiError('nope', 'invalid_input', 400));

    const result = await syncTrackers(USER, token);

    expect(result.errorKind).toBe('permanent');
    const after = await row(id);
    expect(after?.dirty).toBe(0);
    expect(after?.last_error).toBe('nope');
  });

  it('does not mark sent an edit that landed while the push was in flight', async () => {
    // The compare-and-swap on `updated_at`. Without it the correction the
    // athlete just made is silently marked as already sent and never leaves the
    // phone — no error, nothing on the sync screen.
    await cacheTrackers(USER, [wire()]);
    await updateTrackerLocally(USER, water.id, { target: 2500 });

    mockApi.mockImplementationOnce(async () => {
      await updateTrackerLocally(USER, water.id, { target: 3000 });
      return {};
    });
    await syncTrackers(USER, token);

    const after = await definition(water.id);
    expect(after?.target).toBe(3000);
    expect(after?.dirty).toBe(1);
  });
});

describe('grouping', () => {
  it('hands each card only its own taps', () => {
    const map = byTracker([
      { id: 'a', tracker_id: 'water', logged_on: TODAY, logged_at: 'x', amount: 1 },
      { id: 'b', tracker_id: 'coffee', logged_on: TODAY, logged_at: 'x', amount: 1 },
      { id: 'c', tracker_id: 'water', logged_on: TODAY, logged_at: 'x', amount: 1 },
    ]);
    expect(map.get('water')).toHaveLength(2);
    expect(map.get('coffee')).toHaveLength(1);
    expect(map.get('nothing')).toBeUndefined();
  });
});
