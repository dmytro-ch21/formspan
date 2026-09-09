import type { Module } from '../modules';
import type { Session } from '../sessions';
import { upsert, listLocalSessions } from '../sessionStore';
import { buildTodayBoard, loggedOn } from '../todayBoard';
import type { Source } from '../trainBoard';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * N548 — *what did this day log*, and the fact that Today can be showing a day
 * that is not today.
 *
 * ## Why this reads the real store rather than an array literal
 *
 * The selection is one filter and one sort, and a test that hands it a
 * hand-built array proves only that the filter matches strings the test itself
 * chose. The interesting risk is at the seam: `local_sessions.started_at` is
 * an ISO instant, the day it belongs to is the LOCAL calendar day it began on,
 * and the rest of the app buckets it that way too (`trainingSince` does it in
 * SQL with `date(started_at, 'localtime')`). A session begun at 8pm Pacific is
 * stored under the following UTC date — so a selection that split the string
 * instead of reading a local day would file every evening session under
 * tomorrow, and an array of `'2026-08-26T09:00:00'`-shaped literals would
 * never show it.
 *
 * So these go through `upsert` into a migrated SQLite database, come back
 * through `listLocalSessions` (the exact read `useTodayBoard` makes), and only
 * then hit {@link loggedOn}. The suite runs under `TZ=America/Los_Angeles`
 * precisely so the evening-session case has a real offset to get wrong.
 *
 * ## Mutation-tested
 *
 * Each of these was confirmed to go red against a deliberately broken
 * implementation, with the same run green beforehand — see the PR body for the
 * transcript. The mutations that matter:
 *
 * - `loggedOn` ignoring its `dayKey` (returning every session) → the empty-day
 *   and browsed-day cases fail.
 * - `loggedOn` reading `started_at.slice(0, 10)` instead of the local day →
 *   the evening-session case fails, the others do not.
 * - `buildTodayBoard` keying `logged` on `viewDay` rather than
 *   `momentumDayKey` → the resume case fails.
 * - the resume-id filter dropped → the resume case's row count fails.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const userID = 'u1';

/** An ISO instant for a local wall-clock moment, so the tests read in calendar terms. */
function at(y: number, m: number, d: number, h: number, mi = 0): string {
  return new Date(y, m - 1, d, h, mi, 0).toISOString();
}

/** `dayString`'s own rule, restated here so the test does not import what it checks. */
function key(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function seed(over: {
  id: string;
  sport?: string;
  name?: string;
  started_at: string;
  ended_at?: string | null;
}): Promise<void> {
  await upsert(
    {
      id: over.id,
      user_id: userID,
      workout_id: null,
      sport: over.sport ?? 'strength',
      name: over.name ?? over.id,
      intent: 'normal',
      started_at: over.started_at,
      ended_at: over.ended_at === undefined ? over.started_at : over.ended_at,
      notes: '',
      sets: [],
      created_at: over.started_at,
      updated_at: over.started_at,
      dirty: false,
    },
    userID,
    false,
    true,
  );
}

/** The 30-row read `useTodayBoard` makes, verbatim. */
function read(): Promise<Session[]> {
  return listLocalSessions(userID, 30) as unknown as Promise<Session[]>;
}

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
});

