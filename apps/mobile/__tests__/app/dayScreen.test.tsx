import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import DayScreen from '../../app/day';
import { DayNarrationSlot } from '@/components/day/DayNarrationSlot';
import { shiftDate } from '@/lib/anthropometry';
import type { Checkin, Phase } from '@/lib/body';
import { cacheCheckins, cachePhases } from '@/lib/bodyCache';
import { dayString, shortDate } from '@/lib/calendar';
import { NO_NARRATION } from '@/lib/dayNarration';
import { panelFacts } from '@/lib/dayPanel';
import { cacheTargets, logFood } from '@/lib/foodLog';
import type { Module } from '@/lib/modules';
import { planSession } from '@/lib/plan';
import { startLocalSession } from '@/lib/sessionStore';
import { startSessionHref } from '@/lib/startSession';
import { recordStepsOutcome, recordStepsState, setStepsRefresher } from '@/lib/steps';
import type { Tracker } from '@/lib/trackerModel';
import { cacheTrackers, logTap } from '@/lib/trackers';
import { readDayPanel, unbackedFacts } from '@/lib/__tests__/support/dayFacts';
import { migratedFixture, type FixtureDb } from '@/lib/__tests__/support/sqlite';

/**
 * The day panel, rendered — N541 tranche 1 (#972).
 *
 * ## The three properties only a render can decide
 *
 * `lib/__tests__/dayPanel.test.ts` covers the assembly. This file covers what
 * reaches the screen, over the same real SQLite, with the network failing:
 *
 * 1. **Offline, the day renders in full** — the plan, the targets and the goal,
 *    from rows, with `fetch` and `apiRequest` never called.
 * 2. **What is on screen is exactly what the assembly asserts, and every piece
 *    of it is a live row.** The set of `day-fact-*` elements is compared to
 *    `panelFacts` of a panel read independently from the same database, and
 *    that panel's refs are checked against SQLite. A line drawn by the screen
 *    with nothing behind it — the shape a narration layer would add — fails the
 *    first comparison. This is the invariant tranche 2's fabricated-fact guard
 *    extends.
 * 3. **An absence appears only when its read answered.** A table that cannot be
 *    read says it could not look; it does not say "nothing logged".
 *
 * The database, the session store, the plan, trackers and food are all real.
 * What is mocked is identity (Clerk, modules), navigation, and the sync
 * orchestrator — the last so this file asserts the panel's reads rather than
 * whatever a sync run would have written.
 */

jest.setTimeout(30_000);

let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../../lib/db', () => {
  const real = jest.requireActual('../../lib/db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuidSeq}` }));

const mockApi = jest.fn((..._a: unknown[]) => Promise.reject(new TypeError('Network request failed')));
jest.mock('@/lib/apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(),
  useSyncState: () => ({
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: null,
    lastError: 'offline',
    online: false,
  }),
}));

const mockPush = jest.fn();
// A STABLE router — the shared mock mints a fresh `push` per render, which
// would make the press assertion below unobservable.
const mockRouter = { push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

// Units already read from the phone's cache — the offline case, and the one the
// Body block's numbers wait for. One test turns it off.
let mockUnitsReady = true;
jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({
    units: 'metric',
    unitsReady: mockUnitsReady,
    unsynced: false,
    foodUnit: 'g',
    setUnits: jest.fn(),
    setFoodUnit: jest.fn(),
  }),
}));

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

const mockModules: Module[] = [
  mod('strength', { catalog: 'exercises' } as Module['capabilities']),
  mod('bjj', { catalog: 'techniques' } as Module['capabilities']),
  mod('nutrition', { has_food_log: true }, false),
];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true, stale: false, apply: jest.fn() }),
}));

const USER = 'u1';

const water: Tracker = {
  id: 'water',
  preset: 'water',
  name: 'Water',
  icon: 'drop',
  color_key: 'blue',
  unit: 'ml',
  increment: 250,
  target: 2000,
  render_style: 'auto',
  sort_order: 0,
  count_noun: 'cup',
  provisioned: true,
  cutoff_minutes: null,
};

