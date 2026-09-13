/**
 * N565/#1108 — stuck sync rows reported off the device: count, age and code.
 *
 * Runs against a REAL migrated SQLite database, so the triggers that stamp
 * `stuck_since` are the ones that ship, and the grouping query is the one that
 * runs on a phone — not a regex over its text.
 *
 * Each describe block owns one property the ticket names:
 *
 * - the age comes from a recorded timestamp that follows the stuck STATE, not
 *   from `updated_at` and not from `last_error` being set;
 * - the counts are the SAME rows `needsAttention` counts;
 * - grouping is by the server's code, with explicit `unknown` / `other`;
 * - nothing but counts, ages and codes leaves the device;
 * - the cadence: at most daily unless the counts change;
 * - a report cannot be swallowed by an older one still in the buffer.
 */

import { ApiError } from '../apiError';
import { countRefusedPlans } from '../plan';
import { countRejectedRows } from '../rejectedRows';
import { countBlockedRows } from '../sessionStore';
import {
  MAX_CODES_PER_SOURCE,
  MIN_CHANGE_INTERVAL_MS,
  REPORT_EVERY_MS,
  STUCK_ROW_DETAIL_KEYS,
  reportStuckRows,
  stuckRowGroups,
  type StuckReportDeps,
} from '../stuckRows';
import { redact } from '../telemetry';
import {
  capture,
  flush,
  installTelemetry,
  resetTelemetry,
  setRejectionSelfTestTimeoutMsForTests,
} from '../telemetryClient';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
// Same reason as `telemetryClient.test.ts`: the real tracker leaks a timer per
// install, and only the coalescing test below installs.
jest.mock('promise/setimmediate/rejection-tracking', () => ({ enable: jest.fn(), disable: jest.fn() }));
setRejectionSelfTestTimeoutMsForTests(20);

let db: FixtureDb;
const USER = 'user_me';
const OTHER = 'user_someone_else';
const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

type Stuck = Partial<{
  user: string;
  dirty: number;
  deleted: string | null;
  error: string | null;
  code: string | null;
  since: string | null;
  name: string;
  updated: string;
}>;

async function session(id: string, o: Stuck = {}) {
  await db.runAsync(
    `INSERT INTO local_sessions
       (id, user_id, workout_id, sport, name, started_at, ended_at, notes,
        sets_json, dirty, remote, deleted_at, updated_at, last_error, last_error_code, stuck_since)
     VALUES (?, ?, NULL, 'strength', ?, '2026-09-01T10:00:00Z', NULL, 'a private note',
             '[]', ?, 1, ?, ?, ?, ?, ?)`,
    id, o.user ?? USER, o.name ?? 'Leg Day', o.dirty ?? 1, o.deleted ?? null,
    o.updated ?? '2026-09-01T10:00:00Z', o.error ?? null, o.code ?? null, o.since ?? null,
  );
}

async function workout(id: string, o: Stuck = {}) {
  await db.runAsync(
    `INSERT INTO workout_cache
       (id, user_id, sport, name, items_json, dirty, remote, updated_at, cached_at, last_error, last_error_code, stuck_since)
     VALUES (?, ?, 'strength', ?, '[]', ?, 1, '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', ?, ?, ?)`,
    id, o.user ?? USER, o.name ?? 'Push A', o.dirty ?? 1, o.error ?? null, o.code ?? null, o.since ?? null,
  );
}

async function plan(id: string, o: Stuck = {}) {
  await db.runAsync(
    `INSERT INTO planned_sessions
       (id, user_id, day, sport, notes, created_at, updated_at, dirty, remote, deleted_at,
        last_error, last_error_code, stuck_since)
     VALUES (?, ?, '2026-09-20', 'strength', '', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', ?, 1, ?, ?, ?, ?)`,
    id, o.user ?? USER, o.dirty ?? 1, o.deleted ?? null, o.error ?? null, o.code ?? null, o.since ?? null,
  );
}

