import { migratedFixture, type FixtureDb } from './support/sqlite';
import {
  appendRunFixes,
  clearRunFixQueue,
  pruneRunFixesThrough,
  readRunFixQueue,
  setRunTrackingIdentity,
} from '../runningTrackingTask';

/**
 * W21/#992 — the durable capture queue, against the REAL `running_fix_queue`
 * table the app's own `migrate()` creates.
 *
 * This is the piece a locked screen depends on: the background task appends
 * here and makes no decisions, and the running screen drains with a cursor.
 * What has to hold is that a fix is delivered to the screen exactly once, in
 * the order it happened, and survives the app being killed mid-run — which
 * is the whole reason the queue is on disk rather than in memory.
 */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'user_run_q';
const RUN = 'ses-run-1';
const t0 = new Date('2026-09-08T18:00:00.000Z');

function fix(secondsIn: number, over: Partial<{ accuracy: number; speed: number; altitude: number }> = {}) {
  return {
    coords: {
      latitude: 40.7 + secondsIn / 100_000,
      longitude: -74 + secondsIn / 100_000,
      altitude: over.altitude ?? 10,
      accuracy: over.accuracy ?? 5,
      speed: over.speed ?? 3,
    },
    timestamp: t0.getTime() + secondsIn * 1000,
  };
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('appendRunFixes / readRunFixQueue', () => {
  it('keeps every field the screen needs to interpret a fix, in order', async () => {
    await appendRunFixes(USER, RUN, [fix(0), fix(3, { accuracy: 42, speed: 2.5, altitude: 12 })]);
    const rows = await readRunFixQueue(USER, RUN, 0);

    expect(rows).toHaveLength(2);
    expect(rows[0].recorded_at).toBe(t0.toISOString());
    expect(rows[1]).toMatchObject({ accuracy_m: 42, speed_mps: 2.5, elevation_m: 12 });
    expect(rows[1].recorded_at).toBe(new Date(t0.getTime() + 3000).toISOString());
    expect(rows[0].id).toBeLessThan(rows[1].id);
  });

  it('a cursor delivers each fix exactly once — the guarantee the drain relies on', async () => {
    await appendRunFixes(USER, RUN, [fix(0), fix(3)]);
    const first = await readRunFixQueue(USER, RUN, 0);
    const cursor = first[first.length - 1].id;

    // Nothing new yet.
    expect(await readRunFixQueue(USER, RUN, cursor)).toEqual([]);

    // The task keeps appending while the screen is asleep.
    await appendRunFixes(USER, RUN, [fix(6), fix(9)]);
    const second = await readRunFixQueue(USER, RUN, cursor);

    expect(second).toHaveLength(2);
    expect(second.map((r) => r.recorded_at)).toEqual([
      new Date(t0.getTime() + 6000).toISOString(),
      new Date(t0.getTime() + 9000).toISOString(),
    ]);
    // …and never re-delivers what the first drain already consumed.
    expect(second.every((r) => r.id > cursor)).toBe(true);
  });

  it('a locked-screen backlog is preserved whole, not sampled', async () => {
    // Ten minutes at the 3s cadence — what an actual locked screen produces.
    const batch = Array.from({ length: 200 }, (_, i) => fix(i * 3));
    await appendRunFixes(USER, RUN, batch);

    const rows = await readRunFixQueue(USER, RUN, 0, 2_000);
    expect(rows).toHaveLength(200);
    // Strictly ordered: distance is a sum of consecutive segments, so an
    // out-of-order drain would draw a zig-zag and inflate the total.
    const times = rows.map((r) => Date.parse(r.recorded_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('never mixes runs or athletes', async () => {
    await appendRunFixes(USER, RUN, [fix(0)]);
    await appendRunFixes(USER, 'ses-run-2', [fix(3)]);
    await appendRunFixes('someone_else', RUN, [fix(6)]);

    expect(await readRunFixQueue(USER, RUN, 0)).toHaveLength(1);
    expect(await readRunFixQueue(USER, 'ses-run-2', 0)).toHaveLength(1);
    expect(await readRunFixQueue('someone_else', RUN, 0)).toHaveLength(1);
  });

  it('an empty batch writes nothing', async () => {
    await appendRunFixes(USER, RUN, []);
    expect(await readRunFixQueue(USER, RUN, 0)).toEqual([]);
  });
});

describe('clearRunFixQueue', () => {
  it('releases this run only, once its points are saved with the session', async () => {
    await appendRunFixes(USER, RUN, [fix(0), fix(3)]);
    await appendRunFixes(USER, 'ses-run-2', [fix(6)]);

    await clearRunFixQueue(USER, RUN);

    expect(await readRunFixQueue(USER, RUN, 0)).toEqual([]);
    expect(await readRunFixQueue(USER, 'ses-run-2', 0)).toHaveLength(1);
  });
});

describe('pruneRunFixesThrough — what makes the drain survive an app kill', () => {
  it('drops what the saved route already covers and keeps the rest', async () => {
    // The screen's cursor is in memory, so a relaunched screen starts at
    // zero. Without this prune it re-reads every fix already folded into
    // `route_points` and appends them a second time: duplicate route,
    // inflated distance, corrupted elapsed time. Review found exactly that.
    await appendRunFixes(USER, RUN, [fix(0), fix(3), fix(6), fix(9)]);

    // The app died after the fix at +6s had been recorded and persisted.
    await pruneRunFixesThrough(USER, RUN, new Date(t0.getTime() + 6000).toISOString());

    const left = await readRunFixQueue(USER, RUN, 0);
    expect(left.map((r) => r.recorded_at)).toEqual([new Date(t0.getTime() + 9000).toISOString()]);
  });

  it('is inclusive of the boundary, so the last saved point is never replayed', async () => {
    await appendRunFixes(USER, RUN, [fix(0)]);
    await pruneRunFixesThrough(USER, RUN, t0.toISOString());
    expect(await readRunFixQueue(USER, RUN, 0)).toEqual([]);
  });

  it('touches only this run', async () => {
    await appendRunFixes(USER, RUN, [fix(0)]);
    await appendRunFixes(USER, 'ses-run-2', [fix(0)]);
    await pruneRunFixesThrough(USER, RUN, new Date(t0.getTime() + 60_000).toISOString());
    expect(await readRunFixQueue(USER, RUN, 0)).toEqual([]);
    expect(await readRunFixQueue(USER, 'ses-run-2', 0)).toHaveLength(1);
  });
});

describe('the active-run identity is on disk', () => {
  it('survives a process that has never run the screen — iOS relaunches to deliver fixes', async () => {
    await setRunTrackingIdentity({ userID: USER, sessionID: RUN });

    // A relaunched process: nothing in memory, only what the task can read.
    const row = await mockFixture.getFirstAsync<{ user_id: string; session_id: string }>(
      `SELECT user_id, session_id FROM running_tracking_active WHERE id = 1`,
    );
    expect(row).toEqual({ user_id: USER, session_id: RUN });
  });

  it('holds exactly one run, and clearing it leaves nothing to capture for', async () => {
    await setRunTrackingIdentity({ userID: USER, sessionID: RUN });
    await setRunTrackingIdentity({ userID: USER, sessionID: 'ses-run-2' });
    const rows = await mockFixture.getAllAsync<{ session_id: string }>(
      `SELECT session_id FROM running_tracking_active`,
    );
    expect(rows).toEqual([{ session_id: 'ses-run-2' }]);

    await setRunTrackingIdentity(null);
    expect(await mockFixture.getAllAsync(`SELECT * FROM running_tracking_active`)).toEqual([]);
  });
});
