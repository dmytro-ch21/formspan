import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LogBjjScreen from '../../app/bjj/log';
import { startLocalSession } from '@/lib/sessionStore';

/**
 * N487/#848: `ended_at` on a post-hoc BJJ log used to be "duration minutes
 * before whenever Log it was tapped" — right if you log right after class,
 * silently wrong by however late you actually logged it. N476/N477 already
 * join a session's HR data to `started_at`..`ended_at`, so a late log fed
 * the wrong window into that join: the athlete's couch, not the mat.
 *
 * These tests are about the WIRING, not the arithmetic — `EndTimeCorrection`
 * has its own suite for that (`components/__tests__/endTimeCorrection.test.tsx`).
 * What matters here is that `commit()` actually uses the athlete's choice
 * when there is one, and — just as load-bearing — leaves the untouched fast
 * path exactly as it was before this ticket existed.
 */

jest.setTimeout(30_000);

jest.mock('@/lib/sessionStore', () => ({
  startLocalSession: jest.fn(async (userID: string, input: Record<string, unknown>) => ({
    id: 's-new',
    user_id: userID,
    workout_id: null,
    sport: 'bjj',
    name: input.name,
    intent: 'normal',
    started_at: input.started_at,
    ended_at: input.ended_at,
    notes: '',
    sets: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dirty: true,
  })),
  saveLocalBjjDetail: jest.fn(async () => {}),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

// Best-effort focus fetch — stubbed empty so it never races the assertions
// below with a real `fetch`.
jest.mock('@/lib/bjjFocus', () => ({ fetchFocus: jest.fn(async () => []) }));

// No `Link` here — `LogBjjScreen` never imports one, so mocking it would
// need the `require()`-inside-a-hoisted-factory dance the other screen
// suites use for exactly that reason (see `bjjSessionScreen.test.tsx`'s own
// comment) for a component this file never renders.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 7, 20, 21, 30, 0)); // 21:30 local
  (startLocalSession as jest.Mock).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

it('the fast path is untouched: no correction opened, ended_at is real now', async () => {
  render(<LogBjjScreen />);
  await screen.findByTestId('bjj-log-screen');

  // Default duration (60m), default kind (class) — the three-tap floor:
  // pick nothing, tap "Log it".
  fireEvent.press(screen.getByTestId('bjj-log-save'));

  await waitFor(() => expect(startLocalSession).toHaveBeenCalledTimes(1));
  const [, input] = (startLocalSession as jest.Mock).mock.calls[0];
  expect(input.ended_at).toBe(new Date(2026, 7, 20, 21, 30, 0).toISOString());
  expect(input.started_at).toBe(new Date(2026, 7, 20, 20, 30, 0).toISOString());
});

it('a chosen end time overrides "now", and started_at shifts with it', async () => {
  render(<LogBjjScreen />);
  await screen.findByTestId('bjj-log-screen');

  // 60m preset is already the default — set a real end time an hour before
  // "now" (the corner case this ticket exists for: logging well after class).
  fireEvent.press(screen.getByTestId('bjj-log-end-time-row'));
  fireEvent.press(screen.getByTestId('bjj-log-end-time-offset-60'));

  fireEvent.press(screen.getByTestId('bjj-log-save'));

  await waitFor(() => expect(startLocalSession).toHaveBeenCalledTimes(1));
  const [, input] = (startLocalSession as jest.Mock).mock.calls[0];
  // ended_at is the corrected time — 1h before the fake "now" above.
  expect(input.ended_at).toBe(new Date(2026, 7, 20, 20, 30, 0).toISOString());
  // started_at still respects the (unchanged) 60-minute duration preset,
  // now measured from the CORRECTED end rather than from "now".
  expect(input.started_at).toBe(new Date(2026, 7, 20, 19, 30, 0).toISOString());
});

it('picking a shorter duration after correcting the end time still anchors on the corrected end', async () => {
  render(<LogBjjScreen />);
  await screen.findByTestId('bjj-log-screen');

  fireEvent.press(screen.getByTestId('bjj-log-end-time-row'));
  fireEvent.press(screen.getByTestId('bjj-log-end-time-offset-120'));
  fireEvent.press(screen.getByTestId('bjj-duration-30'));

  fireEvent.press(screen.getByTestId('bjj-log-save'));

  await waitFor(() => expect(startLocalSession).toHaveBeenCalledTimes(1));
  const [, input] = (startLocalSession as jest.Mock).mock.calls[0];
  expect(input.ended_at).toBe(new Date(2026, 7, 20, 19, 30, 0).toISOString());
  expect(input.started_at).toBe(new Date(2026, 7, 20, 19, 0, 0).toISOString());
});