/**
 * Anchored to TODAY's calendar day at local noon, never "N minutes before now"
 * — a fixture relative to the real clock crosses midnight for a suite run in
 * the first minutes of a day. `todayScreen.test.tsx` records the incident.
 */
function today(): string {
  return dayString(new Date());
}
const noonToday = (offsetMin = 0) =>
  new Date(new Date(`${today()}T12:00:00`).getTime() + offsetMin * 60_000).toISOString();

function checkinRow(user: string, on: string, kg: number | null): Checkin {
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
    notes: '',
  };
}

function phaseRow(user: string, id: string): Phase {
  return {
    id,
    user_id: user,
    kind: 'cut',
    started_on: '2026-08-01',
    target_on: '2026-11-01',
    target_weight_kg: 78,
    ended_on: null,
    notes: '',
  };
}

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockApi.mockClear();
  mockPush.mockClear();
  mockUnitsReady = true;
  fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function seedDay() {
  await cacheTrackers(USER, [
    { ...water, user_id: USER, archived_at: null, created_at: 'x', updated_at: 'x' },
  ]);
  await cacheTargets(USER, today(), today(), [
    { effective_on: today(), kcal: 2700, protein_g: 180, carb_g: 300, fat_g: 80, fibre_g: null },
  ]);
  const plan = await planSession(USER, today(), 'strength', null, '', 18 * 60);
  const bjj = await startLocalSession(USER, {
    sport: 'bjj',
    name: 'Morning class',
    started_at: noonToday(-180),
    ended_at: noonToday(-120),
  });
  await logTap(USER, water, today());
  await logFood(USER, {
    eaten_on: today(),
    meal: 'lunch',
    name: 'Rice',
    servings: 1,
    serving_label: '1 bowl',
    kcal: 640,
    protein_g: 32,
    carb_g: 90,
    fat_g: 12,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  });
  // N568: what Today's refresh left in the body cache this morning.
  const fetched = new Date(`${today()}T08:00:00`).toISOString();
  await cacheCheckins(USER, shiftDate(today(), -30), today(), [checkinRow(USER, today(), 82.4)], fetched);
  await cachePhases(USER, [phaseRow(USER, 'cut-1')], fetched);
  // N569: what this morning's Health read left in the steps store.
  await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 8412 }, new Date(`${today()}T09:30:00`));
  return { plan, bjj };
}

function renderedFactKeys(): string[] {
  return screen
    .queryAllByTestId(/^day-fact-/)
    .map((el) => String(el.props.testID).slice('day-fact-'.length))
    .sort();
}