describe('loggedOn selects the day being shown, from the real local store', () => {
  test('a day with nothing selects nothing — and the store is not empty', async () => {
    await seed({ id: 'mon', started_at: at(2026, 8, 24, 18) });
    await seed({ id: 'wed', started_at: at(2026, 8, 26, 7) });

    const rows = await read();
    // The apparatus first: an empty result here would satisfy the assertion
    // below for the wrong reason entirely.
    expect(rows).toHaveLength(2);

    expect(loggedOn(rows, key(2026, 8, 25))).toEqual([]);
  });

  test('a day with several sports selects all of them, newest first', async () => {
    await seed({ id: 'lift', sport: 'strength', name: 'Legs', started_at: at(2026, 8, 26, 7) });
    await seed({ id: 'roll', sport: 'bjj', name: 'Gi class', started_at: at(2026, 8, 26, 19) });
    await seed({ id: 'run', sport: 'running', name: 'Easy 5k', started_at: at(2026, 8, 26, 12) });
    // The neighbouring days exist, so "it selected everything" cannot pass.
    await seed({ id: 'before', started_at: at(2026, 8, 25, 19) });
    await seed({ id: 'after', started_at: at(2026, 8, 27, 6) });

    const picked = loggedOn(await read(), key(2026, 8, 26));

    expect(picked.map((s) => s.id)).toEqual(['roll', 'run', 'lift']);
    expect(picked.map((s) => s.sport)).toEqual(['bjj', 'running', 'strength']);
  });

  test('order comes from the SORT, not from the order it was handed', async () => {
    // `listLocalSessions` already returns `ORDER BY started_at DESC`, so a
    // selection with no sort of its own looks correct against the store and is
    // wrong the moment anything else supplies the rows — which is exactly what
    // the screen's own tests do with a mock. Handed deliberately backwards.
    await seed({ id: 'morning', started_at: at(2026, 8, 26, 7) });
    await seed({ id: 'evening', started_at: at(2026, 8, 26, 19) });
    await seed({ id: 'midday', started_at: at(2026, 8, 26, 12) });

    const scrambled = [...(await read())].sort((a, b) =>
      new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
    );
    expect(scrambled.map((s) => s.id)).toEqual(['morning', 'midday', 'evening']);

    expect(loggedOn(scrambled, key(2026, 8, 26)).map((s) => s.id)).toEqual([
      'evening',
      'midday',
      'morning',
    ]);
  });

  test('an in-progress session is selected, not dropped for having no end', async () => {
    await seed({ id: 'open', started_at: at(2026, 8, 26, 19), ended_at: null });
    await seed({ id: 'done', started_at: at(2026, 8, 26, 7) });

    const picked = loggedOn(await read(), key(2026, 8, 26));

    expect(picked.map((s) => s.id)).toEqual(['open', 'done']);
    expect(picked[0].ended_at).toBeNull();
  });

  test('an evening session belongs to its LOCAL day, not to the UTC date it is stored as', async () => {
    // 8pm Pacific on the 26th is 03:00Z on the 27th. Reading the stored string
    // — which is what a `slice(0, 10)` would do — files this under the 27th.
    const evening = at(2026, 8, 26, 20);
    await seed({ id: 'evening', started_at: evening });

    // The apparatus, stated rather than assumed: this test is worthless unless
    // the stored instant really does carry the following date.
    expect(evening.slice(0, 10)).toBe('2026-08-27');

    const rows = await read();
    expect(loggedOn(rows, key(2026, 8, 26)).map((s) => s.id)).toEqual(['evening']);
    expect(loggedOn(rows, key(2026, 8, 27))).toEqual([]);
  });

  test('a deleted session is gone, because the store is what answers', async () => {
    await seed({ id: 'kept', started_at: at(2026, 8, 26, 7) });
    await seed({ id: 'binned', started_at: at(2026, 8, 26, 9) });
    await db.runAsync(
      `UPDATE local_sessions SET deleted_at = ? WHERE id = 'binned'`,
      at(2026, 8, 26, 10),
    );

    expect(loggedOn(await read(), key(2026, 8, 26)).map((s) => s.id)).toEqual(['kept']);
  });
});

/*
 * `buildTodayBoard`'s own use of the selection — the browsed-day criterion and
 * the resume exception, over the same real rows.
 */

function mod(key: string, label: string, catalog: string): Module {
  return {
    key,
    label,
    is_sport: true,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog,
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
    },
  } as unknown as Module;
}

const MODULES = [
  mod('strength', 'Strength', 'exercises'),
  mod('bjj', 'BJJ', 'techniques'),
  mod('running', 'Running', 'exercises'),
];

function ready<T>(value: T): Source<T> {
  return { state: 'ready', value };
}

/**
 * The rows out of a `Source`, or a marker that says which non-ready state it
 * was — never `false`, which reads as an empty list in a failing assertion and
 * would let an `unread` board pass a "logged nothing" test.
 */
function rowsOf(s: Source<Session[]>): Session[] | string {
  return s.state === 'ready' ? s.value : `<${s.state}>`;
}

