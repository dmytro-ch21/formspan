import { ApiError, OfflineError } from '../apiError';
import { localEntries, logFood, saveFoodLocally, syncFood } from '../foodLog';
import type { Entry } from '../nutrition';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * N428 (#686) — the fresh-install backfill for `food_entries`.
 *
 * Reported after a device uninstall wiped a real athlete's local food log:
 * the sync outbox for entries was, and in steady state still is, push-only
 * (see `foodLog.ts`'s own top-of-file comment) — nothing pulls a meal back
 * down, so a reinstall showed an empty log with real history sitting on the
 * server the whole time. Same defect shape N85 fixed for `local_sessions`
 * (`historyBackfill.test.ts` pins that one); this file pins the nutrition
 * equivalent.
 *
 * The mechanism differs from N85's in two respects worth stating up front:
 *
 * 1. `GET /nutrition/entries` is windowed by CALENDAR DATE (`from`/`to`,
 *    capped server-side at 31 days), not paged by `limit`/`offset` like
 *    sessions — so this walks backward through fixed-width date windows
 *    instead of numbered pages, and (unlike sessions) never stops early on
 *    an empty window, because an empty CALENDAR window is not evidence
 *    there is nothing further back — an athlete can take a quiet month.
 *    Only the window-count ceiling ends the loop.
 * 2. It is gated on a PERSISTED PREF (`PREF_FOOD_BACKFILL_DONE_AT`), not on
 *    `food_entries` being empty. A row-count gate was this ticket's FIRST
 *    version, and both `ac-verifier` and `frontend-reviewer` independently
 *    found the same failure mode in it: whatever briefly makes the table
 *    non-empty — a meal logged (and pushed) before the very first sync, a
 *    few meals logged offline before connectivity returns, or the
 *    backfill's own window 1 landing before window 2 throws — permanently
 *    disarms it. The describe block below, "a device that logs before its
 *    history has landed", and the retry test in the failure block, pin
 *    exactly those three cases.
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
jest.mock('../apiRequest', () => ({
  apiRequest: (...a: unknown[]) => mockApi(...a),
}));

const USER = 'u1';
const token = async () => 'tok';

// Noon UTC on the 18th is still the 18th in America/Los_Angeles (the suite's
// fixed TZ, `package.json`'s `test` script) — chosen so the window math below
// cannot be thrown off by the local-vs-UTC date boundary `calendar.ts`'s own
// `dayString` doc comment warns about.
const NOW = new Date('2026-08-18T12:00:00.000Z');

function entryInput(over: Record<string, unknown> = {}) {
  return {
    eaten_on: '2026-08-18',
    meal: 'lunch' as const,
    name: 'A meal',
    servings: 1,
    serving_label: '1',
    kcal: 1,
    protein_g: 1,
    carb_g: 1,
    fat_g: 1,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    ...over,
  };
}

function serverEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'srv-1',
    eaten_on: '2026-08-18',
    meal: 'lunch',
    name: 'Server lunch',
    servings: 1,
    serving_label: '100 g',
    kcal: 400,
    protein_g: 30,
    carb_g: 20,
    fat_g: 10,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source_food_id: null,
    category: null,
    notes: '',
    ...over,
  };
}

/** Serve `{ entries }` to the backfill's GET and `{}` to everything else. */
function entriesReturn(entries: Entry[]) {
  mockApi.mockImplementation(async (_t: unknown, path: string) =>
    String(path).startsWith('/nutrition/entries?') ? { entries } : {},
  );
}

