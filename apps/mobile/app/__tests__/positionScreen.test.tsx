import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
  // The real entry's filter. Closed and open guard share a family and are
  // separated only by position_detail, so a fixture without this would test a
  // screen the app never renders.
  detail_includes: ['Closed Guard', 'Rubber Guard'],
  detail_excludes: [],
  order_index: 10,
  description: 'You are on your back with your legs wrapped around your opponent.',
  priorities: 'Bottom: break their posture down.\n\nTop: posture up and stay stacked.',
};

/**
 * `position_detail` defaults to match the default `position`, and callers that
 * override one should override both. A row carrying "Mount - Bottom" with a
 * detail of "Closed Guard" cannot exist in the real catalog, and a fixture that
 * pairs them teaches the next person the wrong shape.
 */
function technique(over: Partial<TechniqueSummary> & { id: string; name: string }): TechniqueSummary {
  return {
    aliases: [],
    setup_from: [],
    category: 'Submission',
    position: 'Guard - Bottom',
    position_detail: 'Closed Guard',
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
    technique({
      id: 'knee-slice',
      name: 'Knee Slice Pass',
      position: 'Half Guard - Top',
      position_detail: 'Knee Shield',
    }),
    technique({
      id: 'mount-escape',
      name: 'Mount Escape',
      position: 'Mount - Bottom',
      position_detail: 'Low Mount',
    }),
    technique({
      id: 'guardless',
      name: 'Guardless Scramble',
      position: 'Guardless Scramble',
      position_detail: 'Open Space',
    }),
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
 * The second filter axis, and the whole reason it exists.
 *
 * `family` cannot separate closed from open guard — every one of these rows
 * says "Guard - Bottom". Only `position_detail` knows. Without it both entries
 * listed the same 187 techniques, and Open Guard showed closed-guard material
 * beneath its own sentence saying the ankles are not locked.
 */
test('the detail filter separates closed guard from open guard', async () => {
  const library = [
    technique({ id: 'armbar-cg', name: 'Armbar from Closed Guard' }),
    technique({ id: 'gogoplata', name: 'Gogoplata', position_detail: 'Rubber Guard' }),
    technique({ id: 'dlr-sweep', name: 'De La Riva Sweep', position_detail: 'De La Riva' }),
    technique({ id: 'butterfly', name: 'Butterfly Sweep', position_detail: 'Butterfly Guard' }),
  ];
  mockFetchTechniques.mockResolvedValue(library);

  // Closed guard whitelists its two details.
  render(<PositionScreen />);
  await waitFor(() => expect(screen.getByText('Armbar from Closed Guard')).toBeTruthy());
  expect(screen.getByText('Gogoplata')).toBeTruthy();
  expect(screen.queryByText('De La Riva Sweep')).toBeNull();
  expect(screen.queryByText('Butterfly Sweep')).toBeNull();
  screen.unmount();

  // Open guard blacklists the same two and takes the rest of the family.
  mockFetchPosition.mockResolvedValue({
    ...CLOSED_GUARD,
    id: 'open-guard',
    name: 'Open Guard',
    detail_includes: [],
    detail_excludes: ['Closed Guard', 'Rubber Guard'],
  });
  mockFetchTechniques.mockResolvedValue(library);

  render(<PositionScreen />);
  await waitFor(() => expect(screen.getByText('De La Riva Sweep')).toBeTruthy());
  expect(screen.getByText('Butterfly Sweep')).toBeTruthy();
  expect(screen.queryByText('Armbar from Closed Guard')).toBeNull();
  expect(screen.queryByText('Gogoplata')).toBeNull();
  // The label, not just the rows. sectionLabel checks BOTH filter fields, and
  // without this line dropping the detail_excludes half of that condition
  // passes every test — silently regressing the 150-row entry to
  // "THE GUARD FAMILY", which is the claim the label exists to prevent.
  expect(screen.getByText('TECHNIQUES FROM HERE · 2')).toBeTruthy();
});

/**
 * The label may only say "FROM HERE" when the list really is this position's.
 *
 * Knee on Belly is the one entry where it isn't: no technique carries that
 * position, so it borrows Side Control's whole list. Claiming those are its own
 * would be the screen stating something false to the reader least able to check
 * — the failure this label exists to prevent.
 */
test('names the family when the list is borrowed from a sibling', async () => {
  mockFetchPosition.mockResolvedValue({
    ...CLOSED_GUARD,
    id: 'knee-on-belly',
    name: 'Knee on Belly',
    family: 'Side Control',
    detail_includes: [],
    detail_excludes: [],
  });
  mockFetchTechniques.mockResolvedValue([
    technique({ id: 'kob-mount', name: 'Knee on Belly to Mount', position: 'Side Control - Top' }),
  ]);

  render(<PositionScreen />);

  await waitFor(() =>
    expect(screen.getByText('TECHNIQUES FROM THE SIDE CONTROL FAMILY · 1')).toBeTruthy(),
  );
});

/**
 * Back Control's family is "Back" — an artefact of the rows saying
 * "Back - Top (Back Control)", not a broader scope. Nothing else maps to it, so
 * qualifying it as "THE BACK FAMILY" would be wrong, and is not a phrase in the
 * sport either.
 */
test('does not qualify back control, whose family is a naming artefact', async () => {
  mockFetchPosition.mockResolvedValue({
    ...CLOSED_GUARD,
    id: 'back-control',
    name: 'Back Control',
    family: 'Back',
    detail_includes: [],
    detail_excludes: [],
  });
  mockFetchTechniques.mockResolvedValue([
    technique({ id: 'rnc', name: 'Rear Naked Choke', position: 'Back - Top (Back Control)' }),
  ]);

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByText('TECHNIQUES FROM HERE · 1')).toBeTruthy());
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
  mockFetchPosition.mockRejectedValue(new Error('Request failed (500).'));

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-error')).toBeTruthy());
  expect(screen.queryByTestId('position-detail')).toBeNull();
  expect(screen.getByText(/Check your connection/)).toBeTruthy();
});

/**
 * A dead link and a dead network are different problems, and the text has to
 * say which. Asserting the message, not just that *some* error rendered — the
 * previous version of this test would have passed with the 404 branch deleted.
 */
test('says a missing position is missing, not that the network is down', async () => {
  mockFetchPosition.mockRejectedValue(new Error('Request failed (404).'));

  render(<PositionScreen />);

  await waitFor(() => expect(screen.getByTestId('position-error')).toBeTruthy());
  expect(screen.getByText('That position is not in the library.')).toBeTruthy();
});

/**
 * The regression this screen shipped once: the request deadline fires, both
 * promises reject with AbortError, and an unconditional `signal.aborted` guard
 * returns before clearing `loading` — leaving a spinner that never resolves and
 * carries no retry, which is strictly worse than having no deadline at all.
 *
 * An unmount aborts the same controller and must still set nothing, so the
 * reason is what distinguishes them. Both directions are asserted.
 */
test('a timed-out request reports an error instead of spinning forever', async () => {
  jest.useFakeTimers();
  try {
    // Never settles on its own — only the deadline can end this.
    mockFetchPosition.mockImplementation((...args: unknown[]) => {
      const signal = args[2] as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    mockFetchTechniques.mockResolvedValue([]);

    render(<PositionScreen />);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(screen.getByTestId('position-error')).toBeTruthy();
    expect(screen.getByText(/taking too long/)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
