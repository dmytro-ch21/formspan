import { StyleSheet } from 'react-native';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import LibraryScreen from '../../app/library';
import { ApiError } from '@/lib/apiError';

/**
 * F21 (#497) — W10's mechanism, at a different boundary.
 *
 * `ScreenHeader`'s own hairline (`screenHeader.test.tsx`) only draws when the
 * header's bottom edge IS the top of the scrolling region — and Library opts
 * out of that (`contentScrollsUnder={false}`), because content actually
 * scrolls under its own fixed chrome (the search field, filter chips, and —
 * found during review — the two error banners), not under the header. That
 * left the real clip edge unmarked: `vola.bg` above it, `vola.bg` below it, a
 * row cut mid-glyph against an identical colour.
 *
 * This suite proves three things, the first two mirroring
 * `screenHeader.test.tsx`'s own split:
 *
 *  - `styles.chrome` — the wrap around `styles.controls` AND the two error
 *    banners, not `styles.controls` alone — draws the rule, in the exact same
 *    token `vola.lineBoundary` that `ScreenHeader`'s `scrollEdge` and the tab
 *    bar's `borderTopColor` draw. F20 (#496) named and documented that token
 *    precisely so this ticket would read it rather than pick a third value;
 *    asserting the literal hex here (not a re-export of the token) is the
 *    same convention `screenHeader.test.tsx` uses, and it means a palette
 *    edit that silently changed the token would be caught here too.
 *  - `ScreenHeader` itself draws NONE on this screen — so Library's fixed
 *    chrome carries exactly one boundary rule, not two stacked seams.
 *  - **The rule stays below the error banner, not above it.** `error` and
 *    `techniquesFailed` render as siblings of the scroll view, never inside
 *    it — so on a first pass this ticket's own fix put the rule on
 *    `styles.controls` alone, which would have left it sitting ABOVE an error
 *    message with the scroll view's real top edge (below the error text)
 *    unmarked again: the identical bug, one banner lower. Caught in review,
 *    fixed by moving the border to a `styles.chrome` wrap around both.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

// Module-level (name prefixed `mock`, which is what jest's hoist-check
// exempts) rather than created fresh inside `useRouter()` — a fresh
// `jest.fn()` per call can't be asserted against or reconfigured from a
// test, since nothing outside the mock factory holds a reference to it.
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({
      push: mockPush,
      back: mockBack,
      replace: mockReplace,
      canGoBack: mockCanGoBack,
    }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

const mockFetchExercises = jest.fn();
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: (...a: unknown[]) => mockFetchExercises(...a),
}));
jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPositions: jest.fn(async () => []),
}));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => []),
  fetchRulesets: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: jest.fn(async () => []),
}));
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  getStanding: jest.fn(async () => null),
}));
// Empty, deliberately, same reason as `libraryErrorMessages.test.tsx`: a
// non-empty cache short-circuits `load`'s error path before it ever reaches
// `setError`, which would make the error-banner case below pass vacuously.
jest.mock('@/lib/sessionStore', () => ({
  cachedExercises: jest.fn(async () => []),
  cacheExercises: jest.fn(async () => {}),
}));
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: jest.fn(async () => null),
  writePref: jest.fn(async () => {}),
}));
jest.mock('@/lib/useAuthToken', () => {
  const stable = async () => 't';
  return { useAuthToken: () => stable };
});
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
          has_goals: false,
          has_progression: true,
          has_food_log: false,
          record_kinds: [],
        },
      },
    ],
    ready: true,
  }),
}));

beforeEach(() => {
  mockFetchExercises.mockReset();
  mockFetchExercises.mockResolvedValue([]);
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockCanGoBack.mockReset();
  mockCanGoBack.mockReturnValue(true);
});

/**
 * N484 — `headerShown: false` (the fix for the doubled header above) removes
 * React Navigation's native header, which was this screen's ONLY back
 * control: `ScreenHeader` was built for TAB screens and has no back
 * affordance, only a right-side `action` slot. Found by `frontend-reviewer`
 * and `ac-verifier` independently against the first version of this fix,
 * which hid the native header without replacing what it removed — Library
 * was reachable but not leavable except by an edge-swipe gesture, invisible
 * to VoiceOver.
 */
describe('the back button — N484', () => {
  it('is present, reachable by accessibility label', async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-back')).toBeTruthy());
    expect(screen.getByLabelText('Back')).toBeTruthy();
  });

  it('goes back when there is somewhere to go back to', async () => {
    mockCanGoBack.mockReturnValue(true);
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-back')).toBeTruthy());
    fireEvent.press(screen.getByTestId('library-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('falls back to the home route with nothing to go back to — a deep link, say', async () => {
    mockCanGoBack.mockReturnValue(false);
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-back')).toBeTruthy());
    fireEvent.press(screen.getByTestId('library-back'));
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe("the edge beneath Library's fixed chrome", () => {
  it('draws the rule on the chrome wrap, in the SAME token as the header/tab-bar edge', async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-chrome')).toBeTruthy());
    // LITERAL, per `screenHeader.test.tsx`'s own convention — `vola.lineBoundary`.
    // Reusing the token by reference here would pass even if `library.tsx` had
    // imported a fresh, independently-picked colour that happened to share a
    // variable name; the literal is what proves it is F20's actual value.
    expect(screen.getByTestId('library-chrome')).toHaveStyle({
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#5A606A',
    });
  });

  it('draws NO rule on the inner controls block itself — the wrap owns it, not the block', async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-controls')).toBeTruthy());
    const controls = screen.getByTestId('library-controls');
    expect(StyleSheet.flatten(controls.props.style).borderBottomWidth).toBeUndefined();
  });

  it('leaves the shared ScreenHeader carrying none — one rule, not two stacked seams', async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-chrome')).toBeTruthy());
    const header = screen.getByTestId('screen-header');
    expect(header).not.toHaveStyle({ borderBottomWidth: StyleSheet.hairlineWidth });
    expect(StyleSheet.flatten(header.props.style).borderBottomWidth).toBeUndefined();
  });

  /**
   * The case review caught: an error banner is fixed chrome too (it renders
   * as a sibling of the scroll view, never inside it), so when one is
   * showing, the scroll view's real top edge sits below IT, not below the
   * search/chips. A rule that only ever wrapped `styles.controls` would
   * leave that state exactly as unmarked as before this ticket — the bug
   * reappearing the moment an athlete is offline, since that is precisely
   * when `library-error` renders.
   */
  it('keeps the error banner INSIDE the bordered wrap, so the rule stays below it too', async () => {
    mockFetchExercises.mockRejectedValue(new ApiError('offline', 'internal', 500));
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-error')).toBeTruthy());
    const chrome = screen.getByTestId('library-chrome');
    // The error banner is a DESCENDANT of the bordered wrap — proving the
    // border sits below it in the render tree, not above it.
    expect(within(chrome).getByTestId('library-error')).toBeTruthy();
    expect(chrome).toHaveStyle({
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#5A606A',
    });
  });
});
