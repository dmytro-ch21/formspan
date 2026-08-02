import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import PositionScreen from '../position/[id]';
import type { Position } from '@/lib/positions';
import type { TechniqueSummary } from '@/lib/techniques';

/**
 * The glossary screen, tested where its bugs actually live: the render path.
 *
 * Everything this screen can get wrong is invisible to the backend tests. The
 * repository can return a perfectly good position and the screen can still
 * show an empty "Techniques from here" heading, split the priorities prose in
 * the wrong place, or render a technique row that navigates nowhere. Those are
 * the three things asserted here.
 *
 * The cross-link deserves particular suspicion: it is a prefix match against
 * free text, so it fails by returning NOTHING rather than by throwing, and a
 * screen that silently lists no techniques looks identical to a position that
 * genuinely has none.
 */
jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    useLocalSearchParams: () => ({ id: 'closed-guard' }),
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
    router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

const mockFetchPosition = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));
jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPosition: (...a: unknown[]) => mockFetchPosition(...a),
}));

const mockFetchTechniques = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: (...a: unknown[]) => mockFetchTechniques(...a),
}));

const CLOSED_GUARD: Position = {
  id: 'closed-guard',
  name: 'Closed Guard',
  aliases: ['full guard'],
  family: 'Guard',
  order_index: 10,
  description: 'You are on your back with your legs wrapped around your opponent.',
  priorities: 'Bottom: break their posture down.\n\nTop: posture up and stay stacked.',
};

function technique(over: Partial<TechniqueSummary> & { id: string; name: string }): TechniqueSummary {
  return {
    aliases: [],
    category: 'Submission',
    position: 'Guard - Bottom',
    position_detail: '',
    gi_no_gi: 'Both',
    typical_belt: '',
    ibjjf_ruleset_id: '',
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockFetchPosition.mockReset().mockResolvedValue(CLOSED_GUARD);
  mockFetchTechniques.mockReset().mockResolvedValue([]);
});

test('renders the prose a beginner came for', async () => {
  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-detail')).toBeTruthy());
  expect(screen.getByText('Closed Guard')).toBeTruthy();
  expect(screen.getByText(/legs wrapped around your opponent/)).toBeTruthy();
});

/**
 * The labelled halves are the point of the priorities field — an athlete
 * should find their own side without reading the other. If the regex stops
 * matching, this renders as one undifferentiated paragraph, which still looks
 * plausible and is why it is asserted rather than eyeballed.
 */
test('splits priorities into the two players', async () => {
  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByText('BOTTOM')).toBeTruthy());
  expect(screen.getByText('TOP')).toBeTruthy();
  expect(screen.getByText('break their posture down.')).toBeTruthy();
  expect(screen.getByText('posture up and stay stacked.')).toBeTruthy();
});

/**
 * The cross-link, and the prefix rule underneath it.
 *
 * `Guardless Scramble` is the fixture that earns its place: it is the ONLY one
 * here that distinguishes `startsWith(family + ' - ')` from the sloppier
 * `startsWith(family)`. Dropping the separator was mutation-tested against this
 * file — with `Half Guard - Top` and `Mount - Bottom` alone, the weakened rule
 * still excluded everything it should and the test passed anyway, which made
 * the assertion decorative. The current library happens to contain no such
 * value; the guard is what keeps a future `Mounted …` or `Backstep …` entry
 * from being silently absorbed.
 */
test('lists only the techniques from this position family', async () => {
  mockFetchTechniques.mockResolvedValue([
    technique({ id: 'armbar-closed-guard', name: 'Armbar from Closed Guard' }),
    technique({ id: 'scissor-sweep', name: 'Scissor Sweep', category: 'Sweep' }),
    technique({ id: 'knee-slice', name: 'Knee Slice Pass', position: 'Half Guard - Top' }),
    technique({ id: 'mount-escape', name: 'Mount Escape', position: 'Mount - Bottom' }),
    technique({ id: 'guardless', name: 'Guardless Scramble', position: 'Guardless Scramble' }),
  ]);

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByText('Armbar from Closed Guard')).toBeTruthy());
  expect(screen.getByText('Scissor Sweep')).toBeTruthy();
  expect(screen.queryByText('Knee Slice Pass')).toBeNull();
  expect(screen.queryByText('Mount Escape')).toBeNull();
  expect(screen.queryByText('Guardless Scramble')).toBeNull();
  // The count is part of the label, so a wrong filter shows up here too.
  expect(screen.getByText('TECHNIQUES FROM HERE · 2')).toBeTruthy();
});

/**
 * Unlike the technique screen's edge lists, these rows navigate — every one of
 * them came out of the fetched library, so all of them resolve.
 */
test('a technique row opens that technique', async () => {
  mockFetchTechniques.mockResolvedValue([
    technique({ id: 'armbar-closed-guard', name: 'Armbar from Closed Guard' }),
  ]);

  render(<PositionScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('position-technique-armbar-closed-guard')).toBeTruthy(),
  );

  fireEvent.press(screen.getByTestId('position-technique-armbar-closed-guard'));
  expect(mockPush).toHaveBeenCalledWith('/technique/armbar-closed-guard');
});

/**
 * The screen's standing rule: a section with no content does not render at
 * all. An empty "Techniques from here" heading claims the position has none,
 * which for Knee on Belly would be a lie about the library rather than about
 * the position.
 */
test('renders no techniques heading when there are none', async () => {
  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-detail')).toBeTruthy());
  expect(screen.queryByText(/TECHNIQUES FROM HERE/)).toBeNull();
});

/**
 * The library failing must not take the glossary down with it — the prose is
 * what the athlete opened the screen for, and it already loaded.
 */
test('still renders the position when the library fails', async () => {
  mockFetchTechniques.mockRejectedValue(new Error('Request failed (500).'));

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-detail')).toBeTruthy());
  expect(screen.getByText('Closed Guard')).toBeTruthy();
  expect(screen.queryByTestId('position-error')).toBeNull();
});

/** An honest failure, never a blank screen with empty fields. */
test('reports a failure to load the position', async () => {
  mockFetchPosition.mockRejectedValue(new Error('Request failed (404).'));

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-error')).toBeTruthy());
  expect(screen.queryByTestId('position-detail')).toBeNull();
});
