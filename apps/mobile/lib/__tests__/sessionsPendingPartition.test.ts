/**
 * N167/#544, slice 2 — a session or workout the server refused stops counting
 * as pending, and a fix to it is never stranded.
 *
 * Runs against a REAL SQLite database through `migratedFixture()`, like every
 * outbox test here: a predicate's behaviour is what SQLite does with it, not
 * whether the clause appears in a string.
 *
 * ## The two properties, and why each is a trap
 *
 * **1. Pending and blocked PARTITION the owed rows.** `BLOCKED_ROW` is one
 * predicate shared by `blockedRows`, `countBlockedRows`, `countPendingSessions`
 * and `countPendingWorkouts`. Every owed row must land in exactly one of the
 * two answers. A row in both inflates two numbers; a row in NEITHER is
 * uncounted AND invisible — the failure this slice exists to rule out, and one
 * no screen would ever reveal.
 *
 * **2. Every edit clears `last_error`.** Before this slice only the delete
 * paths did, which was harmless while pending counted every dirty row. Once
 * pending excludes blocked rows it is a trap: fix set 10 of a refused session,
 * the stale refusal survives, the fix is still classed as blocked, excluded
 * from pending — and the foreground and backoff triggers are gated on
 * `pending > 0`, so it is never sent.
 */

import {
  blockedRows,
  countBlockedRows,
  countPendingSessions,
  countPendingWorkouts,
  finishLocalSession,
  renameLocalSession,
  renameLocalWorkout,
  rescheduleLocalSession,
  saveLocalBjjDetail,
  saveLocalRunningDetail,
  saveLocalSets,
  saveLocalWorkoutItems,
} from '../sessionStore';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let db: FixtureDb;
// `mock`-prefixed so the jest.mock factory may close over it.
let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const U = 'u1';
const REFUSED = 'set 10: weight must be greater than 0';

async function seedSession(
  id: string,
  over: { dirty?: number; last_error?: string | null; deleted_at?: string | null; user?: string } = {},
) {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, last_error)
     VALUES (?, ?, NULL, 'strength', 'Push day', '2026-08-01T10:00:00Z', NULL, '',
             '[]', ?, 1, ?, '2026-08-01T10:00:00Z', ?)`,
    id,
    over.user ?? U,
    over.dirty ?? 1,
    over.deleted_at ?? null,
    over.last_error ?? null,
  );
}

async function seedWorkout(
  id: string,
  over: { dirty?: number; name_dirty?: number; last_error?: string | null; deleted_at?: string | null } = {},
) {
  await db.runAsync(
    `INSERT INTO workout_cache
       (id, user_id, sport, name, items_json, dirty, remote, name_dirty,
        deleted_at, updated_at, cached_at, last_error)
     VALUES (?, ?, 'strength', 'Push', '[]', ?, 1, ?, ?, '2026-08-01T10:00:00Z',
             '2026-08-01T10:00:00Z', ?)`,
    id,
    U,
    over.dirty ?? 1,
    over.name_dirty ?? 0,
    over.deleted_at ?? null,
    over.last_error ?? null,
  );
}

const lastErrorOf = async (table: 'local_sessions' | 'workout_cache', id: string) =>
  (await db.getFirstAsync<{ last_error: string | null }>(
    `SELECT last_error FROM ${table} WHERE id = ?`,
    id,
  ))?.last_error;

const dirtySessionCount = async () =>
  (await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_sessions WHERE user_id = ? AND dirty = 1`,
    U,
  ))?.n ?? 0;

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('sessions: pending and blocked partition every owed row exactly once', () => {
  it('a refused session is blocked, not pending', async () => {
    await seedSession('s1', { last_error: REFUSED });
    expect(await countPendingSessions(U)).toBe(0);
    expect(await countBlockedRows(U)).toBe(1);
  });

  it('a merely queued session is pending, not blocked', async () => {
    await seedSession('s1');
    expect(await countPendingSessions(U)).toBe(1);
    expect(await countBlockedRows(U)).toBe(0);
  });

  it('a refused TOMBSTONE stays pending, deliberately, and is not listed as blocked', async () => {
    // `blockedRows` excludes tombstones (F5: a deleted row offered an "Open"
    // button leading nowhere), and its own comment says a failing delete
    // "still counts toward the pending badge". Asserted so that stays a choice.
    await seedSession('s1', { last_error: REFUSED, deleted_at: '2026-08-02T10:00:00Z' });
    expect(await countPendingSessions(U)).toBe(1);
    expect(await countBlockedRows(U)).toBe(0);
    expect(await blockedRows(U)).toEqual([]);
  });

  it('pending + blocked equals every owed session — nothing counted twice or dropped', async () => {
    await seedSession('queued');
    await seedSession('refused', { last_error: REFUSED });
    await seedSession('refused-tomb', { last_error: REFUSED, deleted_at: '2026-08-02T10:00:00Z' });
    await seedSession('clean', { dirty: 0 });
    expect((await countPendingSessions(U)) + (await countBlockedRows(U))).toBe(await dirtySessionCount());
    expect(await dirtySessionCount()).toBe(3);
  });

  it('the blocked count agrees with the list it summarises', async () => {
    await seedSession('a', { last_error: REFUSED });
    await seedSession('b', { last_error: REFUSED, deleted_at: '2026-08-02T10:00:00Z' });
    await seedSession('c');
    await seedWorkout('w1', { last_error: REFUSED });
    expect(await countBlockedRows(U)).toBe((await blockedRows(U)).length);
    expect(await countBlockedRows(U)).toBe(2);
  });

  it('never counts another athlete’s blocked rows', async () => {
    await seedSession('mine', { last_error: REFUSED });
    await seedSession('theirs', { last_error: REFUSED, user: 'someone_else' });
    expect(await countBlockedRows(U)).toBe(1);
  });
});

