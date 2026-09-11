import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SyncScreen from '../../app/sync';

/**
 * N167/#544 — the refused half of the repair screen.
 *
 * `lib/__tests__/rejectedRows.test.ts` pins what counts as refused, against a
 * real SQLite database. This file pins the thing that only exists once the
 * screen renders, and it is the defect the ticket is actually about:
 *
 * **"Nothing is stuck" appearing while rows sit refused underneath it.** Both
 * writing domains recorded the server's reason and both said in their comments
 * that this screen explained it; this screen read neither. So a refused food
 * entry left the pending count (correct), kept its reason (correct), and the
 * one screen that exists to say what is wrong said everything was fine.
 *
 * That is worse than an ugly error. It is the app being confidently wrong
 * about the athlete's own record.
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

const mockBlockedRows = jest.fn(async () => []);
jest.mock('@/lib/sessionStore', () => ({
  blockedRows: (...a: unknown[]) => mockBlockedRows(...(a as [])),
  retryBlockedRow: jest.fn(),
}));

const mockRejected = jest.fn();
const mockDiscard = jest.fn(async () => {});
jest.mock('@/lib/rejectedRows', () => ({
  rejectedRows: (...a: unknown[]) => mockRejected(...(a as [])),
  discardRejectedRow: (...a: unknown[]) => mockDiscard(...(a as [])),
}));

jest.mock('@/lib/sync', () => ({
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
  syncNow: jest.fn(async () => {}),
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

const ENTRY = {
  kind: 'food-entry' as const,
  id: 'e1',
  name: 'Porridge',
  reason: 'source_food_id does not name a saved food',
  on: '2026-09-10',
};
const SEQ = {
  kind: 'sequence' as const,
  id: 's1',
  name: 'Guard passes',
  reason: 'corrupt local copy — could not be sent',
  on: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedRows.mockResolvedValue([]);
});

describe('a refused row is on the repair screen', () => {
  it('NEVER says nothing is stuck while a row sits refused', async () => {
    // The whole ticket, in one assertion.
    mockRejected.mockResolvedValue([ENTRY]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-refused')).toBeTruthy());
    expect(screen.queryByTestId('sync-nothing-stuck')).toBeNull();
  });

  it('names the row and quotes the server rather than paraphrasing it', async () => {
    mockRejected.mockResolvedValue([ENTRY]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByText('Porridge')).toBeTruthy());
    expect(screen.getByText('source_food_id does not name a saved food')).toBeTruthy();
  });

  it('shows refused rows from both domains at once', async () => {
    mockRejected.mockResolvedValue([ENTRY, SEQ]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('refused-e1')).toBeTruthy());
    expect(screen.getByTestId('refused-s1')).toBeTruthy();
  });

  it('offers Discard and NOT Try again — retry is a lie for a refused row', async () => {
    // The distinction between the two lists, made visible. A 4xx will not
    // become a 2xx, so a retry button here would promise something that
    // cannot happen.
    mockRejected.mockResolvedValue([ENTRY]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('discard-e1')).toBeTruthy());
    expect(screen.queryByTestId('retry-e1')).toBeNull();
  });

  it('discarding removes it and re-reads the list', async () => {
    mockRejected.mockResolvedValueOnce([ENTRY]).mockResolvedValue([]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('discard-e1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('discard-e1'));
    await waitFor(() => expect(mockDiscard).toHaveBeenCalledWith('u1', ENTRY));
    await waitFor(() => expect(screen.queryByTestId('sync-refused')).toBeNull());
  });

  it('still says nothing is stuck when both lists really are empty', async () => {
    // The other half of "verify a check can PASS". Without this, every
    // assertion above would hold if the empty state had simply been deleted.
    mockRejected.mockResolvedValue([]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-nothing-stuck')).toBeTruthy());
  });

  it('a failing refused read does not take the blocked list down with it', async () => {
    // The bug review caught in the first version. With `Promise.all`, a throw
    // from the newer query discarded the already-resolved `blockedRows`
    // result, leaving `rows` null and the spinner running forever — a new
    // query taking the existing, working list with it.
    mockBlockedRows.mockResolvedValue([
      { kind: 'session', id: 'sess1', name: 'Push day', lastError: 'set 10: weight must be > 0', href: '' },
    ] as never);
    mockRejected.mockRejectedValue(new Error('table is gone'));
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByText('Push day')).toBeTruthy());
    // And the screen is not stuck loading.
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });

  it('a failing blocked read still shows the refused list', async () => {
    // The mirror. Neither read may be load-bearing for the other.
    mockBlockedRows.mockRejectedValue(new Error('nope'));
    mockRejected.mockResolvedValue([ENTRY]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-refused')).toBeTruthy());
    expect(screen.getByText('Porridge')).toBeTruthy();
  });

  it('shows the blocked list and the refused list together when both have rows', async () => {
    // They are different states and the screen must not collapse one into the
    // other, or drop one because the other rendered.
    mockBlockedRows.mockResolvedValue([
      { kind: 'session', id: 'sess1', name: 'Push day', lastError: 'set 10: weight must be > 0', href: '' },
    ] as never);
    mockRejected.mockResolvedValue([ENTRY]);
    render(<SyncScreen />);
    await waitFor(() => expect(screen.getByTestId('sync-refused')).toBeTruthy());
    expect(screen.getByText('Push day')).toBeTruthy();
    expect(screen.getByText('Porridge')).toBeTruthy();
  });
});