const entryCalls = () =>
  mockApi.mock.calls.filter(([, path]) => String(path).startsWith('/nutrition/entries?'));

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  mockApi.mockReset().mockResolvedValue({});
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a device that has never held a food entry for this athlete', () => {
  it('pulls the server window into the local store', async () => {
    // Only the FIRST (most-recent) window carries the entry — real windows
    // never overlap in date range, so a real device never gets the same row
    // twice across windows. Every window mocked identically would make
    // `pulled` a count of MOCK CALLS rather than of entries, which is not
    // the thing this test exists to pin.
    mockApi.mockImplementation(async (_t: unknown, path: string) => {
      if (path === '/nutrition/entries?from=2026-07-19&to=2026-08-18') {
        return { entries: [serverEntry()] };
      }
      return String(path).startsWith('/nutrition/entries?') ? { entries: [] } : {};
    });

    const res = await syncFood(USER, token);

    expect(await localEntries(USER, '2026-08-18')).toHaveLength(1);
    expect(res.pulled).toBe(1);
  });

  it('asks for 31-day windows, newest first, matching the server’s own bound', async () => {
    entriesReturn([]);

    await syncFood(USER, token);

    // `daysBetween('2026-07-19', '2026-08-18') === 30`, one under the
    // server's `maxEntryWindowDays` (31) — one day wider and the very first
    // request would 400.
    expect(entryCalls()[0]).toEqual([token, '/nutrition/entries?from=2026-07-19&to=2026-08-18']);
    // Windows are contiguous and non-overlapping: the second starts the day
    // before the first ends.
    expect(entryCalls()[1]).toEqual([token, '/nutrition/entries?from=2026-06-18&to=2026-07-18']);
  });

  it('stops after 12 windows even if the server never runs dry — the ceiling is real, not decorative', async () => {
    // Every window "full" of the one entry, forever, so the only thing that
    // can end the loop is the window-count cap. If a future edit removes
    // that cap this test's call count silently changes and fails loudly,
    // rather than the backfill just taking longer.
    entriesReturn([serverEntry()]);

    await syncFood(USER, token);

    expect(entryCalls()).toHaveLength(12);
  });

  it('does NOT stop early on an empty window — a quiet month is not evidence there is nothing further back', async () => {
    // Unlike `sessionStore.ts`'s offset-paged backfill, a short/empty
    // CALENDAR window proves nothing about what is further back in time.
    entriesReturn([]);

    await syncFood(USER, token);

    expect(entryCalls()).toHaveLength(12);
  });

  it('a window that fails stops the loop rather than silently skipping to the next one', async () => {
    mockApi.mockImplementation(async (_t: unknown, path: string) => {
      if (String(path).startsWith('/nutrition/entries?from=2026-07-19')) {
        throw new ApiError('upstream', 'internal', 500);
      }
      return { entries: [] };
    });

    const res = await syncFood(USER, token);

    // The one window attempted, and no more — the whole backfill aborts on
    // its first failure rather than pressing on with a partial, silently
    // incomplete history.
    expect(entryCalls()).toHaveLength(1);
    expect(res.error).toBeTruthy();
  });

  it('reports a failed window as a sync FAILURE the orchestrator will retry with backoff, not just a message', async () => {
    // `frontend-reviewer`'s finding: a catch that only sets `result.error`
    // (matching the routine foods-pull catch beside it) leaves `failed` at 0
    // for a sync whose pushes all succeeded — `sync.ts`'s orchestrator reads
    // that as a clean run and schedules no retry, so a backfill this device
    // still owes waits for the athlete to happen to relaunch the app.
    mockApi.mockRejectedValue(new ApiError('upstream', 'internal', 500));

    const res = await syncFood(USER, token);

    expect(res.failed).toBeGreaterThan(0);
    expect(res.errorKind).toBeDefined();
  });

  it('retries the WHOLE pass on the next sync after a failed window — nothing already landed is lost, nothing is skipped', async () => {
    // Window 1 succeeds and writes a row; window 2 throws. The fix for
    // `frontend-reviewer`'s blocking finding: a row landing before a later
    // window throws must not permanently disarm the rest of the backfill —
    // which is exactly what a row-count gate would do the moment window 1's
    // entry made the table non-empty.
    let n = 0;
    mockApi.mockImplementation(async (_t: unknown, path: string) => {
      if (!String(path).startsWith('/nutrition/entries?')) return {};
      n++;
      if (n === 1) return { entries: [serverEntry({ id: 'srv-1' })] };
      throw new ApiError('upstream', 'internal', 500);
    });

    const first = await syncFood(USER, token);
    expect(first.failed).toBeGreaterThan(0);
    expect(await localEntries(USER, '2026-08-18')).toHaveLength(1); // window 1's row survived

    // A second sync, everything now answering cleanly — the point under test
    // is only that the backfill is ATTEMPTED again at all, not skipped
    // because the table (thanks to window 1) is no longer empty.
    entriesReturn([]);
    mockApi.mockClear();
    const second = await syncFood(USER, token);

    expect(second.error).toBeFalsy();
    expect(entryCalls().length).toBeGreaterThan(0);
  });

  it('does not repeat the backfill on a later sync once a full pass has completed', async () => {
    entriesReturn([]);
    await syncFood(USER, token); // 12 empty windows, all clean — the pref gets written

    mockApi.mockClear();
    await syncFood(USER, token);

    expect(entryCalls()).toHaveLength(0);
  });

  it('still runs even though the device already holds an entry logged before the very first sync completed', async () => {
    // The exact sequence `ac-verifier` found breaks a row-count gate:
    // reinstall, sign in, log a meal before any sync has finished. That meal
    // is a real local row by the time the backfill section is reached, and
    // must not read as "this device already has confirmed history".
    await logFood(USER, entryInput({ name: 'Logged before the first sync' }));
    entriesReturn([]);

    await syncFood(USER, token);

    expect(entryCalls()).toHaveLength(12);
  });

  it('still runs even though the device already holds several entries logged OFFLINE across days', async () => {
    // The multi-day variant of the same gap: several meals logged while
    // offline, never yet confirmed by the server, well before connectivity
    // (and the backfill's own chance to run) ever returns.
    await logFood(USER, entryInput({ name: 'Day 1, offline' }));
    await logFood(USER, entryInput({ name: 'Day 2, offline', eaten_on: '2026-08-17' }));
    entriesReturn([]);

    await syncFood(USER, token);

    expect(entryCalls()).toHaveLength(12);
  });

  it('never asks at all once a DIRTY FOOD push has already stalled the sync offline', async () => {
    // The entries table is empty — this IS a fresh install by the backfill's
    // own test — but a food still owed from before the reinstall (say, drafted
    // offline and never sent) fails first, and that must stall the WHOLE
    // sync, including a backfill that has not started yet, the same way it
    // already stalls the routine foods/entries push queues.
    await saveFoodLocally(USER, {
      kind: 'food',
      name: 'Owed food',
      brand: '',
      serving_label: '1',
      serving_grams: null,
      kcal: 1,
      protein_g: 1,
      carb_g: 1,
      fat_g: 1,
      fibre_g: null,
      saturated_fat_g: null,
      sugar_g: null,
      added_sugar_g: null,
      sodium_mg: null,
      cholesterol_mg: null,
    });
    mockApi.mockRejectedValue(new OfflineError());

    const res = await syncFood(USER, token);

    expect(res.errorKind).toBe('offline');
    expect(entryCalls()).toHaveLength(0);
  });
});

it('another user’s COMPLETED backfill does not disguise this account’s own fresh install as already done', async () => {
  entriesReturn([]);
  await syncFood('u2', token); // finishes u2's backfill and writes u2's own pref

  mockApi.mockClear();
  entriesReturn([serverEntry()]);
  await syncFood(USER, token);

  expect(entryCalls()).toHaveLength(12);
});
