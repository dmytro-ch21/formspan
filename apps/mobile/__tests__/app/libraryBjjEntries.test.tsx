import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LibraryScreen from '../../app/library';
import type { Module } from '@/lib/modules';
import { PREF_LIBRARY_SPORT } from '@/lib/prefs';

/**
 * The Library's own-chains entry — N181 (#586).
 *
 * `Sequences` was a row on the You tab and is here now: MOVED, not copied, so
 * there is exactly one entry point to `/sequence` in the app. That makes this
 * block the app's only route to an athlete's captured chains, and this file
 * exists because of what "only route" costs when the gate is wrong.
 *
 * The gate has three parts and each is asserted separately below, because each
 * one fails silently — a missing entry point produces no error, no red box and
 * no failing typecheck. It produces an athlete who cannot find their chains and
 * reports the feature as missing, which is #414 and, before it, N61.
 *
 *  1. It is gated on the technique MODULE, so a strength-only account does not
 *     get a shelf that can only be empty.
 *  2. It is NOT gated on the sport filter, which is persisted
 *     (`PREF_LIBRARY_SPORT`) — an athlete whose last visit left it on Strength
 *     would otherwise open this screen with the route already gone.
 *  3. It is NOT inside the position glossary, which additionally requires
 *     `positions.length > 0` — a server read. A failed positions fetch must not
 *     take the sequences away with it.
 *
 * Parts 2 and 3 are the two that a reading of the code passes and a test does
 * not: both render perfectly well on a warm, online, unfiltered screen, which
 * is the only state anybody checks by hand.
 *
 * N469 (#794) moved this row (and class plans, and the round map/curricula/
 * position glossary) behind a "More from your library" bottom sheet — none of
 * them filter the technique list, so they no longer sit in the fixed header.
 * Every scenario below now opens that sheet (`library-extras-toggle`) before
 * looking for the link; the three gates above are unchanged, only reachable
 * one tap later.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
        // The screen memoises its callback; firing on mount is all this file
        // needs, since nothing here is about the refocus cycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    Stack: { Screen: () => null },
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

// Every network read this screen makes. They answer with nothing, deliberately:
// the sequences entry must not depend on any of them, and a stub that returned
// content could hide a dependency by satisfying it.
const mockPositions = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/positions', () => ({
  ...jest.requireActual('@/lib/positions'),
  fetchPositions: (...a: unknown[]) => mockPositions(...a),
}));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => []),
  fetchRulesets: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: jest.fn(async () => []),
}));
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: jest.fn(async () => []),
}));
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  getStanding: jest.fn(async () => null),
}));
jest.mock('@/lib/sessionStore', () => ({
  cachedExercises: jest.fn(async () => []),
  cacheExercises: jest.fn(async () => {}),
}));
const mockReadPref = jest.fn(
  (..._a: unknown[]): Promise<string | null> => Promise.resolve(null),
);
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: (...a: unknown[]) => mockReadPref(...a),
  writePref: jest.fn(async () => {}),
}));
// A STABLE getter, defined once. `useAuthToken` is a dependency of this
// screen's fetch effects, so a mock that hands out a fresh closure per render
// re-runs them forever — "Maximum update depth exceeded", which reads as a bug
// in the screen and is a bug in the harness. Measured: the naive version loops
// on the very first render.
jest.mock('@/lib/useAuthToken', () => {
  const stable = async () => 't';
  return { useAuthToken: () => stable };
});

/**
 * The module registry, mutable so a test can turn the discipline off.
 *
 * `capabilities.catalog` carrying `techniques` is what `moduleWithCatalog`
 * reads — the same predicate that gates the technique FETCH — so this is the
 * real shape rather than a `key === 'bjj'` stand-in.
 */
const BJJ_ON: Module = {
  key: 'bjj',
  label: 'BJJ',
  is_sport: true,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: 'techniques',
    facets: ['position'],
    has_goals: false,
    has_progression: true,
    has_food_log: false,
    record_kinds: [],
  },
};
const STRENGTH_ON: Module = {
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
};
let mockModules: Module[] = [BJJ_ON];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockPositions.mockReset().mockResolvedValue([]);
  mockReadPref.mockReset().mockResolvedValue(null);
  mockModules = [BJJ_ON];
});

