import { render, screen, waitFor } from '@testing-library/react-native';

import WorkoutsScreen from '../../app/(tabs)/workouts';
import type { PlannedSession } from '@/lib/plan';

/**
 * Plan owns the forward schedule — the PRESENCE half of N182's pair.
 *
 * The absence half is `app/__tests__/trainScreen.test.tsx`. Neither is worth
 * anything alone: a test that Plan renders the schedule is satisfied by a copy
 * that also left one on Train, which is the W2/W4 failure this repo has shipped
 * twice.
 *
 * ## What is actually under test, which is narrower than "Later moved"
 *
 * `WeekPlanner` already draws every planned day inside the week it is showing,
 * and it has done since long before #587 — the ticket's premise that Plan
 * "holds no dates" is wrong about `main`. So the block added here deliberately
 * does NOT draw a day the planner above it is already drawing; what it fills is
 * the one gap the week cannot: a plan OUTSIDE it. Both halves of that
 * conditional are asserted below, because a block that always renders and a
 * block that never renders both pass a one-sided test.
 *
 * ## The clock is pinned, for the reason `weekPlanner.test.tsx` records
 *
 * "This week" and "beyond this week" are the whole subject. Read from the real
 * clock, every assertion here would silently change meaning once a week — and
 * `weekPlanner.test.tsx` shipped exactly that bug, going red on main with no
 * code change and taking one assertion vacuous on the way.
 */

jest.setTimeout(30_000);

beforeAll(() => {
  jest.useFakeTimers({
    // Everything except `Date` stays real: `waitFor` polls on `setTimeout`, and
    // faking it deadlocks every assertion in this file.
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    // Monday 2026-08-03, noon in the suite's TZ=America/Los_Angeles. A Monday
    // so the shown week is exactly 03–09 with no argument about anchoring, and
    // noon so no UTC offset can land it on another day.
    now: new Date('2026-08-03T12:00:00'),
  });
});

afterAll(() => {
  jest.useRealTimers();
});

/** Inside the week `WeekPlanner` is showing — Thursday of 03–09. */
const INSIDE_THIS_WEEK = '2026-08-06';
/** Outside it, and inside `PLAN_WINDOW_DAYS` (03 + 14 = 17). */
const BEYOND_THIS_WEEK = '2026-08-12';

const mockListPlannedBetween = jest.fn(
  (..._a: unknown[]): Promise<PlannedSession[]> => Promise.resolve([]),
);
jest.mock('@/lib/plan', () => ({
  listPlannedBetween: (...a: unknown[]) => mockListPlannedBetween(...a),
  planSession: jest.fn(async () => {}),
  unplanSession: jest.fn(async () => {}),
}));

const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockListLocalSessions = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  cacheWorkouts: jest.fn(async () => {}),
  createLocalWorkout: jest.fn(),
  listLocalSessions: (...a: unknown[]) => mockListLocalSessions(...a),
}));

const mockListWorkouts = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  listWorkouts: (...a: unknown[]) => mockListWorkouts(...a),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: null,
    lastError: null,
    online: true,
  }),
}));

jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({
    modules: [
      {
        key: 'bjj',
        label: 'BJJ',
        is_sport: true,
        enabled: true,
        capabilities: { catalog: 'techniques', facets: [], record_kinds: [] },
      },
      {
        key: 'strength',
        label: 'Strength',
        is_sport: true,
        enabled: true,
        capabilities: { catalog: 'exercises', facets: [], record_kinds: [] },
      },
    ],
    known: true,
    ready: true,
  }),
}));

function planned(day: string): PlannedSession {
  return { id: `p-${day}`, day, sport: 'bjj', workoutId: null, notes: '' } as PlannedSession;
}

beforeEach(() => {
  mockListPlannedBetween.mockReset();
  mockListPlannedBetween.mockResolvedValue([]);
  mockCachedWorkouts.mockReset();
  mockCachedWorkouts.mockResolvedValue([]);
  mockListLocalSessions.mockReset();
  mockListLocalSessions.mockResolvedValue([]);
  mockListWorkouts.mockReset();
  mockListWorkouts.mockResolvedValue([]);
});

it('names a planned day the week on screen cannot reach', async () => {
  mockListPlannedBetween.mockResolvedValue([planned(BEYOND_THIS_WEEK)]);

  render(<WorkoutsScreen />);

  const row = await screen.findByTestId('plan-later');
  expect(row.props.accessibilityLabel).toBe('Next planned: BJJ session, 12 Aug');
});

it('leaves a day inside the visible week to the planner that already draws it', async () => {
  mockListPlannedBetween.mockResolvedValue([planned(INSIDE_THIS_WEEK)]);

  render(<WorkoutsScreen />);

  // Sequenced on a POSITIVE artifact of the same resolved read, not on the
  // Templates heading. That heading renders on first paint whatever the reads
  // do, so waiting for it proved only that the screen mounted — the absence
  // below would then have been resting on microtask ordering. `WeekPlanner`
  // drawing the planned day is proof that this exact `listPlannedBetween`
  // answer has landed and been rendered, which is what makes the absence a
  // decision. Raised in review.
  expect(await screen.findByText('BJJ session')).toBeTruthy();
  expect(screen.queryByTestId('plan-later')).toBeNull();
});

it('draws nothing at all when nothing is planned ahead', async () => {
  render(<WorkoutsScreen />);

  expect(await screen.findByText('TEMPLATES')).toBeTruthy();
  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  expect(screen.queryByTestId('plan-later')).toBeNull();
  expect(screen.queryByTestId('plan-later-unavailable')).toBeNull();
  // "Nothing planned for the next fortnight" is a true sentence and a scolding
  // one, and the seven rows above are where an athlete acts on it.
  expect(screen.queryByText('BEYOND THIS WEEK')).toBeNull();
});

it('says nothing while the plan read is still in flight', async () => {
  // `unread` is not `empty`. The block that renders an empty state before its
  // read answers is the collapse `lib/trainBoard.ts` exists to prevent, and it
  // lasts exactly long enough to be read and never long enough to be reported.
  mockListPlannedBetween.mockReturnValue(new Promise<PlannedSession[]>(() => {}));

  render(<WorkoutsScreen />);

  expect(await screen.findByText('TEMPLATES')).toBeTruthy();
  expect(screen.queryByTestId('plan-later')).toBeNull();
  expect(screen.queryByTestId('plan-later-unavailable')).toBeNull();
});

it('says the plan could not be read, because the week above will not', async () => {
  // `WeekPlanner` renders an unreadable plan as an empty week on purpose — "an
  // unreadable plan is an empty week here, not an error banner" — so this is
  // the only thing on the screen that can tell the athlete their seven blank
  // rows are not a fact about them.
  mockListPlannedBetween.mockRejectedValue(new Error('disk'));

  render(<WorkoutsScreen />);

  expect(await screen.findByTestId('plan-later-unavailable')).toBeTruthy();
  expect(screen.queryByTestId('plan-later')).toBeNull();
});

it('does not offer to start a day that has not arrived', async () => {
  // No button, and no `button` role either. Starting next Wednesday's session
  // today is how a plan stops meaning anything; New log is one tab away for an
  // athlete who means it.
  mockListPlannedBetween.mockResolvedValue([planned(BEYOND_THIS_WEEK)]);

  render(<WorkoutsScreen />);

  const row = await screen.findByTestId('plan-later');
  expect(row.props.accessibilityRole).toBe('text');
  expect(row.props.onStartShouldSetResponder).toBeUndefined();
});
