import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import MyCurriculaScreen from '../curriculum/index';
import type { Curriculum } from '@/lib/curriculum';

/**
 * "My curricula" (N83) — the findability gap the audit named: an athlete's
 * own curricula were reachable on the phone only by already knowing an id.
 * What is pinned here is the ONE filter this screen exists to apply
 * (`editable`, not `enrolled` and not `official`) and that a row goes to the
 * roadmap viewer rather than straight to Edit — see the screen's own doc
 * comment for why.
 */
jest.setTimeout(30_000);

const mockUseEffect = useEffect;
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

const mockListCurricula = jest.fn();
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: (...a: unknown[]) => mockListCurricula(...a),
}));

function curriculum(over: Partial<Curriculum> = {}): Curriculum {
  return {
    id: 'c1',
    editable: true,
    name: 'Guard passing for winter',
    description: '',
    belt: null,
    track: null,
    visibility: 'private',
    enrolled: false,
    started_on: null,
    item_count: 3,
    countable_items: 0,
    mastered_items: 0,
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockReset();
  mockListCurricula.mockReset();
});

it('shows only what is editable — never a belt syllabus, never a stranger\'s public curriculum', async () => {
  mockListCurricula.mockResolvedValue([
    curriculum({ id: 'mine', name: 'Mine', editable: true }),
    curriculum({ id: 'belt', name: 'White belt', editable: false, official: true, track: 'belt' }),
    curriculum({ id: 'theirs', name: "Someone else's", editable: false }),
  ]);
  render(<MyCurriculaScreen />);
  await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy());
  expect(screen.queryByText('White belt')).toBeNull();
  expect(screen.queryByText("Someone else's")).toBeNull();
});

it('shows the empty state when there is nothing yet, not a spinner forever', async () => {
  mockListCurricula.mockResolvedValue([]);
  render(<MyCurriculaScreen />);
  await waitFor(() => expect(screen.getByTestId('my-curricula-empty')).toBeTruthy());
});

it('a "reading list" reads as one, a roadmap says what is left to master', async () => {
  mockListCurricula.mockResolvedValue([
    curriculum({ id: 'reading', name: 'Reading list', countable_items: 0, item_count: 5 }),
    curriculum({ id: 'roadmap', name: 'Roadmap', countable_items: 2, item_count: 5 }),
  ]);
  render(<MyCurriculaScreen />);
  await waitFor(() => expect(screen.getByText(/a reading list/)).toBeTruthy());
  expect(screen.getByText(/2 to master/)).toBeTruthy();
});

it('New curriculum opens the create screen', async () => {
  mockListCurricula.mockResolvedValue([]);
  render(<MyCurriculaScreen />);
  await waitFor(() => expect(screen.getByTestId('my-curricula-new')).toBeTruthy());
  fireEvent.press(screen.getByTestId('my-curricula-new'));
  expect(mockPush).toHaveBeenCalledWith('/curriculum/new');
});

it('a row opens the roadmap viewer, not the edit screen directly', async () => {
  mockListCurricula.mockResolvedValue([curriculum({ id: 'c1', name: 'Guard passing for winter' })]);
  render(<MyCurriculaScreen />);
  fireEvent.press(await screen.findByTestId('my-curricula-c1'));
  expect(mockPush).toHaveBeenCalledWith('/curriculum/c1');
});

it('shows the load error rather than a silently empty list', async () => {
  mockListCurricula.mockRejectedValue(new Error('offline'));
  render(<MyCurriculaScreen />);
  await waitFor(() => expect(screen.getByTestId('my-curricula-error')).toBeTruthy());
});
