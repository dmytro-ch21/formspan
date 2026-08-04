import { render, screen, waitFor } from '@testing-library/react-native';

import BjjSessionScreen from '../bjj/session/[id]';

/**
 * Opening a BJJ session from Today crashed.
 *
 *   Rendered more hooks than during the previous render.
 *
 * A black screen and "Something went wrong" on every class in Recents — the
 * whole reason the reading half of BJJ logging exists, unreachable.
 *
 * The cause was one `useMemo` sitting BELOW the screen's two early returns
 * (`if (loading)` and `if (!session)`). React matches hooks positionally, so
 * the first render — which returns the spinner — called one fewer hook than
 * every render after the load resolved. Nothing about that is visible to the
 * typechecker: hook order is a runtime property.
 *
 * This test is the regression guard for the SCREEN. `react-hooks/rules-of-hooks`
 * (added to `apps/mobile` in the same change, because this app had no linter at
 * all) is the guard for the CLASS. Both matter: the lint rule catches the next
 * one before it runs, and this catches a version React reports at runtime that
 * a static rule cannot see — the transition itself.
 *
 * What makes it a real test rather than a smoke test is the TRANSITION. The
 * screen must render at least twice: once while loading, once with a session.
 * Asserting only on the settled state would pass against the broken code,
 * because by then the hook count is consistent again.
 */

// See workoutDetailScreen.test.tsx — the one-off cost of standing up the React
// Native module graph under jest-expo blows past jest's 5s default on a cold
// CI runner while passing locally.
jest.setTimeout(30_000);

const session = {
  id: 's1',
  user_id: 'u1',
  workout_id: null,
  sport: 'bjj',
  name: 'Gi class',
  started_at: '2026-08-04T18:00:00Z',
  ended_at: '2026-08-04T19:30:00Z',
  notes: '',
  sets: [],
  created_at: '2026-08-04T18:00:00Z',
  updated_at: '2026-08-04T19:30:00Z',
};

const detail = {
  kind: 'gi',
  rounds: 5,
  round_minutes: 5,
  rpe: 7,
  note: '',
  tags: [
    { event: 'drilled', technique_id: 'knee-cut-pass', position: 'Guard - Top', count: 1 },
    { event: 'scored', technique_id: 'knee-cut-pass', position: 'Guard - Top', count: 2 },
  ],
};

// Resolve on a later tick, so the screen genuinely renders its loading branch
// first. Resolving synchronously would collapse the two renders into one and
// the test would pass against the bug.
const deferred = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 0));

jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: jest.fn(() => deferred(session)),
  readLocalBjjDetail: jest.fn(() => deferred(detail)),
  saveLocalBjjDetail: jest.fn(async () => {}),
  renameLocalSession: jest.fn(async () => true),
  deleteLocalSession: jest.fn(async () => {}),
  finishLocalSession: jest.fn(async () => {}),
}));

jest.mock('@/lib/bjjSession', () => ({
  ...jest.requireActual('@/lib/bjjSession'),
  getDetail: jest.fn(() => deferred(detail)),
}));

jest.mock('@/lib/techniques', () => ({
  fetchTechniques: jest.fn(() =>
    deferred([
      {
        id: 'knee-cut-pass',
        name: 'Knee Cut Pass',
        aliases: [],
        category: 'Pass',
        position: 'Guard - Top',
        position_detail: '',
        gi_no_gi: 'Both',
        typical_belt: '',
        ibjjf_ruleset_id: '',
        setup_from: [],
      },
    ]),
  ),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => async () => 'token',
}));

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: () => ({ userId: 'u1' }),
}));

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 's1' }),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

it('renders through the loading transition without changing its hook count', async () => {
  // Render one throws if a hook count changes between renders, which is the
  // whole bug: the loading render returns before the memo, every later render
  // reaches it.
  render(<BjjSessionScreen />);

  // The loading branch is what renders first, and it must — see `deferred`.
  expect(screen.getByLabelText('Loading your session')).toBeTruthy();

  // ...and then the loaded branch, which is the render that used to throw.
  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
});

it('shows the session it loaded, not an empty shell', async () => {
  // Guards the fix being "made the crash go away" rather than "made the screen
  // work" — an early `return null` would satisfy the test above.
  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
  // The technique row comes from the hoisted useMemo specifically. If that memo
  // were dropped rather than moved, this is what would go missing.
  expect(screen.getByText('Knee Cut Pass')).toBeTruthy();
});