/**
 * Opens the "More from your library" sheet. Every scenario below needs the
 * sheet open before the sequences link is reachable at all — N469 (#794)
 * moved it there from the fixed header.
 */
async function openExtras() {
  fireEvent.press(await screen.findByTestId('library-extras-toggle'));
}

describe('the sequences entry (N181)', () => {
  it('is here, and goes to the chain list', async () => {
    render(<LibraryScreen />);

    await openExtras();
    fireEvent.press(await screen.findByTestId('library-sequences-link'));
    expect(mockPush).toHaveBeenCalledWith('/sequence');
  });

  it('speaks the shared half of the note, which is #414 audience', async () => {
    // An `accessibilityLabel` REPLACES the concatenation of child text, so the
    // two links below this one — which fold their note into a colon-joined
    // label — can only speak what their label restates. This one splits the
    // note into a hint precisely so the clause a short label drops first,
    // *and the ones partners sent you*, is spoken: the athlete who accepted a
    // shared chain last week and is hunting for the copy is the whole reason
    // the entry point exists.
    render(<LibraryScreen />);

    await openExtras();
    const link = await screen.findByTestId('library-sequences-link');
    expect(link.props.accessibilityLabel).toBe('Your sequences');
    expect(link.props.accessibilityHint).toContain('partners sent you');
  });

  it('survives a failed positions fetch', async () => {
    // The gate this asserts is the one a reading of the code cannot check: the
    // position glossary requires `positions.length > 0`, so putting the
    // sequences row inside it would make a 500 on an unrelated fetch silently
    // remove the app's only route to the athlete's own chains. Rejecting rather
    // than resolving empty, so this is a genuinely failed read.
    mockPositions.mockRejectedValue(new Error('Network request failed'));
    render(<LibraryScreen />);

    await openExtras();
    expect(await screen.findByTestId('library-sequences-link')).toBeTruthy();
    // And the block it must not be inside really is absent here, or the
    // assertion above would be true for the wrong reason.
    await waitFor(() => expect(screen.queryByText('Start with positions')).toBeNull());
  });

  it('survives a persisted sport filter set to another discipline', async () => {
    // The sport chip is remembered across visits, so "Strength" is not an
    // exotic state — it is whatever the athlete last tapped. Gating this block
    // on `sport` (as the position glossary legitimately is) would mean opening
    // the Library and finding the only route to your own chains already gone,
    // with nothing on screen saying why.
    mockModules = [BJJ_ON, STRENGTH_ON];
    mockReadPref.mockImplementation(async (_userId: unknown, key: unknown) =>
      key === PREF_LIBRARY_SPORT ? 'strength' : null,
    );
    render(<LibraryScreen />);

    // WAIT FOR THE FILTER FIRST. The pref is read asynchronously, so the screen
    // renders unfiltered for a tick or two — and asserting the link before that
    // lands measures the unfiltered screen, which every arrangement of this gate
    // passes. Measured: with the ORDER reversed, adding `sport` to the gate
    // survived this test intact.
    await waitFor(() =>
      expect(
        screen.getByTestId('library-filter-strength').props.accessibilityState?.selected,
      ).toBe(true),
    );
    await openExtras();
    expect(screen.getByTestId('library-sequences-link')).toBeTruthy();
  });

  it('is absent when the discipline that owns it is off', async () => {
    // The arm that makes the others mean something, and the gate itself: a
    // strength-only account has no use for a chain list that can only be empty.
    mockModules = [{ ...BJJ_ON, enabled: false }, STRENGTH_ON];
    render(<LibraryScreen />);

    // Wait for the screen itself before asserting an absence, or this passes
    // against a screen that has not rendered at all.
    await screen.findByTestId('library-screen');
    // The affordance itself has to be gone, not just empty behind it — a
    // "More from your library" row that opens to nothing is the "state that
    // cannot be constructed" failure this codebase keeps re-finding.
    expect(screen.queryByTestId('library-extras-toggle')).toBeNull();
    expect(screen.queryByTestId('library-sequences-link')).toBeNull();

    // And the absence is ACCOUNTED FOR rather than silent. This toggle now
    // hides an athlete's own captured chains, not only reference content, and
    // N61 is the standing bill for a surface that vanishes with nothing saying
    // why — the user went looking for the belt roadmaps on a real phone and
    // reported them missing. The explainer that covers the roadmaps has to
    // cover the chains too, or this move re-opens that bug one row over.
    const off = await screen.findByTestId('library-techniques-off-link');
    expect(off.props.accessibilityLabel).toContain('your own chains');
  });
});

