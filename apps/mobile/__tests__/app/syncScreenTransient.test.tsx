import { render, screen } from '@testing-library/react-native';

import SyncScreen from '../../app/sync';

/**
 * N493 — the repair screen used to have exactly one empty state ("Nothing
 * is stuck"), reached whenever there were no PERMANENT rows — regardless of
 * whether `SyncChip` sent you here because of a transient failure still in
 * flight. `SyncChip.tsx`'s own `chipFor` shows the red "Sync failed" state
 * for ANY `lastError`, but this screen (by design, see its own doc comment)
 * lists only permanent ones. A persistent transient failure — retried
 * automatically, never listed — used to land on the fully reassuring
 * "Nothing is stuck" copy directly under a red alarm chip, with nothing on
 * screen explaining the disagreement.
 */

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => jest.fn(async () => 'token') }));
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [], ready: true, stale: false, apply: jest.fn() }),
}));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ label: 'VOLA', accent: '#D3EC52', ink: '#D3EC52', on: '#080B12' }),
}));

const mockBlockedRows = jest.fn();
jest.mock('@/lib/sessionStore', () => ({
  blockedRows: (...a: unknown[]) => mockBlockedRows(...a),
  retryBlockedRow: jest.fn(),
}));

let mockSyncState: {
  syncing: boolean;
  pending: number;
  deferred: number;
  lastSyncAt: number | null;
  lastError: string | null;
  online: boolean;
};
jest.mock('@/lib/sync', () => ({
  useSyncState: () => mockSyncState,
  syncNow: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
});

it('explains a persisting transient failure instead of saying nothing is stuck', async () => {
  mockSyncState = {
    syncing: false,
    pending: 2,
    deferred: 0,
    lastSyncAt: null,
    lastError: 'the server did not answer in time',
    online: true,
  };
  mockBlockedRows.mockResolvedValue([]);

  render(<SyncScreen />);

  expect(await screen.findByTestId('sync-transient-error')).toBeTruthy();
  expect(screen.getByText('the server did not answer in time')).toBeTruthy();
  expect(screen.queryByTestId('sync-nothing-stuck')).toBeNull();
  expect(screen.queryByText('Nothing is stuck')).toBeNull();
});

it('still says nothing is stuck when there is truly nothing wrong', async () => {
  mockSyncState = {
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: Date.now(),
    lastError: null,
    online: true,
  };
  mockBlockedRows.mockResolvedValue([]);

  render(<SyncScreen />);

  expect(await screen.findByTestId('sync-nothing-stuck')).toBeTruthy();
  expect(screen.queryByTestId('sync-transient-error')).toBeNull();
});

it('a permanent row still wins over the transient-error copy — it is the more actionable state', async () => {
  mockSyncState = {
    syncing: false,
    pending: 1,
    deferred: 0,
    lastSyncAt: null,
    lastError: 'set 10: weight must be greater than 0',
    online: true,
  };
  mockBlockedRows.mockResolvedValue([
    { kind: 'session', id: 's1', name: 'Workout 1', lastError: 'set 10: weight must be greater than 0', sport: 'strength' },
  ]);

  render(<SyncScreen />);

  expect(await screen.findByText('Needs your attention')).toBeTruthy();
  expect(screen.queryByTestId('sync-transient-error')).toBeNull();
  expect(screen.queryByTestId('sync-nothing-stuck')).toBeNull();
});
