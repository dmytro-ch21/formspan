import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SyncScreen from '../../app/sync';

/**
 * N564/#1106 — refused plans on the repair screen.
 *
 * `lib/__tests__/planRefused.test.ts` pins which plans are refused and what
 * each recovery does to the database. This file pins what only exists once the
 * screen renders: the plan is listed with the server's words, "Nothing is
 * stuck" is never said above it, each state offers its own single action and
 * never Try again, and pressing that action calls the function the database
 * test proved.
 */

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => jest.fn(async () => 'token') }));
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [], ready: true, stale: false, apply: jest.fn() }),
}));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ label: 'VOLA', accent: '#D3EC52', ink: '#D3EC52', on: '#080B12' }),
}));
jest.mock('@/lib/biometricSync', () => ({ triggerBiometricSyncNow: jest.fn() }));

jest.mock('@/lib/sessionStore', () => ({
  blockedRows: jest.fn(async () => []),
  retryBlockedRow: jest.fn(),
}));
jest.mock('@/lib/rejectedRows', () => ({
  rejectedRows: jest.fn(async () => []),
  discardRejectedRow: jest.fn(),
}));

const mockRefusedPlans = jest.fn();
const mockUnplan = jest.fn(async () => {});
const mockAcknowledge = jest.fn(async () => true);
jest.mock('@/lib/plan', () => ({
  refusedPlans: (...a: unknown[]) => mockRefusedPlans(...a),
  unplanSession: (...a: unknown[]) => mockUnplan(...(a as [])),
  acknowledgeRefusedRemoval: (...a: unknown[]) => mockAcknowledge(...(a as [])),
}));

let mockLastError: string | null = null;
const mockRequest = jest.fn();
const mockRefreshPending = jest.fn(async () => {});
jest.mock('@/lib/sync', () => ({
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, needsAttention: 1, lastSyncAt: null,
    lastError: mockLastError, online: true,
  }),
  syncNow: jest.fn(async () => {}),
  request: (...a: unknown[]) => mockRequest(...a),
  refreshPending: () => mockRefreshPending(),
}));

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('expo-router'),
    Stack: { Screen: () => null },
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
    useFocusEffect: (cb: () => void) => {
      React.useEffect(cb, [cb]);
    },
  };
});

const base = {
  day: '2026-09-15',
  sport: 'strength',
  workoutId: null,
  classPlanId: null,
  timeOfDayMinutes: 1140,
  notes: '',
  workoutName: null,
};
const PLAN = { ...base, id: 'p1', reason: 'unknown sport', refused: 'plan' as const };
const REMOVAL = {
  ...base,
  id: 'p2',
  day: '2026-09-16',
  timeOfDayMinutes: null,
  workoutName: 'Push day',
  reason: 'plan is managed by your coach',
  refused: 'removal' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLastError = null;
});

describe('a refused plan is on the repair screen', () => {
  it('NEVER says nothing is stuck while only a plan is refused', async () => {
    mockRefusedPlans.mockResolvedValue([PLAN]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-plans')).toBeTruthy());
    expect(screen.queryByTestId('sync-nothing-stuck')).toBeNull();
  });

  it('nor "Still trying" — a refused plan is not a transient failure', async () => {
    mockLastError = 'unknown sport';
    mockRefusedPlans.mockResolvedValue([PLAN]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-plans')).toBeTruthy());
    expect(screen.queryByTestId('sync-transient-error')).toBeNull();
  });

  it('names the plan and when it is, and quotes the server', async () => {
    mockRefusedPlans.mockResolvedValue([PLAN, REMOVAL]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('plan-p1')).toBeTruthy());
    // No module registry here, so the sport label falls back to its key.
    expect(screen.getByText('strength')).toBeTruthy();
    expect(screen.getByText('plan · 15 Sep · 7:00 PM')).toBeTruthy();
    expect(screen.getByText('unknown sport')).toBeTruthy();
    // The template's name wins when the device knows it.
    expect(screen.getByText('Push day')).toBeTruthy();
    expect(screen.getByText('plan · 16 Sep')).toBeTruthy();
    expect(screen.getByText('plan is managed by your coach')).toBeTruthy();
  });

  it('a refused plan offers Remove and not Try again; pressing it removes the plan and recounts', async () => {
    mockRefusedPlans.mockResolvedValueOnce([PLAN]).mockResolvedValue([]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('remove-plan-p1')).toBeTruthy());
    expect(screen.queryByTestId('retry-p1')).toBeNull();
    expect(screen.queryByTestId('keep-plan-p1')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('remove-plan-p1'));
    });

    await waitFor(() => expect(mockUnplan).toHaveBeenCalledWith('u1', 'p1'));
    expect(mockRequest).toHaveBeenCalledWith('plan-removed');
    expect(mockRefreshPending).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('sync-plans')).toBeNull());
  });

  it('a refused removal offers Keep it and nothing else; pressing it acknowledges and recounts', async () => {
    mockRefusedPlans.mockResolvedValueOnce([REMOVAL]).mockResolvedValue([]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('keep-plan-p2')).toBeTruthy());
    expect(screen.queryByTestId('remove-plan-p2')).toBeNull();
    expect(screen.queryByTestId('retry-p2')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('keep-plan-p2'));
    });

    await waitFor(() => expect(mockAcknowledge).toHaveBeenCalledWith('u1', 'p2'));
    expect(mockUnplan).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRefreshPending).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('sync-plans')).toBeNull());
  });

  it('still says nothing is stuck when there are no refused plans — the control', async () => {
    mockRefusedPlans.mockResolvedValue([]);
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-nothing-stuck')).toBeTruthy());
    expect(screen.queryByTestId('sync-plans')).toBeNull();
  });

  it('a failing plan read does not take the rest of the screen down', async () => {
    mockRefusedPlans.mockRejectedValue(new Error('table is gone'));
    await render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-nothing-stuck')).toBeTruthy());
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });
});