async function foodEntry(id: string, o: Stuck = {}) {
  await db.runAsync(
    `INSERT INTO food_entries
       (id, user_id, eaten_on, meal, name, servings, serving_label, kcal,
        notes, position, logged_at, updated_at, dirty, remote, deleted_at,
        last_error, last_error_code, stuck_since)
     VALUES (?, ?, '2026-09-10', 'lunch', ?, 1, 'serving', 100, 'a private note', 0,
             '2026-09-10T12:00:00Z', ?, ?, 0, ?, ?, ?, ?)`,
    id, o.user ?? USER, o.name ?? 'Chicken', o.updated ?? '2026-09-10T12:00:00Z',
    o.dirty ?? 0, o.deleted ?? null, o.error ?? null, o.code ?? null, o.since ?? null,
  );
}

async function sequence(id: string, o: Stuck = {}) {
  await db.runAsync(
    `INSERT INTO sequences
       (id, user_id, name, description, steps_json, created_at, dirty, remote, last_error, last_error_code, stuck_since)
     VALUES (?, ?, ?, '', '[]', '2026-09-10T12:00:00Z', ?, 0, ?, ?, ?)`,
    id, o.user ?? USER, o.name ?? 'Guard pass', o.dirty ?? 0, o.error ?? null, o.code ?? null, o.since ?? null,
  );
}

const stamp = (table: string, id: string) =>
  db.getFirstAsync<{ stuck_since: string | null; last_error_code: string | null }>(
    `SELECT stuck_since, last_error_code FROM ${table} WHERE id = ?`,
    id,
  );

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('stuck_since follows the stuck STATE', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('is stamped when a session becomes blocked, kept while it stays blocked, and cleared with it', async () => {
    await session('s1');
    const before = Date.now();
    await db.runAsync(`UPDATE local_sessions SET last_error = 'refused', last_error_code = 'invalid_input' WHERE id = 's1'`);
    const after = Date.now();

    const stuck = await stamp('local_sessions', 's1');
    expect(stuck?.stuck_since).toMatch(ISO);
    // Measured, not merely present: the device clock at the transition.
    const at = Date.parse(stuck!.stuck_since!);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);

    // A second refusal with different words is the same stuck row. Pinned to a
    // known old value so "kept" cannot pass by re-stamping in the same millisecond.
    await db.runAsync(`UPDATE local_sessions SET stuck_since = ? WHERE id = 's1'`, hoursAgo(30));
    await db.runAsync(`UPDATE local_sessions SET last_error = 'refused again' WHERE id = 's1'`);
    expect((await stamp('local_sessions', 's1'))?.stuck_since).toBe(hoursAgo(30));

    // An edit clears the refusal — the row is owed again, not stuck.
    await db.runAsync(`UPDATE local_sessions SET last_error = NULL WHERE id = 's1'`);
    expect(await stamp('local_sessions', 's1')).toEqual({ stuck_since: null, last_error_code: null });
  });

  it('a food entry that merely failed offline is NOT stuck; the permanent refusal is when the clock starts', async () => {
    // `foodLog.ts` writes `last_error` on every failure, transient ones too, and
    // clears `dirty` only on a permanent one. A clock keyed on the message would
    // start at the basement, not at the refusal.
    await foodEntry('f1', { dirty: 1 });
    await db.runAsync(`UPDATE food_entries SET last_error = 'Can''t reach VOLA.' WHERE id = 'f1'`);
    expect((await stamp('food_entries', 'f1'))?.stuck_since).toBeNull();

    await db.runAsync(`UPDATE food_entries SET dirty = 0 WHERE id = 'f1'`);
    expect((await stamp('food_entries', 'f1'))?.stuck_since).toMatch(ISO);
  });

  it('a sequence follows the same rule', async () => {
    await sequence('q1', { dirty: 1 });
    await db.runAsync(`UPDATE sequences SET last_error = 'later' WHERE id = 'q1'`);
    expect((await stamp('sequences', 'q1'))?.stuck_since).toBeNull();
    await db.runAsync(`UPDATE sequences SET dirty = 0 WHERE id = 'q1'`);
    expect((await stamp('sequences', 'q1'))?.stuck_since).toMatch(ISO);
  });

  it('a plan moving from a refused create to a refused removal keeps its clock', async () => {
    await plan('p1');
    await db.runAsync(`UPDATE planned_sessions SET last_error = 'unknown sport' WHERE id = 'p1'`);
    expect((await stamp('planned_sessions', 'p1'))?.stuck_since).toMatch(ISO);
    await db.runAsync(`UPDATE planned_sessions SET stuck_since = ? WHERE id = 'p1'`, hoursAgo(50));

    await db.runAsync(`UPDATE planned_sessions SET dirty = 0 WHERE id = 'p1'`);
    expect((await stamp('planned_sessions', 'p1'))?.stuck_since).toBe(hoursAgo(50));
  });

  it('a tombstone is not stuck, so deleting a blocked session clears its clock', async () => {
    await session('s1', { error: 'refused', since: hoursAgo(3) });
    await db.runAsync(`UPDATE local_sessions SET deleted_at = '2026-09-12T11:00:00Z' WHERE id = 's1'`);
    expect((await stamp('local_sessions', 's1'))?.stuck_since).toBeNull();
  });

  it('clearing only the message clears the code too, so a later refusal cannot inherit it', async () => {
    // The ~30 edit paths write `last_error = NULL` and nothing else.
    await foodEntry('f1', { error: 'refused', code: 'invalid_input', since: hoursAgo(2) });
    await db.runAsync(`UPDATE food_entries SET dirty = 1, last_error = NULL WHERE id = 'f1'`);
    expect(await stamp('food_entries', 'f1')).toEqual({ stuck_since: null, last_error_code: null });
  });
});

