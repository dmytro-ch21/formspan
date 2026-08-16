import { render, screen, waitFor } from '@testing-library/react-native';

import BjjSessionScreen from '../bjj/session/[id]';
import type { SessionDetail } from '@/lib/bjjSession';
import { readLocalSession, type LocalSession } from '@/lib/sessionStore';

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

// The house default for component tests in this suite — all three siblings set
// it, for the one-off cost of standing up the React Native module graph under
// jest-expo on a cold runner. Note it does NOT govern the `waitFor` calls below,
// which carry their own 1s budget; this measures at ~0.4s either way.
jest.setTimeout(30_000);

/*
 * TYPED, because a jest.mock factory is untyped and every one of these fields
 * was wrong before someone checked: `rpe` instead of `session_rpe` (so the RPE
 * stat silently rendered its `—` fallback), a `kind` outside the four legal
 * ones, tags with no `category` — which the "what happened live" section filters
 * on, so it could never have rendered — and neither required `gi` nor `dirty`.
 *
 * The two assertions passed regardless, which is the point: an untyped fixture
 * lets a test exercise fallback branches while reading as though it covers the
 * real ones. The `mock` prefix is what lets a jest.mock factory close over them.
 */
const mockSession: LocalSession = {
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
  dirty: false,
};

const mockDetail: SessionDetail = {
  kind: 'class',
  gi: true,
  rounds: 5,
  round_minutes: 5,
  session_rpe: 7,
  academy: '',
  note: '',
  body_note: '',
  tags: [
    { category: 'pass', event: 'drilled', position: 'Guard - Top', technique_id: 'knee-cut-pass', count: 1 },
    { category: 'pass', event: 'scored', position: 'Guard - Top', technique_id: 'knee-cut-pass', count: 2 },
  ],
};

// Resolve on a later tick. This DOCUMENTS the loading-then-loaded shape rather
// than creating it: `load()` is an async function, so its setState calls can
// never land in the initial synchronous render whatever the mocks return —
// measured, the test still fails against the broken screen with plain
// `Promise.resolve`. The two-render transition is structural. Keep the delay for
// legibility; do not rely on it as the guard.
const deferred = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 0));

jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: jest.fn(() => deferred(mockSession)),
  readLocalBjjDetail: jest.fn(() => deferred(mockDetail)),
  saveLocalBjjDetail: jest.fn(async () => {}),
  renameLocalSession: jest.fn(async () => true),
  deleteLocalSession: jest.fn(async () => {}),
  finishLocalSession: jest.fn(async () => {}),
}));

jest.mock('@/lib/bjjSession', () => ({
  ...jest.requireActual('@/lib/bjjSession'),
  getDetail: jest.fn(() => deferred(mockDetail)),
}));

/*
 * The share card's server-side numbers, stubbed.
 *
 * Not for isolation — the hook already swallows a failure, because calories and
 * the VOLA score decorate a card that is complete without them. For
 * DETERMINISM: unmocked, mounting the finished-class test fires a real `fetch`
 * at `/v1/sessions/s1/card`, and on the machines this repo is developed on
 * there is usually an API listening on :8080. A component test that quietly
 * talks to whatever is running locally passes or fails for reasons that have
 * nothing to do with the code under test.
 */
jest.mock('@/lib/sessionCardApi', () => ({
  getSessionCard: jest.fn(() => new Promise(() => {})),
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

// NOTE: `useAuthToken` and `@clerk/clerk-expo` are deliberately NOT mocked here.
// jest.setup.js already provides them, and its token getter is identity-STABLE
// on purpose — its own comment explains that an unstable one turns any effect
// depending on it into an infinite refetch loop, "which was three live bugs".
// A local `useAuthToken: () => async () => 'token'` returns a fresh arrow per
// render and reproduces exactly that: measured at 17 refetches in one test.

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
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

/*
 * Sharing a class you logged, rather than only one you just finished.
 *
 * The card used to exist for exactly as long as the completion modal did —
 * dismiss it and a class became unshareable forever, which is most of a class's
 * life. That is invisible from the logging side and only shows up when somebody
 * opens Tuesday's session wanting to post it.
 *
 * The two assertions are a PAIR and neither is worth much alone: presence alone
 * passes against a button rendered unconditionally (which would offer to share a
 * class still in progress, with no `ended_at` to date the card from), and absence
 * alone passes against a button that was never built. Both are keyed on the same
 * `session.ended_at` the screen gates on.
 */
it('offers the share card on a class that has finished', async () => {
  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByTestId('bjj-session-share')).toBeTruthy();
  });
});

it('offers no share card while the class is still open', async () => {
  (readLocalSession as jest.Mock).mockImplementation(() =>
    deferred({ ...mockSession, ended_at: null }),
  );

  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
  // Present on the same screen, so this is not asserting against an unrendered
  // one: the finish control is what stands where Share stands afterwards.
  expect(screen.getByTestId('bjj-session-finish')).toBeTruthy();
  expect(screen.queryByTestId('bjj-session-share')).toBeNull();
});

afterEach(() => {
  // Restored rather than left mutated — jest.mock's factory closes over
  // `mockSession` once, so an override leaks into every test after it.
  (readLocalSession as jest.Mock).mockImplementation(() => deferred(mockSession));
});
