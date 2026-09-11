/**
 * N541 tranche 1 (#972) — the day panel's assembly, against a real database.
 *
 * ## Why a fixture and not array literals
 *
 * Every fact here comes from a row, and the bugs worth catching live between
 * the row and the day it belongs to: a session begun at 8:30pm Pacific is
 * stored as tomorrow in UTC, a target is in force from the newest row ON OR
 * BEFORE the day, a tombstoned plan still exists as a row. An array literal
 * hands the assembly whatever the author believed about those, so it cannot
 * disagree with them. Rows here are written through the app's own functions
 * (`planSession`, `startLocalSession`, `logTap`, `logFood`, `cacheTargets`) and
 * read back through the same functions `useDayPanel` calls, under the suite's
 * `TZ=America/Los_Angeles`.
 *
 * ## What "offline" means in this file
 *
 * Every network path the app has is made to fail — `apiRequest` rejects and
 * `fetch` is a spy — and the day still assembles in full. The assertion is that
 * neither was called at all, which is stronger than "it survived a failure":
 * a panel that tried the network and fell back would pass the second and fail
 * the first.
 */

import { assembleDay, current, panelFacts, type DayFact, type DayPanel } from '../dayPanel';
import { cacheTargets, logFood } from '../foodLog';
import type { Module } from '../modules';
import type { Target } from '../nutrition';
import { planSession, unplanSession } from '../plan';
import { startLocalSession } from '../sessionStore';
import { buildTodayBoard } from '../todayBoard';
import type { Tracker } from '../trackerModel';
import { cacheTrackers, logTap } from '../trackers';
import { readDayPanel, unbackedFacts } from './support/dayFacts';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

// Every request the app can make fails, loudly, as it would in a dead spot.
const mockApi = jest.fn((..._a: unknown[]) => Promise.reject(new TypeError('Network request failed')));
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const USER = 'u1';
const OTHER = 'u2';

/** 9pm on Thursday 10 September 2026, in the suite's Los Angeles zone. */
const NOW = new Date(2026, 8, 10, 21, 0, 0);
const TODAY = '2026-09-10';
const YESTERDAY = '2026-09-09';
const TOMORROW = '2026-09-11';

function mod(key: string, over: Partial<Module['capabilities']> = {}, isSport = true): Module {
  return {
    key,
    label: key === 'bjj' ? 'BJJ' : key[0].toUpperCase() + key.slice(1),
    is_sport: isSport,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
      ...over,
    },
  } as Module;
}

const WITH_FOOD: Module[] = [
  mod('strength', { catalog: 'exercises' } as Module['capabilities']),
  mod('bjj'),
  mod('nutrition', { has_food_log: true }, false),
];
const WITHOUT_FOOD: Module[] = WITH_FOOD.filter((m) => m.key !== 'nutrition');

function tracker(over: Partial<Tracker> & { id: string }): Tracker {
  return {
    preset: '',
    name: over.id,
    icon: 'drop',
    color_key: 'blue',
    unit: 'ml',
    increment: 250,
    target: 2000,
    render_style: 'auto',
    sort_order: 0,
    count_noun: 'glass',
    provisioned: false,
    cutoff_minutes: null,
    ...over,
  };
}

function wire(t: Tracker) {
  return { ...t, user_id: USER, archived_at: null, created_at: 'x', updated_at: 'x' };
}

function target(over: Partial<Target> = {}): Target {
  return { effective_on: '2026-09-01', kcal: 2700, protein_g: 180, carb_g: 300, fat_g: 80, fibre_g: 30, ...over };
}

async function eat(user: string, on: string, kcal: number): Promise<string> {
  return logFood(user, {
    eaten_on: on,
    meal: 'lunch',
    name: `Meal ${kcal}`,
    servings: 1,
    serving_label: '1 bowl',
    kcal,
    protein_g: 20,
    carb_g: 50,
    fat_g: 10,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  });
}

/** A local instant, as the ISO string the app stores. */
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m, 0).toISOString();

/** The day, read the way `useDayPanel` reads it — see `readDayPanel`. */
const readPanel = (modules: Module[], now = NOW, user = USER): Promise<DayPanel> =>
  readDayPanel(user, modules, now);