describe('workouts', () => {
  it('a refused workout is blocked, not pending', async () => {
    await seedWorkout('w1', { last_error: REFUSED });
    expect(await countPendingWorkouts(U)).toBe(0);
    expect(await countBlockedRows(U)).toBe(1);
  });

  it('a workout refused on a RENAME alone stays pending — never uncounted and invisible', async () => {
    // `name_dirty = 1, dirty = 0`. `blockedRows` has always required
    // `dirty = 1`, so it does not list this row. Excluding it from pending as
    // well would leave it counted nowhere and shown nowhere — the one outcome
    // `BLOCKED_ROW` exists to rule out.
    await seedWorkout('w1', { dirty: 0, name_dirty: 1, last_error: REFUSED });
    expect(await countPendingWorkouts(U)).toBe(1);
    expect(await countBlockedRows(U)).toBe(0);
    expect(await blockedRows(U)).toEqual([]);
  });
});

describe('every edit clears the stale refusal — the trap', () => {
  it('fixing a refused session puts it back in pending, so it is actually sent', async () => {
    await seedSession('s1', { last_error: REFUSED });
    expect(await countPendingSessions(U)).toBe(0);

    await saveLocalSets(U, 's1', []);

    expect(await lastErrorOf('local_sessions', 's1')).toBeNull();
    expect(await countPendingSessions(U)).toBe(1);
    expect(await countBlockedRows(U)).toBe(0);
  });

  const sessionEdits: [string, (id: string) => Promise<unknown>][] = [
    ['saveLocalSets', (id) => saveLocalSets(U, id, [])],
    ['finishLocalSession', (id) => finishLocalSession(U, id, '2026-08-01T12:00:00Z')],
    ['saveLocalBjjDetail', (id) => saveLocalBjjDetail(U, id, {} as never)],
    ['saveLocalRunningDetail', (id) => saveLocalRunningDetail(U, id, {} as never)],
    ['renameLocalSession', (id) => renameLocalSession(U, id, 'Renamed')],
    ['rescheduleLocalSession', (id) => rescheduleLocalSession(U, id, new Date('2026-08-05T12:00:00Z'))],
  ];

  it.each(sessionEdits)('%s clears last_error on a refused session', async (_name, edit) => {
    await seedSession('s1', { last_error: REFUSED });
    await edit('s1');
    expect(await lastErrorOf('local_sessions', 's1')).toBeNull();
  });

  const workoutEdits: [string, (id: string) => Promise<unknown>][] = [
    ['saveLocalWorkoutItems', (id) => saveLocalWorkoutItems(U, id, [])],
    ['renameLocalWorkout', (id) => renameLocalWorkout(U, id, 'Renamed')],
  ];

  it.each(workoutEdits)('%s clears last_error on a refused workout', async (_name, edit) => {
    await seedWorkout('w1', { last_error: REFUSED });
    await edit('w1');
    expect(await lastErrorOf('workout_cache', 'w1')).toBeNull();
  });
});