/**
 * Closing "More from your library" — N469 (#794).
 *
 * Opening was the only thing the suite above checked. Nothing pressed `Done`,
 * the backdrop, or a link inside the sheet and confirmed the sheet's own
 * content actually goes away — so a mutation deleting any of the seven
 * `setOpenExtras(false)` calls, or the Done/backdrop handlers themselves,
 * would have survived every test above unnoticed. `library-sequences-link`
 * being absent after closing is the assertion: the sheet's `visible` prop is
 * what RN actually gates its children on (confirmed directly — a plain
 * `{openExtras && <Modal>}` render shows no Modal content in this harness
 * while `openExtras` is false), so if the row is still findable, the sheet
 * did not really close.
 */
describe('closing "More from your library" (N469)', () => {
  it('closes on Done, and the sheet contents go with it', async () => {
    render(<LibraryScreen />);

    await openExtras();
    expect(await screen.findByTestId('library-sequences-link')).toBeTruthy();

    fireEvent.press(screen.getByTestId('library-extras-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('library-sequences-link')).toBeNull(),
    );
  });

  it('closes when a row inside it is pressed, on the way to that row\'s screen', async () => {
    render(<LibraryScreen />);

    await openExtras();
    fireEvent.press(await screen.findByTestId('library-sequences-link'));

    expect(mockPush).toHaveBeenCalledWith('/sequence');
    // The navigation and the close both fire from the same `onPress` — this
    // confirms the sheet doesn't outlive the tap that sent the athlete
    // elsewhere, which is the half a mutation deleting just the `setOpenExtras
    // (false)` call (while leaving the `router.push` intact) would slip past.
    await waitFor(() =>
      expect(screen.queryByTestId('library-sequences-link')).toBeNull(),
    );
  });
});

/**
 * Class plans and the round map are reachable AND asserted — the acceptance
 * criterion's exact words. `ac-verifier` found `library-classplans-link` and
 * `library-roundmap-link` existed (both testIDs are unchanged from before
 * N469, just relocated into the sheet) but that nothing under `apps/mobile`
 * pressed either one — the same gap the sequences link closed for itself
 * five tests up, left open for its two siblings. Both live behind the same
 * `library-extras-toggle` sheet.
 */
describe('class plans and the round map are reachable and asserted (N469)', () => {
  it('"Your class plans" goes to the class-plan list', async () => {
    render(<LibraryScreen />);

    await openExtras();
    fireEvent.press(await screen.findByTestId('library-classplans-link'));
    expect(mockPush).toHaveBeenCalledWith('/classplans');
  });

  it('"How a round goes" goes to the round map', async () => {
    // The round-map row lives inside "Start with positions", which requires
    // BOTH a non-empty glossary fetch AND `usesPosition(sport, modules)` —
    // and that reads `moduleFor(modules, sport)`, which only matches a real
    // module key. `sport === ''` ("All") therefore never satisfies it, same
    // as on `origin/main` before N469: tapping the BJJ chip is how an athlete
    // reaches this block, on this screen, today. Not a behavior this ticket
    // changed — preserved verbatim from the pre-N469 gate.
    mockPositions.mockResolvedValue([
      {
        id: 'mount',
        name: 'Mount',
        aliases: [],
        family: 'Mount',
        detail_includes: [],
        detail_excludes: [],
        order_index: 0,
        description: '',
        priorities: '',
      },
    ]);
    render(<LibraryScreen />);

    fireEvent.press(await screen.findByTestId('library-filter-bjj'));
    await openExtras();
    fireEvent.press(await screen.findByTestId('library-roundmap-link'));
    expect(mockPush).toHaveBeenCalledWith('/bjj/roundmap');
  });
});