const keys = (facts: DayFact[]) => facts.map((f) => f.key);

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockApi.mockClear();
  fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('a real day, assembled from rows the app itself wrote', () => {
  it('states the plan, what was logged, what is next, the targets and the goal — offline', async () => {
    const water = tracker({ id: 'water', name: 'Water' });
    const coffee = tracker({ id: 'coffee', name: 'Coffee', unit: 'cup', increment: 1, target: null });
    await cacheTrackers(USER, [wire(water), wire(coffee)]);
    await cacheTargets(USER, '2026-09-01', '2026-09-01', [target()]);

    const bjjToday = await planSession(USER, TODAY, 'bjj', null, '', 19 * 60);
    const strengthTomorrow = await planSession(USER, TOMORROW, 'strength', null);
    await planSession(USER, YESTERDAY, 'strength', null);

    const lift = await startLocalSession(USER, {
      sport: 'strength',
      name: 'Pull day',
      started_at: at(10, 20, 30),
      ended_at: at(10, 20, 55),
    });
    await startLocalSession(USER, {
      sport: 'strength',
      name: 'Yesterday',
      started_at: at(9, 10),
      ended_at: at(9, 11),
    });

    const cupA = await logTap(USER, water, TODAY);
    const cupB = await logTap(USER, water, TODAY);
    await logTap(USER, water, YESTERDAY);
    await logTap(USER, coffee, TODAY);

    const lunch = await eat(USER, TODAY, 500);
    await eat(USER, YESTERDAY, 900);

    const panel = await readPanel(WITH_FOOD);

    // TODAY's BJJ is owed — strength was logged, and a plan is met by its own
    // sport only (`matchPlans`).
    expect(panel.plan).toEqual({
      state: 'ready',
      value: { kind: 'owed', facts: [expect.objectContaining({ key: `planned:${bjjToday.id}` })] },
    });
    expect(keys(panel.logged.state === 'ready' ? panel.logged.value : [])).toEqual([
      `logged:${lift.id}`,
    ]);
    expect(panel.next).toEqual({
      state: 'ready',
      value: expect.objectContaining({ key: `next:${strengthTomorrow.id}` }),
    });

    // Water has a target; coffee does not, so coffee is not a target.
    expect(panel.trackers).toEqual({
      state: 'ready',
      value: [
        expect.objectContaining({
          key: 'tracker:water',
          logged: 2,
          target: 8,
          refs: [
            { table: 'daily_trackers', id: 'water' },
            { table: 'tracker_entries', id: cupA },
            { table: 'tracker_entries', id: cupB },
          ],
        }),
      ],
    });

    expect(panel.food).toEqual({
      state: 'ready',
      value: expect.objectContaining({
        key: `food-eaten:${TODAY}`,
        entries: 1,
        totals: expect.objectContaining({ kcal: 500 }),
        refs: [{ table: 'food_entries', id: lunch }],
      }),
    });

    // In force from the newest row on or before today — set on the 1st.
    expect(panel.target).toEqual({
      state: 'ready',
      value: expect.objectContaining({ key: 'nutrition-target:2026-09-01' }),
    });

    // Every fact names live rows belonging to this athlete.
    expect(await unbackedFacts(mockFixture, USER, panelFacts(panel))).toEqual([]);

    // And nothing tried the network to get there.
    expect(mockApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("files an 8:30pm session under today, not under the UTC tomorrow it is stored as", async () => {
    const stored = at(10, 20, 30);
    // The wrong answer, stated, so the assertion below is about something.
    expect(stored.slice(0, 10)).toBe(TOMORROW);

    const s = await startLocalSession(USER, {
      sport: 'strength',
      name: 'Evening',
      started_at: stored,
      ended_at: at(10, 21),
    });
    // And one that really is tomorrow local, which must not appear today.
    await startLocalSession(USER, {
      sport: 'strength',
      name: 'After midnight',
      started_at: at(11, 0, 30),
      ended_at: at(11, 1),
    });

    const panel = await readPanel(WITH_FOOD);
    expect(keys(panel.logged.state === 'ready' ? panel.logged.value : [])).toEqual([
      `logged:${s.id}`,
    ]);
  });

  it('reads only this athlete, on a device another account has used', async () => {
    await planSession(OTHER, TODAY, 'bjj', null);
    await startLocalSession(OTHER, { sport: 'strength', name: 'Theirs', started_at: at(10, 9), ended_at: at(10, 10) });
    await eat(OTHER, TODAY, 700);

    const panel = await readPanel(WITH_FOOD);
    expect(panelFacts(panel)).toEqual([]);
    expect(panel.plan).toEqual({ state: 'ready', value: { kind: 'rest' } });
    expect(panel.food).toEqual({ state: 'ready', value: null });
  });
});

describe('the plan, as Today decides it', () => {
  it('done: every plan met — the fact names the plan rows, and agrees with the count', async () => {
    const p1 = await planSession(USER, TODAY, 'strength', null);
    const p2 = await planSession(USER, TODAY, 'bjj', null);
    await startLocalSession(USER, { sport: 'strength', name: 'Lift', started_at: at(10, 7), ended_at: at(10, 8) });
    await startLocalSession(USER, { sport: 'bjj', name: 'Class', started_at: at(10, 18), ended_at: at(10, 19) });

    const panel = await readPanel(WITH_FOOD);
    expect(panel.plan.state).toBe('ready');
    const status = panel.plan.state === 'ready' ? panel.plan.value : null;
    expect(status?.kind).toBe('done');
    const fact = status?.kind === 'done' ? status.fact : null;
    expect(fact).toMatchObject({ kind: 'plan-done', planned: 2 });
    expect(fact?.refs).toEqual([
      { table: 'planned_sessions', id: p1.id },
      { table: 'planned_sessions', id: p2.id },
    ]);
    expect(await unbackedFacts(mockFixture, USER, panelFacts(panel))).toEqual([]);
  });

  it('rest: nothing planned is an absence — no plan fact, and what was logged still shows', async () => {
    const s = await startLocalSession(USER, { sport: 'bjj', name: 'Open mat', started_at: at(10, 12), ended_at: at(10, 13) });

    const panel = await readPanel(WITH_FOOD);
    expect(panel.plan).toEqual({ state: 'ready', value: { kind: 'rest' } });
    expect(keys(panelFacts(panel))).toEqual([`logged:${s.id}`]);
  });

  it('resume: an open session leads, and is not listed a second time as logged', async () => {
    await planSession(USER, TODAY, 'strength', null);
    const open = await startLocalSession(USER, { sport: 'strength', name: 'Now', started_at: at(10, 20, 30) });

    const panel = await readPanel(WITH_FOOD);
    expect(panel.plan).toEqual({
      state: 'ready',
      value: { kind: 'resume', fact: expect.objectContaining({ key: `session-open:${open.id}`, stale: false }) },
    });
    expect(panel.logged).toEqual({ state: 'ready', value: [] });
  });

  it('a plan the athlete deleted is not stated, even though its row still exists', async () => {
    const kept = await planSession(USER, TODAY, 'strength', null);
    const gone = await planSession(USER, TODAY, 'bjj', null);
    await unplanSession(USER, gone.id);

    const panel = await readPanel(WITH_FOOD);
    const planned = panel.plan.state === 'ready' && panel.plan.value.kind === 'owed' ? panel.plan.value.facts : [];
    expect(keys(planned)).toEqual([`planned:${kept.id}`]);
  });
});

describe('no absence from a read that did not answer', () => {
  it('a device that has never been told about trackers or a target says so, rather than "none"', async () => {
    // A fresh install: no tracker row and no targets-fetched marker. Both reads
    // answer `unknown`, which must not become "you track nothing" or
    // "no target set".
    const panel = await readPanel(WITH_FOOD);
    expect(panel.trackers).toEqual({ state: 'unavailable' });
    expect(panel.target).toEqual({ state: 'unavailable' });
  });

  it('"no target set" only once the server has actually answered with none', async () => {
    await cacheTargets(USER, TODAY, TODAY, []);
    const panel = await readPanel(WITH_FOOD);
    expect(panel.target).toEqual({ state: 'ready', value: null });
  });

  it('unread and failed reads produce no facts and no ready-but-empty section', () => {
    const unread = { state: 'unread' } as const;
    const failed = { state: 'unavailable' } as const;
    for (const s of [unread, failed]) {
      const board = buildTodayBoard({ sessions: s, plans: s, workouts: s, modules: WITH_FOOD, now: NOW });
      const panel = assembleDay({
        day: TODAY,
        board,
        plans: s,
        trackers: s,
        trackerEntries: s,
        foodEntries: s,
        target: s,
        modules: WITH_FOOD,
      });
      expect(panelFacts(panel)).toEqual([]);
      for (const section of [panel.plan, panel.logged, panel.next, panel.trackers, panel.food, panel.target]) {
        expect(section.state).toBe(s.state);
      }
    }
  });
});

describe('a read made for another day is not an answer about today', () => {
  it('yesterday\'s entries and target, still in state, are unread — not today\'s', async () => {
    const water = tracker({ id: 'water', name: 'Water' });
    const board = buildTodayBoard({
      sessions: { state: 'ready', value: [] },
      plans: { state: 'ready', value: [] },
      workouts: { state: 'ready', value: [] },
      modules: WITH_FOOD,
      now: NOW,
    });
    const panel = assembleDay({
      day: TODAY,
      board,
      plans: { state: 'ready', value: [] },
      trackers: { state: 'ready', value: { state: 'ready', trackers: [water] } },
      trackerEntries: {
        state: 'ready',
        value: {
          on: YESTERDAY,
          value: [{ id: 'e1', tracker_id: 'water', logged_on: YESTERDAY, logged_at: 'x', amount: 250 }],
        },
      },
      foodEntries: { state: 'ready', value: { on: YESTERDAY, value: [] } },
      target: { state: 'ready', value: { on: YESTERDAY, value: { state: 'set', target: target() } } },
      modules: WITH_FOOD,
    });
    expect(panel.trackers).toEqual({ state: 'unread' });
    expect(panel.food).toEqual({ state: 'unread' });
    expect(panel.target).toEqual({ state: 'unread' });
  });

  it('current() passes a same-day answer through untouched', () => {
    expect(current({ state: 'ready', value: { on: TODAY, value: 3 } }, TODAY)).toEqual({
      state: 'ready',
      value: 3,
    });
  });
});

describe('a deployment without a food log', () => {
  it('switches food and the target OFF, which is not the same as empty', async () => {
    await cacheTargets(USER, '2026-09-01', '2026-09-01', [target()]);
    await eat(USER, TODAY, 500);
    const panel = await readPanel(WITHOUT_FOOD);
    expect(panel.food).toEqual({ state: 'off' });
    expect(panel.target).toEqual({ state: 'off' });
  });
});

describe('the provenance check can fail', () => {
  // `unbackedFacts` is the guard tranche 2 extends. A check that only ever
  // returns `[]` proves nothing, so it is shown catching each thing it exists for.
  it('reports a fact naming a row that was never written, a withdrawn row, and a fact with no rows', async () => {
    const withdrawn = await planSession(USER, TODAY, 'bjj', null);
    await unplanSession(USER, withdrawn.id);
    const someoneElses = await planSession(OTHER, TODAY, 'bjj', null);

    const fabricated: DayFact[] = [
      { key: 'planned:invented', kind: 'plan-done', planned: 1, refs: [{ table: 'planned_sessions', id: 'invented' }] },
      { key: 'planned:withdrawn', kind: 'plan-done', planned: 1, refs: [{ table: 'planned_sessions', id: withdrawn.id }] },
      { key: 'planned:theirs', kind: 'plan-done', planned: 1, refs: [{ table: 'planned_sessions', id: someoneElses.id }] },
      { key: 'plan-done:empty', kind: 'plan-done', planned: 1, refs: [] },
      { key: 'target:never', kind: 'plan-done', planned: 1, refs: [{ table: 'nutrition_targets', effectiveOn: '2020-01-01' }] },
    ];
    const problems = await unbackedFacts(mockFixture, USER, fabricated);
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/planned:invented/);
    expect(problems.join('\n')).toMatch(/plan-done:empty: no rows/);
  });
});
