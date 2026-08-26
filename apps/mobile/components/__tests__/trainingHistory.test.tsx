import { render, screen, waitFor } from '@testing-library/react-native';

import { TrainingHistory } from '../progress/TrainingHistory';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';

/**
 * The calendar Today handed to Progress (N179), and its three reading states.
 *
 * The block itself is `TrainingCalendar`, which has its own tests. What is new
 * here is the loading discipline wrapped around it — and it is worth its own
 * file for a specific reason: **`TrainingCalendar` draws a confident week.**
 * Handed `[]` for both reads it renders seven days with no sessions and no
 * plans, which is a claim about the athlete made from a query that has not run.
 * That is the defect this whole ticket exists to remove from Today, and moving
 * a component is exactly the moment to carry it along.
 *
 * Each of the three states below has a vector that constructs it. #583 shipped
 * a `ReadingState` whose `empty` prop no code path could reach, propping up an
 * assertion that had been vacuously green forever; a union is not coverage.
 */

const mockListLocalSessions = jest.fn(
  (..._a: unknown[]): Promise<Session[]> => Promise.resolve([]),
);
// One mock covers both callers: this component reads the week, and
// `TrainingCalendar` calls the same function again with a wider range when its
// month sheet is opened — which is never opened here.
jest.mock('@/lib/sessionStore', () => ({
  listLocalSessions: (...a: unknown[]) => mockListLocalSessions(...a),
}));

const mockListPlannedBetween = jest.fn(
  (..._a: unknown[]): Promise<PlannedSession[]> => Promise.resolve([]),
);
jest.mock('@/lib/plan', () => ({
  listPlannedBetween: (...a: unknown[]) => mockListPlannedBetween(...a),
}));

jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

const mockModules = [
  {
    key: 'strength',
    label: 'Strength',
    is_sport: true,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: 'exercises',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
    },
  },
];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true }),
}));

beforeEach(() => {
  mockListLocalSessions.mockReset();
  mockListLocalSessions.mockResolvedValue([]);
  mockListPlannedBetween.mockReset();
  mockListPlannedBetween.mockResolvedValue([]);
});

/** A read that is still in flight when the assertion runs. */
const pending = <T,>() => new Promise<T>(() => {});

it('draws nothing at all while the session read is in flight', async () => {
  mockListLocalSessions.mockReturnValue(pending<Session[]>());
  render(<TrainingHistory />);

  await waitFor(() => expect(mockListPlannedBetween).toHaveBeenCalled());
  expect(screen.queryByTestId('progress-training-calendar')).toBeNull();
  expect(screen.queryByTestId('training-calendar')).toBeNull();
  expect(screen.queryByTestId('progress-calendar-unavailable')).toBeNull();
});

it('draws nothing at all while the PLAN read is in flight', async () => {
  // The calendar draws logged days against planned ones, so half an answer
  // renders a week with its plans silently missing — an athlete who planned
  // nothing.
  mockListPlannedBetween.mockReturnValue(pending<PlannedSession[]>());
  render(<TrainingHistory />);

  await waitFor(() => expect(mockListLocalSessions).toHaveBeenCalled());
  expect(screen.queryByTestId('training-calendar')).toBeNull();
  expect(screen.queryByTestId('progress-calendar-unavailable')).toBeNull();
});

it('says the read failed rather than drawing an empty calendar', async () => {
  mockListLocalSessions.mockRejectedValue(new Error('disk'));
  render(<TrainingHistory />);

  expect(await screen.findByTestId('progress-calendar-unavailable')).toBeTruthy();
  expect(screen.queryByTestId('training-calendar')).toBeNull();
});

it('says the same when the plan read is what failed', async () => {
  mockListPlannedBetween.mockRejectedValue(new Error('disk'));
  render(<TrainingHistory />);

  expect(await screen.findByTestId('progress-calendar-unavailable')).toBeTruthy();
});

it('draws the calendar once both reads answer, including an empty one', async () => {
  // The mirror of the four above — without it they could all pass by the
  // component simply never rendering a calendar at all.
  render(<TrainingHistory />);

  expect(await screen.findByTestId('progress-training-calendar')).toBeTruthy();
  expect(screen.getByTestId('training-calendar')).toBeTruthy();
});
