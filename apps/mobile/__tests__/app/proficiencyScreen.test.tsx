/**
 * N84 — the technique funnel as a browsable phone screen.
 *
 * Pins: the funnel headline renders from the summary the endpoint sends, the
 * bucket filter actually filters (and its counts sum to "Everything"), and
 * starring a technique from the list writes through `setFocus` the same way
 * the Records screen's own star does — optimistic, with a rollback on
 * failure.
 */
import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import ProficiencyScreen from '../../app/bjj/proficiency';

const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
  Stack: { Screen: () => null },
}));

const mockFetchProficiencyFull = jest.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ techniques: [], summary: { techniques: 0, drilled: 0, tried_live: 0, landed: 0 } }),
);
jest.mock('@/lib/proficiency', () => ({
  ...jest.requireActual('@/lib/proficiency'),
  fetchProficiencyFull: (...a: unknown[]) => mockFetchProficiencyFull(...a),
}));

const mockFetchFocus = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockSetFocus = jest.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
jest.mock('@/lib/bjjFocus', () => ({
  ...jest.requireActual('@/lib/bjjFocus'),
  fetchFocus: (...a: unknown[]) => mockFetchFocus(...a),
  setFocus: (...a: unknown[]) => mockSetFocus(...a),
}));

const row = (over: Record<string, unknown> = {}) => ({
  technique_id: 'armbar-closed-guard',
  name: 'Armbar from closed guard',
  position: 'Guard - Bottom',
  category: 'Submission',
  drilled: 4,
  attempted: 2,
  scored: 1,
  conceded: 0,
  defended: 0,
  sessions: 3,
  last_seen: '2026-08-01',
  ...over,
});

beforeEach(() => {
  mockFetchProficiencyFull.mockReset().mockResolvedValue({
    techniques: [],
    summary: { techniques: 0, drilled: 0, tried_live: 0, landed: 0 },
  });
  mockFetchFocus.mockReset().mockResolvedValue([]);
  mockSetFocus.mockReset().mockResolvedValue(undefined);
});

it('renders the funnel headline from the summary the endpoint sends', async () => {
  mockFetchProficiencyFull.mockResolvedValue({
    techniques: [row()],
    summary: { techniques: 1, drilled: 10, tried_live: 4, landed: 2 },
  });
  render(<ProficiencyScreen />);
  const funnel = await screen.findByTestId('proficiency-funnel');
  expect(funnel).toBeTruthy();
  expect(screen.getByText('10')).toBeTruthy();
  expect(screen.getByText('4')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
});

it('shows the load-failure message rather than an empty funnel', async () => {
  mockFetchProficiencyFull.mockRejectedValue(new Error('offline'));
  render(<ProficiencyScreen />);
  expect(await screen.findByTestId('proficiency-unavailable')).toBeTruthy();
});

it('filtering to "Never tried live" hides a technique that has been tried', async () => {
  mockFetchProficiencyFull.mockResolvedValue({
    techniques: [
      row({ technique_id: 'untried-one', name: 'Untried move', drilled: 3, attempted: 0, scored: 0 }),
      row({ technique_id: 'tried-one', name: 'Tried move', drilled: 3, attempted: 1, scored: 1 }),
    ],
    summary: { techniques: 2, drilled: 6, tried_live: 1, landed: 1 },
  });
  render(<ProficiencyScreen />);
  await screen.findByTestId('proficiency-row-untried-one');
  expect(screen.getByTestId('proficiency-row-tried-one')).toBeTruthy();

  fireEvent.press(screen.getByTestId('proficiency-bucket-untried'));

  expect(screen.getByTestId('proficiency-row-untried-one')).toBeTruthy();
  expect(screen.queryByTestId('proficiency-row-tried-one')).toBeNull();
});

it('bucket counts sum to "Everything", each technique landing in exactly one', async () => {
  mockFetchProficiencyFull.mockResolvedValue({
    techniques: [
      row({ technique_id: 'a', drilled: 3, attempted: 0, scored: 0 }), // untried
      row({ technique_id: 'b', drilled: 0, attempted: 1, scored: 1 }), // working
      row({ technique_id: 'c', drilled: 0, attempted: 2, scored: 0 }), // stalled
      row({ technique_id: 'd', drilled: 0, attempted: 0, scored: 0, conceded: 1 }), // against
    ],
    summary: { techniques: 4, drilled: 3, tried_live: 3, landed: 1 },
  });
  render(<ProficiencyScreen />);
  await screen.findByTestId('proficiency-bucket-all');

  // Each chip's own visible text carries its count — reading it back this way
  // (rather than re-deriving the sum in the test) is what makes this catch a
  // technique landing in the wrong bucket OR in two at once.
  expect(screen.getByText('Everything 4')).toBeTruthy();
  expect(screen.getByText('Never tried live 1')).toBeTruthy();
  expect(screen.getByText('Landing 1')).toBeTruthy();
  expect(screen.getByText('Not landing yet 1')).toBeTruthy();
  expect(screen.getByText('Used on you 1')).toBeTruthy();
});

it('starring a technique writes through setFocus, and rolls back on failure', async () => {
  mockFetchProficiencyFull.mockResolvedValue({
    techniques: [row()],
    summary: { techniques: 1, drilled: 4, tried_live: 3, landed: 1 },
  });
  mockSetFocus.mockRejectedValue(new Error('offline'));
  render(<ProficiencyScreen />);
  const star = await screen.findByTestId('proficiency-star-armbar-closed-guard');

  fireEvent.press(star);
  await waitFor(() => expect(mockSetFocus).toHaveBeenCalledWith(expect.anything(), ['armbar-closed-guard']));

  await waitFor(() => expect(screen.getByTestId('proficiency-notice')).toBeTruthy());
});