describe('the counts are the rows needsAttention counts', () => {
  it('sums to countBlockedRows + countRejectedRows + countRefusedPlans, across every domain', async () => {
    // Stuck, one of each shape:
    await session('s-blocked', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await workout('w-blocked', { error: 'x', code: 'not_found', since: hoursAgo(1) });
    await plan('p-blocked', { dirty: 1, error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await plan('p-refused', { dirty: 0, error: 'x', code: 'forbidden', since: hoursAgo(1) });
    await foodEntry('f-refused', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await sequence('q-refused', { error: 'x', code: 'no_http_code', since: hoursAgo(1) });
    // Not stuck — each is the control for one clause of a predicate:
    await session('s-pending'); // no refusal
    await session('s-tomb', { error: 'x', deleted: '2026-09-12T00:00:00Z' }); // tombstone
    await foodEntry('f-transient', { dirty: 1, error: 'offline' }); // still owed
    await foodEntry('f-tomb', { error: 'x', deleted: '2026-09-12T00:00:00Z' });
    await plan('p-tomb', { dirty: 1, error: 'x', deleted: '2026-09-12T00:00:00Z' });
    await sequence('q-transient', { dirty: 1, error: 'later' });
    await foodEntry('f-other-user', { user: OTHER, error: 'x', code: 'invalid_input' });

    const groups = await stuckRowGroups(USER);
    const reported = groups.reduce((n, g) => n + g.rows, 0);
    const counted = (await countBlockedRows(USER)) + (await countRejectedRows(USER)) + (await countRefusedPlans(USER));

    // Apparatus: the counters really see the six, or equality proves nothing.
    expect(counted).toBe(6);
    expect(reported).toBe(counted);
    expect(groups.map((g) => [g.domain, g.state, g.code, g.rows])).toEqual([
      ['session', 'blocked', 'invalid_input', 1],
      ['workout', 'blocked', 'not_found', 1],
      ['plan', 'blocked', 'invalid_input', 1],
      ['plan', 'refused', 'forbidden', 1],
      ['food_entry', 'refused', 'invalid_input', 1],
      ['sequence', 'refused', 'no_http_code', 1],
    ]);
  });
});

describe('grouped by code, never by message', () => {
  it('two different messages under one code are one group', async () => {
    await session('s1', { error: 'set 10: weight must be greater than 0', code: 'invalid_input', since: hoursAgo(1) });
    await session('s2', { error: 'Session already finished', code: 'invalid_input', since: hoursAgo(1) });
    expect((await stuckRowGroups(USER)).map((g) => [g.code, g.rows])).toEqual([['invalid_input', 2]]);
  });

  it('a row with no recorded code is `unknown`, and a value not shaped like a code is `other`', async () => {
    await session('legacy', { error: 'refused before N565' });
    await session('weird', { error: 'x', code: 'Internal Server Error <html>' });
    expect((await stuckRowGroups(USER)).map((g) => [g.code, g.rows])).toEqual([
      ['other', 1],
      ['unknown', 1],
    ]);
  });

  it(`keeps the ${MAX_CODES_PER_SOURCE} largest codes per domain and folds the rest into other, never folding unknown`, async () => {
    const codes = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg'];
    for (const [i, code] of codes.entries()) {
      // `aaa` has 7 rows, `ggg` has 1 — so the top five by count are aaa..eee.
      for (let r = 0; r < codes.length - i; r++) {
        await session(`${code}-${r}`, { error: 'x', code, since: hoursAgo(10 + i) });
      }
    }
    await session('legacy', { error: 'x' });

    const groups = await stuckRowGroups(USER);
    expect(groups.map((g) => [g.code, g.rows])).toEqual([
      ['aaa', 7], ['bbb', 6], ['ccc', 5], ['ddd', 4], ['eee', 3],
      ['other', 3], // fff (2) + ggg (1)
      ['unknown', 1],
    ]);
    // Folding keeps the oldest age of what it folded, not the newest.
    expect(groups.find((g) => g.code === 'other')?.oldestStuckSince).toBe(hoursAgo(16));
    // Every row is still counted exactly once.
    expect(groups.reduce((n, g) => n + g.rows, 0)).toBe(29);
  });
});

describe('the age of the oldest stuck row', () => {
  const captured: { level: string; kind: string; message: string; details: Record<string, unknown> }[] = [];
  const deps = (over: Partial<StuckReportDeps> = {}): StuckReportDeps => ({
    now: () => NOW,
    capture: (level, kind, message, details) => {
      captured.push({ level, kind, message, details: details ?? {} });
    },
    flush: async () => {},
    ...over,
  });
  beforeEach(() => {
    captured.length = 0;
  });

  it('comes from stuck_since, not updated_at', async () => {
    // updated_at says a year; stuck_since says five hours. Only one is the age.
    await foodEntry('f1', { error: 'x', code: 'invalid_input', since: hoursAgo(5.5), updated: '2025-09-12T12:00:00.000Z' });
    await foodEntry('f2', { error: 'x', code: 'invalid_input', since: hoursAgo(2), updated: '2025-01-01T00:00:00.000Z' });

    await reportStuckRows(USER, deps());
    expect(captured).toHaveLength(1);
    expect(captured[0].details).toMatchObject({ rows: 2, oldest_age_hours: 5, rows_age_unknown: 0 });
  });

  it('counts rows with no recorded age separately, and sends no age at all when none has one', async () => {
    await session('legacy-1', { error: 'x', code: 'invalid_input' });
    await session('legacy-2', { error: 'x', code: 'invalid_input' });
    await workout('new', { error: 'x', code: 'not_found', since: hoursAgo(1) });
    await workout('old', { error: 'x', code: 'not_found' });

    await reportStuckRows(USER, deps());
    const bySource = Object.fromEntries(captured.map((c) => [c.details.entity, c.details]));
    // Not 0: zero would read as "just got stuck", which is the one thing unknown.
    expect(bySource.session).toEqual({
      reason: 'stuck_blocked', entity: 'session', code: 'invalid_input', rows: 2, rows_age_unknown: 2,
    });
    expect(bySource.workout).toMatchObject({ rows: 2, rows_age_unknown: 1, oldest_age_hours: 1 });
  });
});

describe('what leaves the device', () => {
  it('is counts, ages and codes: no id, name, note or message, and every key survives the allowlist', async () => {
    const SECRET = 'Rolled-with-Marcus-after-the-knee-injury';
    await session(`id-${SECRET}`, { name: SECRET, error: `server said: ${SECRET}`, code: 'invalid_input', since: hoursAgo(4) });
    await foodEntry(`fid-${SECRET}`, { name: SECRET, error: SECRET, code: 'invalid_input', since: hoursAgo(4) });
    await sequence(`qid-${SECRET}`, { name: SECRET, error: SECRET });

    const calls: unknown[][] = [];
    await reportStuckRows(USER, {
      now: () => NOW,
      capture: (...a) => {
        calls.push(a);
      },
      flush: async () => {},
    });

    expect(calls).toHaveLength(3);
    const wire = JSON.stringify(calls);
    expect(wire).not.toContain('Marcus');
    expect(wire).not.toContain('private note');
    expect(wire).not.toContain('server said');
    for (const [level, kind, message, details] of calls as [string, string, string, Record<string, unknown>][]) {
      expect([level, kind]).toEqual(['error', 'sync_blocked']);
      expect(message).toMatch(/^stuck rows: [a-z_]+ (blocked|refused) [a-z_]+$/);
      for (const key of Object.keys(details)) expect(STUCK_ROW_DETAIL_KEYS).toContain(key);
      // `redact()` is the allowlist: a key it drops would arrive silently missing.
      expect(redact(details)).toEqual(details);
      for (const v of Object.values(details)) {
        expect(typeof v === 'number' || /^[a-z_]+$/.test(String(v))).toBe(true);
      }
    }
  });
});

describe('cadence: at most once a day, unless the counts change', () => {
  let sent: number;
  let order: string[];
  let clock: number;
  const run = (over: Partial<StuckReportDeps> = {}) =>
    reportStuckRows(USER, {
      now: () => clock,
      capture: () => {
        sent += 1;
        order.push('capture');
      },
      flush: async () => {
        order.push('flush');
      },
      ...over,
    });
  const marker = () =>
    db.getFirstAsync<{ value: string; dirty: number }>(
      `SELECT value, dirty FROM prefs WHERE user_id = ? AND key = 'stuck_rows_reported'`,
      USER,
    );

  beforeEach(() => {
    sent = 0;
    order = [];
    clock = NOW;
  });

  it('sends nothing, and writes nothing, when nothing is stuck', async () => {
    await session('fine');
    expect(await run()).toBe(false);
    expect(sent).toBe(0);
    expect(await marker()).toBeNull();
  });

  it('reports the first time, then not again the same day while the counts hold', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    expect(await run()).toBe(true);
    expect(sent).toBe(1);
    // Drained BEFORE capturing, so an older buffered report cannot swallow this
    // one; sent AFTER, rather than left for the 30-second timer.
    expect(order).toEqual(['flush', 'capture', 'flush']);
    // The marker is device-local, never owed to the account.
    expect((await marker())?.dirty).toBe(0);

    clock = NOW + REPORT_EVERY_MS - 1;
    expect(await run()).toBe(false);
    expect(sent).toBe(1);

    clock = NOW + REPORT_EVERY_MS;
    expect(await run()).toBe(true);
    expect(sent).toBe(2);
  });

  it('reports again when the counts change — but not twice inside the minimum interval', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await run();
    expect(sent).toBe(1);

    await session('s2', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    clock = NOW + MIN_CHANGE_INTERVAL_MS - 1;
    expect(await run()).toBe(false);

    clock = NOW + MIN_CHANGE_INTERVAL_MS;
    expect(await run()).toBe(true);
    expect(sent).toBe(2);
  });

  it('an age that grew is not a change in the counts', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await run();
    clock = NOW + 6 * 3_600_000;
    expect(await run()).toBe(false);
  });

  it('a corrupt marker, or a clock moved back past it, costs one extra report rather than silence', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    await db.runAsync(
      `INSERT INTO prefs (user_id, key, value, dirty) VALUES (?, 'stuck_rows_reported', 'not json{', 0)`,
      USER,
    );
    expect(await run()).toBe(true);

    clock = NOW - 60_000;
    expect(await run()).toBe(true);
    expect(sent).toBe(2);
  });

  it('never captures for an athlete who is no longer signed in', async () => {
    // The buffer flushes under whichever token is installed THEN, so a report
    // built for A and captured after a switch to B would be filed under B.
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    expect(await run({ isCurrent: () => false })).toBe(false);
    expect(sent).toBe(0);
    expect(await marker()).toBeNull();
  });

  it('re-checks the athlete after writing the marker — the switch can land during that await', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    let asked = 0;
    // Still signed in when the report is decided, signed out by the time the
    // marker write resolves.
    expect(await run({ isCurrent: () => ++asked === 1 })).toBe(false);
    expect(asked).toBe(2);
    expect(sent).toBe(0);
  });

  it('never throws, even when the database does', async () => {
    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    db.raw.exec('DROP TABLE prefs');
    await expect(run()).resolves.toBe(false);
    expect(sent).toBe(0);
  });
});

