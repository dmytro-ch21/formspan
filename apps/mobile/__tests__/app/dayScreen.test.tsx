import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DayScreen from '../../app/day';
import { DayNarrationSlot } from '@/components/day/DayNarrationSlot';
import { dayString } from '@/lib/calendar';
import { NO_NARRATION } from '@/lib/dayNarration';
import { panelFacts } from '@/lib/dayPanel';
import { cacheTargets, logFood } from '@/lib/foodLog';
import type { Module } from '@/lib/modules';
import { planSession } from '@/lib/plan';
import { startLocalSession } from '@/lib/sessionStore';
import { startSessionHref } from '@/lib/startSession';
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

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  mockFixture = await migratedFixture();
  mockUuidSeq = 0;
  mockApi.mockClear();
  mockPush.mockClear();
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

    // The copy states the rows' own numbers, and nothing else.
    expect(screen.getByText('1 of 8 cups')).toBeTruthy();
    expect(screen.getByText('640 kcal · 32 g protein')).toBeTruthy();
    expect(screen.getByText('2,700 kcal a day')).toBeTruthy();

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

    const panel = await readDayPanel(USER, mockModules, new Date());
    const asserted = panelFacts(panel);

    // Something to compare — a comparison of two empty lists passes on a
    // screen that renders nothing.
    expect(asserted.length).toBe(5);
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