/** The ids in reading order, or the non-ready state's own marker. */
function ids(s: Source<Session[]>): string[] | string {
  return s.state === 'ready' ? s.value.map((x) => x.id) : `<${s.state}>`;
}

function board(sessions: Session[], now: Date, viewDay?: Date) {
  return buildTodayBoard({
    sessions: ready(sessions),
    plans: ready([]),
    workouts: ready([]),
    modules: MODULES,
    now,
    viewDay,
  });
}

describe('Today shows the browsed day, not always real today', () => {
  const NOW = new Date(2026, 7, 26, 18, 0, 0); // Wed 26 Aug 2026, local

  test('browsing back a day lists that day, and none of today', async () => {
    await seed({ id: 'today-lift', name: 'Legs', started_at: at(2026, 8, 26, 7) });
    await seed({ id: 'yesterday-roll', sport: 'bjj', name: 'Gi', started_at: at(2026, 8, 25, 19) });

    const rows = await read();

    const onToday = board(rows, NOW);
    expect(onToday.logged.state).toBe('ready');
    expect(ids(onToday.logged)).toEqual(['today-lift']);

    const yesterday = new Date(2026, 7, 25, 12, 0, 0);
    const browsed = board(rows, NOW, yesterday);
    expect(ids(browsed.logged)).toEqual(['yesterday-roll']);
  });

  test('a browsed day with nothing on it lists nothing, while today still has rows', async () => {
    await seed({ id: 'today-lift', started_at: at(2026, 8, 26, 7) });

    const rows = await read();
    const browsed = board(rows, NOW, new Date(2026, 7, 24, 12, 0, 0));

    expect(rowsOf(browsed.logged)).toEqual([]);
    // Same rows, same call, different day — so an empty answer above is the
    // day and not a broken read.
    expect(rowsOf(board(rows, NOW).logged)).toHaveLength(1);
  });

  test('the count under a rest day is the length of the list above it', async () => {
    await seed({ id: 'a', started_at: at(2026, 8, 25, 7) });
    await seed({ id: 'b', sport: 'bjj', started_at: at(2026, 8, 25, 19) });

    const b = board(await read(), NOW, new Date(2026, 7, 25, 12, 0, 0));

    expect(b.lead.state === 'ready' && b.lead.value.kind).toBe('rest');
    const count =
      b.lead.state === 'ready' && b.lead.value.kind === 'rest' ? b.lead.value.loggedToday : -1;
    expect(count).toBe(2);
    expect(rowsOf(b.logged)).toHaveLength(count);
  });

  test('a running session pins the list to real today and drops itself from it', async () => {
    // The day switcher is hidden during a resume, so a `dayOffset` left over
    // from browsing is neither visible nor correctable — every day-following
    // read on Today resolves to real today in that state.
    await seed({ id: 'open', started_at: at(2026, 8, 26, 17, 30), ended_at: null });
    await seed({ id: 'earlier', name: 'Legs', started_at: at(2026, 8, 26, 7) });
    await seed({ id: 'yesterday', started_at: at(2026, 8, 25, 19) });

    const b = board(await read(), NOW, new Date(2026, 7, 25, 12, 0, 0));

    expect(b.lead.state === 'ready' && b.lead.value.kind).toBe('resume');
    // Real today's rows, not the browsed day's — and the resumed session is
    // not repeated below the card that already draws it.
    expect(ids(b.logged)).toEqual(['earlier']);
  });

  test('a SECOND open session still appears, so it is filtered by id and not by state', async () => {
    await seed({ id: 'newest-open', started_at: at(2026, 8, 26, 17, 30), ended_at: null });
    await seed({ id: 'older-open', started_at: at(2026, 8, 26, 9), ended_at: null });

    const b = board(await read(), NOW);

    expect(b.lead.state === 'ready' && b.lead.value.kind).toBe('resume');
    expect(ids(b.logged)).toEqual(['older-open']);
  });

  test('an unread or failed session read is carried through, never rendered as an empty day', () => {
    for (const s of [{ state: 'unread' } as const, { state: 'unavailable' } as const]) {
      const b = buildTodayBoard({
        sessions: s,
        plans: ready([]),
        workouts: ready([]),
        modules: MODULES,
        now: NOW,
      });
      expect(b.logged.state).toBe(s.state);
    }
  });
});
