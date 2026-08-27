import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SessionHistoryScreen from '../session/history';
import { OfflineError } from '@/lib/apiError';

/**
 * `/session/history` — N85's search/browse screen, tested for the same shape
 * of property `app/__tests__/socialScreen.test.tsx` pins on the feed:
 *
 * **A failed network load must not render as "no sessions".** That is exactly
 * the silent-cap failure this ticket exists to end (an athlete restoring their
 * phone must be TOLD their history is reduced, not left to assume they have
 * none), so the offline fallback and its message are the header property here,
 * and pagination is the second.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockPage = jest.fn();
jest.mock('@/lib/sessions', () => ({
  ...jest.requireActual('@/lib/sessions'),
  listSessionsPage: (...a: unknown[]) => mockPage(...a),
}));

const mockLocal = jest.fn();
jest.mock('@/lib/sessionStore', () => ({
  listLocalSessions: (...a: unknown[]) => mockLocal(...a),
}));

jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({
    modules: [
      {
        key: 'strength',
        label: 'Strength',
        is_sport: true,
        default_on: true,
        enabled: true,
        capabilities: {
          catalog: 'exercises',
          facets: [],
          has_goals: true,
          has_progression: true,
          has_food_log: false,
          record_kinds: [],
        },
      },
    ],
    ready: true,
  }),
}));
jest.mock('@/lib/UnitsProvider', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));
jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
const mockGetToken = () => Promise.resolve('tok');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush }),
    Stack: { Screen: () => null },
    // Fires on mount and whenever the callback identity changes — the same
    // shape a real focus does, and what `todayScreen.test.tsx` uses.
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
  };
});

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: 'u1',
  workout_id: null,
  sport: 'strength',
  name: `Session ${id}`,
  started_at: '2026-08-07T10:00:00Z',
  ended_at: '2026-08-07T11:00:00Z',
  notes: '',
  sets: [],
  created_at: '2026-08-07T10:00:00Z',
  updated_at: '2026-08-07T10:00:00Z',
  ...over,
});

beforeEach(() => {
  mockPage.mockReset().mockResolvedValue({ sessions: [], total: 0, limit: 20, offset: 0 });
  mockLocal.mockReset().mockResolvedValue([]);
  mockPush.mockReset();
});

it('says the connection failed rather than claiming the athlete has no sessions', async () => {
  // THE POINT OF THIS FILE — see the header note. `listLocalSessions` still
  // resolves to a real fallback list, which must not be mistaken for "there
  // was never a network problem".
  mockPage.mockRejectedValue(new OfflineError());
  mockLocal.mockResolvedValue([session('local-1')]);

  render(<SessionHistoryScreen />);

  await waitFor(() => expect(screen.getByTestId('session-history-offline')).toBeTruthy());
  expect(screen.queryByText('No sessions match')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('session-history-row-local-1')).toBeTruthy());
});

it('an empty offline fallback still says WHY, not just "no sessions"', async () => {
  mockPage.mockRejectedValue(new OfflineError());
  mockLocal.mockResolvedValue([]);

  render(<SessionHistoryScreen />);

  await waitFor(() => expect(screen.getByTestId('session-history-empty')).toBeTruthy());
  expect(screen.getByText('Nothing saved on this device yet')).toBeTruthy();
});

it('the offline fallback respects the active sport filter, not the whole local cache', async () => {
  // Independently flagged by both reviewers: the sport chip stayed visibly
  // selected while the offline fallback silently ignored it and rendered
  // every cached session regardless — a "Strength" filter that still showed
  // BJJ sessions offline, with the chip claiming otherwise.
  mockPage.mockRejectedValue(new OfflineError());
  mockLocal.mockResolvedValue([
    session('bjj-1', { sport: 'bjj' }),
    session('strength-1', { sport: 'strength' }),
  ]);

  render(<SessionHistoryScreen />);
  await waitFor(() => expect(screen.getByTestId('session-history-row-bjj-1')).toBeTruthy());
  expect(screen.getByTestId('session-history-row-strength-1')).toBeTruthy();

  fireEvent.press(screen.getByTestId('session-history-sport-strength'));

  await waitFor(() => expect(screen.queryByTestId('session-history-row-bjj-1')).toBeNull());
  expect(screen.getByTestId('session-history-row-strength-1')).toBeTruthy();
});

it('a genuine server error is distinct from the offline fallback — no fabricated local list', async () => {
  mockPage.mockRejectedValue(new Error('Session already finished.'));

  render(<SessionHistoryScreen />);

  await waitFor(() => expect(screen.getByTestId('session-history-error')).toBeTruthy());
  expect(screen.queryByTestId('session-history-offline')).toBeNull();
  // Never asked the offline fallback for anything — a real answered failure
  // is not "couldn't reach the server".
  expect(mockLocal).not.toHaveBeenCalled();
});

it('"Show older" appends the next page and asks for the offset already on screen', async () => {
  mockPage
    .mockResolvedValueOnce({ sessions: [session('s1'), session('s2')], total: 3, limit: 2, offset: 0 })
    .mockResolvedValueOnce({ sessions: [session('s3')], total: 3, limit: 2, offset: 2 });

  render(<SessionHistoryScreen />);

  await waitFor(() => expect(screen.getByTestId('session-history-row-s1')).toBeTruthy());
  expect(screen.queryByTestId('session-history-row-s3')).toBeNull();

  fireEvent.press(screen.getByTestId('session-history-load-more'));

  await waitFor(() => expect(screen.getByTestId('session-history-row-s3')).toBeTruthy());
  expect(mockPage).toHaveBeenNthCalledWith(
    2,
    mockGetToken,
    expect.objectContaining({ offset: 2 }),
    expect.anything(),
  );
  // Exhausted: the button must not still be offering a fourth session that
  // does not exist.
  expect(screen.queryByTestId('session-history-load-more')).toBeNull();
});

it('a sport filter re-queries the server with that sport, not a client-side filter', async () => {
  render(<SessionHistoryScreen />);
  await waitFor(() => expect(mockPage).toHaveBeenCalledTimes(1));

  fireEvent.press(screen.getByTestId('session-history-sport-strength'));

  await waitFor(() => expect(mockPage).toHaveBeenCalledTimes(2));
  expect(mockPage).toHaveBeenNthCalledWith(
    2,
    mockGetToken,
    expect.objectContaining({ sport: 'strength', offset: 0 }),
    expect.anything(),
  );
});

it('a stale "Show older" response that lands after a filter change is discarded, not appended', async () => {
  // THE RACE frontend-reviewer found: tap "Show older" on a slow connection,
  // then change a filter before it resolves. `load()` correctly replaces
  // `items` for the new filter — but without sharing one AbortController,
  // the OLD page's response could still land afterward, append stale rows
  // from the wrong query, and overwrite `total` with the wrong count. This
  // reproduces exactly that ordering and asserts the stale page is dropped.

  // Call 1: initial load, unfiltered — resolves immediately.
  mockPage.mockResolvedValueOnce({
    sessions: [session('s1'), session('s2')],
    total: 3,
    limit: 2,
    offset: 0,
  });

  render(<SessionHistoryScreen />);
  await waitFor(() => expect(screen.getByTestId('session-history-row-s1')).toBeTruthy());

  // Call 2: "Show older", unfiltered — held open. Its resolution is fired
  // deliberately AFTER the filter change below, simulating the slow
  // connection.
  let resolveStalePage: (page: unknown) => void = () => {};
  mockPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStalePage = resolve;
      }),
  );

  fireEvent.press(screen.getByTestId('session-history-load-more'));
  await waitFor(() => expect(mockPage).toHaveBeenCalledTimes(2));

  // Call 3: the filter change's own load, sport=strength — resolves
  // immediately, replacing `items` while call 2 is still pending.
  mockPage.mockResolvedValueOnce({
    sessions: [session('s3', { sport: 'strength' })],
    total: 1,
    limit: 20,
    offset: 0,
  });
  fireEvent.press(screen.getByTestId('session-history-sport-strength'));
  await waitFor(() => expect(screen.getByTestId('session-history-row-s3')).toBeTruthy());
  expect(screen.queryByTestId('session-history-row-s1')).toBeNull();

  // NOW the stale "Show older" response lands, appending a session that
  // belongs to the OLD, unfiltered query.
  await act(async () => {
    resolveStalePage({ sessions: [session('s-stale')], total: 3, limit: 2, offset: 2 });
    // Nothing to `waitFor` on success — this asserts an ABSENCE stays absent,
    // so give the stale promise's microtasks a turn to (wrongly) apply first.
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(screen.queryByTestId('session-history-row-s-stale')).toBeNull();
  // And `total` must still describe the filtered query (1), not the stale
  // unfiltered one (3) — a wrong `total` would silently mis-render "Show
  // older" for a page that does not exist under the current filter.
  expect(screen.queryByTestId('session-history-load-more')).toBeNull();
});