describe('a report cannot be swallowed by an older one still buffered', () => {
  type Posted = { events: { message: string; details: Record<string, unknown> }[] };
  const originalFetch = globalThis.fetch;
  let posted: Posted[];

  beforeEach(() => {
    posted = [];
    resetTelemetry();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    resetTelemetry();
    globalThis.fetch = originalFetch;
  });

  it('sends this pass’s numbers, not the stale report the timer never flushed', async () => {
    installTelemetry(async () => 'tok');
    const message = 'stuck rows: session blocked invalid_input';
    // An earlier report for the same group, still in the buffer — the flush
    // timer does not run while the app is backgrounded.
    capture('error', 'sync_blocked', message, { reason: 'stuck_blocked', entity: 'session', code: 'invalid_input', rows: 99 });

    await session('s1', { error: 'x', code: 'invalid_input', since: hoursAgo(1) });
    // A second group in the SAME domain and state: only its code tells the two
    // apart, so it is what proves groups do not coalesce into one another.
    await session('s2', { error: 'x', code: 'not_found', since: hoursAgo(1) });
    await session('s3', { error: 'x', code: 'not_found', since: hoursAgo(1) });
    expect(await reportStuckRows(USER, { now: () => NOW })).toBe(true);
    await flush();
    await new Promise((r) => setTimeout(r, 0));

    const events = posted.flatMap((p) => p.events);
    const forGroup = events.filter((e) => e.message === message);
    // Apparatus: the report really went out through the real client.
    expect(forGroup.length).toBeGreaterThan(0);
    expect(forGroup[forGroup.length - 1].details).toMatchObject({ rows: 1 });
    expect(events.filter((e) => e.details.code === 'not_found').at(-1)?.details).toMatchObject({ rows: 2 });
  });
});

describe('a refusal with no parseable envelope is not a server code', () => {
  it('is reported under no_http_code, apart from rows that simply have no history', async () => {
    const { refusalCodeOf } = jest.requireActual('../apiError') as typeof import('../apiError');
    await session('parse', { error: 'x', code: refusalCodeOf(new ApiError('Request failed (502).', 'unknown', 502)), since: hoursAgo(1) });
    await session('legacy', { error: 'x' });
    expect((await stuckRowGroups(USER)).map((g) => g.code)).toEqual(['no_http_code', 'unknown']);
  });
});