describe('offline, the whole day renders from rows', () => {
  it('draws the plan, what was logged, the tracker, the food and the goal with no network', async () => {
    const { plan, bjj } = await seedDay();

    await render(<DayScreen />);

    await waitFor(() => expect(screen.getByTestId('day-fact-tracker:water')).toBeTruthy());
    expect(screen.getByTestId(`day-fact-planned:${plan.id}`)).toBeTruthy();
    expect(screen.getByTestId(`day-fact-logged:${bjj.id}`)).toBeTruthy();
    expect(screen.getByTestId(`day-fact-food-eaten:${today()}`)).toBeTruthy();
    expect(screen.getByTestId(`day-fact-nutrition-target:${today()}`)).toBeTruthy();
    expect(await screen.findByTestId(`day-fact-last-checkin:${today()}`)).toBeTruthy();
    expect(screen.getByTestId('day-fact-phase-goal:cut-1')).toBeTruthy();
    expect(await screen.findByTestId(`day-fact-steps:${today()}`)).toBeTruthy();

    // The copy states the rows' own numbers, and nothing else.
    expect(screen.getByText('1 of 8 cups')).toBeTruthy();
    expect(screen.getByText('640 kcal · 32 g protein')).toBeTruthy();
    expect(screen.getByText('2,700 kcal a day')).toBeTruthy();
    expect(screen.getByText('82.4kg')).toBeTruthy();
    expect(screen.getByText('Target 78kg by 1 Nov')).toBeTruthy();
    expect(screen.getByText('8,412 steps')).toBeTruthy();

    // No absence is drawn beside the facts that contradict it.
    expect(screen.queryByTestId('day-absent-plan')).toBeNull();
    expect(screen.queryByTestId('day-absent-food')).toBeNull();

    expect(mockApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders exactly the facts the assembly asserts — and each one is a live row', async () => {
    await seedDay();
    await render(<DayScreen />);
    await waitFor(() => expect(screen.getByTestId('day-fact-tracker:water')).toBeTruthy());
    await screen.findByTestId('day-fact-phase-goal:cut-1');
    await screen.findByTestId(`day-fact-last-checkin:${today()}`);
    await screen.findByTestId(`day-fact-steps:${today()}`);

    const panel = await readDayPanel(USER, mockModules, new Date());
    const asserted = panelFacts(panel);

    // Something to compare — a comparison of two empty lists passes on a
    // screen that renders nothing. Five from tranche 1, two cached (N568), and
    // today's steps (N569).
    expect(asserted.length).toBe(8);
    expect(renderedFactKeys()).toEqual(asserted.map((f) => f.key).sort());
    expect(await unbackedFacts(mockFixture, USER, asserted)).toEqual([]);
  });
});

describe('absences only from reads that answered', () => {
  it('a fresh device: says nothing is planned or logged, and that trackers and the target are not here yet', async () => {
    await render(<DayScreen />);

    await waitFor(() => expect(screen.getByTestId('day-absent-plan')).toBeTruthy());
    expect(screen.getByTestId('day-absent-food')).toBeTruthy();
    // Never told about trackers or a target: not "none", but not known.
    expect(screen.getByTestId('day-unavailable-trackers')).toBeTruthy();
    expect(screen.getByTestId('day-unavailable-target')).toBeTruthy();
    expect(screen.queryByTestId('day-absent-target')).toBeNull();
    // N568: never fetched check-ins or phases on this phone — the same rule.
    expect(await screen.findByTestId('day-unavailable-checkin')).toBeTruthy();
    expect(await screen.findByTestId('day-unavailable-phase')).toBeTruthy();
    expect(screen.queryByTestId('day-absent-checkin')).toBeNull();
    expect(screen.queryByTestId('day-absent-phase')).toBeNull();
    expect(renderedFactKeys()).toEqual([]);
  });

  it('a table that cannot be read says so, and the rest of the day still renders', async () => {
    const { plan } = await seedDay();
    mockFixture.raw.exec('DROP TABLE food_entries');

    await render(<DayScreen />);

    await waitFor(() => expect(screen.getByTestId('day-unavailable-food')).toBeTruthy());
    // Not "No food logged yet today" — nobody looked.
    expect(screen.queryByTestId('day-absent-food')).toBeNull();
    // One unreadable table does not take the others with it.
    expect(screen.getByTestId(`day-fact-planned:${plan.id}`)).toBeTruthy();
    expect(screen.getByTestId('day-fact-tracker:water')).toBeTruthy();
  });
});

describe('last-known body values, offline (N568, #1129)', () => {
  it('a value fetched days ago says when, on the value itself — and nothing in it reads as live', async () => {
    const measured = shiftDate(today(), -4);
    const fetchedDay = shiftDate(today(), -3);
    const fetched = new Date(`${fetchedDay}T16:00:00`);
    await cacheCheckins(USER, shiftDate(fetchedDay, -30), fetchedDay, [checkinRow(USER, measured, 82.4)], fetched.toISOString());
    await cachePhases(USER, [phaseRow(USER, 'cut-1')], fetched.toISOString());

    await render(<DayScreen />);

    const checkin = await screen.findByTestId(`day-fact-last-checkin:${measured}`);
    const phase = await screen.findByTestId('day-fact-phase-goal:cut-1');
    const year = fetched.getFullYear() === new Date().getFullYear() ? '' : ` ${fetched.getFullYear()}`;
    const label = `Last updated ${shortDate(fetchedDay)}${year}, 16:00`;

    // The label sits inside the row it qualifies, not somewhere nearby.
    expect(within(checkin).getByText('82.4kg')).toBeTruthy();
    expect(within(checkin).getByTestId('day-updated-checkin').props.children).toBe(label);
    expect(within(phase).getByTestId('day-updated-phase').props.children).toBe(label);
    // A screen reader hears the same disclosure: a tappable row's label replaces
    // its children, so the label itself must carry the fetched time.
    expect(checkin.props.accessibilityLabel).toContain(label);
    expect(checkin.props.accessibilityLabel).toContain('82.4kg');
    expect(phase.props.accessibilityLabel).toContain(label);

    // Not worded as today's: no clock-only label, nothing claiming to be current.
    expect(screen.queryByText('Last updated 16:00')).toBeNull();
    for (const row of [checkin, phase]) {
      expect(within(row).queryByText(/\b(today|now|current|live)\b/i)).toBeNull();
    }
    expect(mockApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetched and genuinely empty: the real empty state with its fetched time — not "not available"', async () => {
    const fetchedDay = shiftDate(today(), -1);
    const fetched = new Date(`${fetchedDay}T07:30:00`).toISOString();
    await cacheCheckins(USER, shiftDate(fetchedDay, -30), fetchedDay, [], fetched);
    await cachePhases(USER, [], fetched);

    await render(<DayScreen />);

    const checkin = await screen.findByTestId('day-absent-checkin');
    expect(within(checkin).getByText(`No check-in since ${shortDate(shiftDate(fetchedDay, -30))}.`)).toBeTruthy();
    expect(within(checkin).getByTestId('day-updated-checkin')).toBeTruthy();
    const phase = screen.getByTestId('day-absent-phase');
    expect(within(phase).getByText('No active phase.')).toBeTruthy();
    expect(within(phase).getByTestId('day-updated-phase')).toBeTruthy();
    expect(screen.queryByTestId('day-unavailable-checkin')).toBeNull();
    expect(screen.queryByTestId('day-unavailable-phase')).toBeNull();
  });

  it('states no weight until the unit preference is read — never kilograms for a frame to a pounds athlete', async () => {
    mockUnitsReady = false;
    await seedDay();

    await render(<DayScreen />);

    const checkin = await screen.findByTestId(`day-fact-last-checkin:${today()}`);
    expect(within(checkin).getByText('Weight recorded')).toBeTruthy();
    expect(screen.queryByText('82.4kg')).toBeNull();
    expect(within(screen.getByTestId('day-fact-phase-goal:cut-1')).getByText('Target set by 1 Nov')).toBeTruthy();
  });

  it("another account's cached check-in and phase goal never render for the signed-in athlete", async () => {
    const fetched = new Date(`${today()}T08:00:00`).toISOString();
    await cacheCheckins('u2', shiftDate(today(), -30), today(), [checkinRow('u2', today(), 61.3)], fetched);
    await cachePhases('u2', [phaseRow('u2', 'theirs')], fetched);

    await render(<DayScreen />);

    expect(await screen.findByTestId('day-unavailable-checkin')).toBeTruthy();
    expect(await screen.findByTestId('day-unavailable-phase')).toBeTruthy();
    expect(screen.queryByText('61.3kg')).toBeNull();
    expect(screen.queryByTestId(`day-fact-last-checkin:${today()}`)).toBeNull();
    expect(screen.queryByTestId('day-fact-phase-goal:theirs')).toBeNull();
  });
});

describe('rows open the screen that owns them', () => {
  it('a planned session starts where Today starts it', async () => {
    const { plan } = await seedDay();
    await render(<DayScreen />);
    await waitFor(() => expect(screen.getByTestId(`day-fact-planned:${plan.id}`)).toBeTruthy());

    // Awaited: unawaited, the press's `act` was still open when the test ended
    // and overlapped the suite's `afterEach` flush (F47, #1057).
    await fireEvent.press(screen.getByTestId(`day-fact-planned:${plan.id}`));
    expect(mockPush).toHaveBeenCalledWith(startSessionHref(plan, mockModules));
  });
});

describe('the narration seam', () => {
  it('renders nothing while there is no narration', async () => {
    await render(<DayNarrationSlot narration={NO_NARRATION} />);
    expect(screen.toJSON()).toBeNull();
  });
});

describe("today's steps, from the phone's own store (N569, #1130)", () => {
  it('a count renders offline, saying when it was read and where from', async () => {
    await recordStepsOutcome(USER, 'health_connect', { kind: 'steps', steps: 8412 }, new Date(`${today()}T09:30:00`));

    await render(<DayScreen />);

    const row = await screen.findByTestId(`day-fact-steps:${today()}`);
    expect(within(row).getByText('8,412 steps')).toBeTruthy();
    expect(within(row).getByText('As of 09:30, from Health Connect')).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a genuine zero-step day says 0 steps', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 0 }, new Date(`${today()}T09:30:00`));

    await render(<DayScreen />);

    const row = await screen.findByTestId(`day-fact-steps:${today()}`);
    expect(within(row).getByText('0 steps')).toBeTruthy();
  });

  it('a refusal says so — never a number, never "no steps"', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'refused' }, new Date());

    await render(<DayScreen />);

    expect(await screen.findByTestId('day-steps-refused')).toBeTruthy();
    expect(screen.getByText("Apple Health isn't sharing steps with VOLA.")).toBeTruthy();
    expect(screen.queryByText(/\d[\d,]* steps?$/)).toBeNull();
    expect(screen.queryByTestId(`day-fact-steps:${today()}`)).toBeNull();
    expect(screen.queryByTestId('day-absent-steps')).toBeNull();
  });

  it('a phone with no step source says that, and nothing else', async () => {
    await recordStepsState(USER, 'no_source', null, new Date());

    await render(<DayScreen />);

    expect(await screen.findByTestId('day-steps-no-source')).toBeTruthy();
    expect(screen.queryByText(/\d[\d,]* steps?$/)).toBeNull();
  });

  it('never read on this phone: "not available yet" — not zero', async () => {
    await render(<DayScreen />);

    expect(await screen.findByTestId('day-unavailable-steps')).toBeTruthy();
    expect(screen.queryByText(/\d[\d,]* steps?$/)).toBeNull();
  });

  it('not connected yet: offers the way in, and it opens Settings', async () => {
    await recordStepsState(USER, 'not_asked', 'healthkit', new Date());

    await render(<DayScreen />);

    const row = await screen.findByTestId('day-steps-not-connected');
    await fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it("another account's steps never render for the signed-in athlete", async () => {
    await recordStepsOutcome('u2', 'healthkit', { kind: 'steps', steps: 7777 }, new Date(`${today()}T09:30:00`));

    await render(<DayScreen />);

    expect(await screen.findByTestId('day-unavailable-steps')).toBeTruthy();
    expect(screen.queryByText('7,777 steps')).toBeNull();
  });

  it('a read that lands while VOLA is open shows up without leaving the screen', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 1200 }, new Date(`${today()}T09:30:00`));

    await render(<DayScreen />);
    expect(await screen.findByText('1,200 steps')).toBeTruthy();

    // A foreground pass writes a newer count while the screen stays mounted.
    await act(async () => {
      await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 4800 }, new Date(`${today()}T11:00:00`));
    });

    expect(await screen.findByText('4,800 steps')).toBeTruthy();
    expect(screen.queryByText('1,200 steps')).toBeNull();
  });

  it('opening VOLA asks for a fresh steps read — so it stays current without passing through Today', async () => {
    const refresh = jest.fn();
    setStepsRefresher(refresh);
    try {
      await render(<DayScreen />);
      expect(await screen.findByTestId('day-unavailable-steps')).toBeTruthy();
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      setStepsRefresher(null);
    }
  });
});
