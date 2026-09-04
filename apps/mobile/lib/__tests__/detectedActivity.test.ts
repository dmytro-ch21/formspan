/**
 * N479/#824 — the "detected but not logged" ledger and its pure filtering.
 *
 * Two halves, same split every sync-adjacent test file in this suite makes:
 * the PURE decisions (`windowsOverlap`/`isAlreadyLogged`/`visibleDetections`)
 * need no database and are tested directly; the SQLite half
 * (`upsertDetectedActivities`/`readRecentDetections`/`dismissDetection`/
 * `logDetectionAsSession`) runs against a REAL migrated fixture via
 * `support/sqlite.ts`, the same `../db` redirection `healthkitSync.test.ts`
 * uses — a mock standing in for SQLite could supply the `ON CONFLICT`/`INSERT
 * OR IGNORE` behaviour under test rather than prove it.
 */

import { migratedFixture, type FixtureDb } from './support/sqlite';
import {
  activityTypeLabel,
  dismissDetection,
  isAlreadyLogged,
  logDetectionAsSession,
  readRecentDetections,
  sourceLabel,
  upsertDetectedActivities,
  visibleDetections,
  windowsOverlap,
  type DetectedWorkout,
  type ExistingSessionWindow,
} from '../detectedActivity';
import { deleteLocalSession, listLocalSessions, sessionsSince, startLocalSession } from '../sessionStore';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

let mockUuidSeq = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockRequestSync = jest.fn();
jest.mock('../sync', () => ({ request: (reason: string) => mockRequestSync(reason) }));

const USER = 'user_da_1';

function workout(overrides: Partial<DetectedWorkout> = {}): DetectedWorkout {
  return {
    id: 'hk-walk-1',
    type: 'walking',
    source: 'healthkit',
    startDate: '2026-09-01T07:00:00.000Z',
    endDate: '2026-09-01T07:32:00.000Z',
    durationSeconds: 1920,
    distanceMeters: 2400,
    ...overrides,
  };
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockRequestSync.mockClear();
});

describe('windowsOverlap', () => {
  it('is true when the windows share any instant', () => {
    expect(
      windowsOverlap(
        '2026-09-01T07:00:00.000Z',
        '2026-09-01T07:30:00.000Z',
        '2026-09-01T07:15:00.000Z',
        '2026-09-01T07:45:00.000Z',
      ),
    ).toBe(true);
  });

  it('is false for two windows that never touch', () => {
    expect(
      windowsOverlap(
        '2026-09-01T07:00:00.000Z',
        '2026-09-01T07:30:00.000Z',
        '2026-09-01T08:00:00.000Z',
        '2026-09-01T08:30:00.000Z',
      ),
    ).toBe(false);
  });

  it('is false for two windows that merely touch at the boundary (half-open)', () => {
    expect(
      windowsOverlap(
        '2026-09-01T07:00:00.000Z',
        '2026-09-01T07:30:00.000Z',
        '2026-09-01T07:30:00.000Z',
        '2026-09-01T08:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('is true when one window fully contains the other', () => {
    expect(
      windowsOverlap(
        '2026-09-01T07:00:00.000Z',
        '2026-09-01T08:00:00.000Z',
        '2026-09-01T07:10:00.000Z',
        '2026-09-01T07:20:00.000Z',
      ),
    ).toBe(true);
  });
});

describe('isAlreadyLogged', () => {
  const w = workout();

  it('is false with no sessions at all', () => {
    expect(isAlreadyLogged(w, [])).toBe(false);
  });

  it('is true when a finished session overlaps the workout window, regardless of sport', () => {
    const sessions: ExistingSessionWindow[] = [
      { id: 's1', started_at: '2026-09-01T07:05:00.000Z', ended_at: '2026-09-01T07:20:00.000Z' },
    ];
    expect(isAlreadyLogged(w, sessions)).toBe(true);
  });

  it('is false when every session is outside the workout window', () => {
    const sessions: ExistingSessionWindow[] = [
      { id: 's1', started_at: '2026-09-01T09:00:00.000Z', ended_at: '2026-09-01T09:30:00.000Z' },
    ];
    expect(isAlreadyLogged(w, sessions)).toBe(false);
  });

  it('ignores a still-running session (ended_at null) even if its start overlaps', () => {
    // A session with no end has no final window to compare against — see
    // this function's own doc comment for why treating it as "now onward"
    // would be the wrong call, not merely an unhandled case.
    const sessions: ExistingSessionWindow[] = [
      { id: 's1', started_at: '2026-09-01T07:05:00.000Z', ended_at: null },
    ];
    expect(isAlreadyLogged(w, sessions)).toBe(false);
  });
});

describe('visibleDetections', () => {
  it('drops a detection already covered by a logged session', () => {
    const covered = workout({ id: 'covered' });
    const clear = workout({
      id: 'clear',
      startDate: '2026-09-02T07:00:00.000Z',
      endDate: '2026-09-02T07:30:00.000Z',
    });
    const sessions: ExistingSessionWindow[] = [
      { id: 's1', started_at: '2026-09-01T07:10:00.000Z', ended_at: '2026-09-01T07:20:00.000Z' },
    ];
    const result = visibleDetections([covered, clear], sessions);
    expect(result.map((d) => d.id)).toEqual(['clear']);
  });

  it('sorts newest first', () => {
    const older = workout({ id: 'older', startDate: '2026-08-30T07:00:00.000Z', endDate: '2026-08-30T07:30:00.000Z' });
    const newer = workout({ id: 'newer', startDate: '2026-09-01T07:00:00.000Z', endDate: '2026-09-01T07:30:00.000Z' });
    expect(visibleDetections([older, newer], []).map((d) => d.id)).toEqual(['newer', 'older']);
  });
});

describe('activityTypeLabel / sourceLabel', () => {
  it('labels walking and hiking', () => {
    expect(activityTypeLabel('walking')).toBe('Walk');
    expect(activityTypeLabel('hiking')).toBe('Hike');
  });

  it('labels each platform source', () => {
    expect(sourceLabel('healthkit')).toBe('via Apple Health');
    expect(sourceLabel('health_connect')).toBe('via Google Health');
  });
});

describe('upsertDetectedActivities / readRecentDetections — the real ledger', () => {
  const sinceISO = '2026-08-25T00:00:00.000Z';

  it('records a fresh detection and reads it back', async () => {
    await upsertDetectedActivities(USER, 'healthkit', [workout()]);
    const rows = await readRecentDetections(USER, sinceISO);
    expect(rows).toEqual([workout()]);
  });

  it('is scoped per user — a second user never sees the first one\'s detections', async () => {
    await upsertDetectedActivities(USER, 'healthkit', [workout()]);
    const rows = await readRecentDetections('someone_else', sinceISO);
    expect(rows).toEqual([]);
  });

  it('INSERT OR IGNOREs a re-detected workout rather than overwriting it', async () => {
    await upsertDetectedActivities(USER, 'healthkit', [workout({ durationSeconds: 1000 })]);
    // A later pass re-reports the SAME workout with a different duration —
    // simulating HealthKit's own numbers drifting slightly between reads.
    // The row must not be silently replaced, because the real reason this
    // matters is the dismissal test right below: an overwrite here would
    // also blank `dismissed_at`.
    await upsertDetectedActivities(USER, 'healthkit', [workout({ durationSeconds: 2000 })]);
    const rows = await readRecentDetections(USER, sinceISO);
    expect(rows).toHaveLength(1);
    expect(rows[0].durationSeconds).toBe(1000);
  });

  it('a dismissed detection is excluded even when re-detected on a later pass', async () => {
    await upsertDetectedActivities(USER, 'healthkit', [workout()]);
    await dismissDetection(USER, workout().id);
    // Re-detected, exactly as a real foreground pass would re-report it.
    await upsertDetectedActivities(USER, 'healthkit', [workout()]);
    const rows = await readRecentDetections(USER, sinceISO);
    expect(rows).toEqual([]);
  });

  it('excludes a detection older than the given window', async () => {
    await upsertDetectedActivities(USER, 'healthkit', [
      workout({ startDate: '2026-08-01T07:00:00.000Z', endDate: '2026-08-01T07:30:00.000Z' }),
    ]);
    const rows = await readRecentDetections(USER, sinceISO);
    expect(rows).toEqual([]);
  });
});

describe("sessionStore's sessionsSince — the real query isAlreadyLogged is fed from", () => {
  it('returns a finished session in range, excludes a deleted one, and keeps a still-running one', async () => {
    const inRange = await startLocalSession(USER, {
      sport: 'strength',
      name: 'Lift',
      started_at: '2026-09-01T06:00:00.000Z',
      ended_at: '2026-09-01T06:45:00.000Z',
    });
    const deleted = await startLocalSession(USER, {
      sport: 'strength',
      name: 'Lift (deleted)',
      started_at: '2026-09-01T05:00:00.000Z',
      ended_at: '2026-09-01T05:45:00.000Z',
    });
    await deleteLocalSession(USER, deleted.id);
    const running = await startLocalSession(USER, {
      sport: 'strength',
      name: 'Live',
      started_at: '2026-09-01T08:00:00.000Z',
    });

    const rows = await sessionsSince(USER, '2026-08-25T00:00:00.000Z');
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([inRange.id, running.id].sort());
    expect(rows.find((r) => r.id === running.id)?.ended_at).toBeNull();
  });

  it('excludes a session older than the given window', async () => {
    await startLocalSession(USER, {
      sport: 'strength',
      name: 'Old lift',
      started_at: '2026-08-01T06:00:00.000Z',
      ended_at: '2026-08-01T06:45:00.000Z',
    });
    const rows = await sessionsSince(USER, '2026-08-25T00:00:00.000Z');
    expect(rows).toEqual([]);
  });
});

describe('logDetectionAsSession', () => {
  it('creates a finished running session named for the activity type, and requests a sync', async () => {
    await logDetectionAsSession(USER, workout({ type: 'hiking' }));
    const sessions = await listLocalSessions(USER);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sport).toBe('running');
    expect(sessions[0].name).toBe('Hike');
    expect(sessions[0].started_at).toBe('2026-09-01T07:00:00.000Z');
    expect(sessions[0].ended_at).toBe('2026-09-01T07:32:00.000Z');
    expect(sessions[0].sets).toHaveLength(1);
    expect(sessions[0].sets[0].distance_m).toBe(2400);
    expect(sessions[0].sets[0].seconds).toBe(1920);
    expect(sessions[0].sets[0].completed).toBe(true);
    expect(mockRequestSync).toHaveBeenCalledWith('detected-activity-logged');
  });

  it('the resulting session then hides the detection via isAlreadyLogged (no separate flag needed)', async () => {
    const w = workout();
    await logDetectionAsSession(USER, w);
    const sessions = await listLocalSessions(USER);
    const windows: ExistingSessionWindow[] = sessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
    }));
    expect(visibleDetections([w], windows)).toEqual([]);
  });
});
