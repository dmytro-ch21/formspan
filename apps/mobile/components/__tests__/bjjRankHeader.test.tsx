import { useCallback, useEffect, useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { BjjRankHeader } from '@/components/BjjRankHeader';
import type { Standing } from '@/lib/bjj';

/**
 * The belt-themed "no rank yet" state (N509, #886) — the one place on the
 * You/Profile screen where an empty BJJ state used to be a generic
 * icon-and-text row instead of VOLA's own belt/rank visual language.
 *
 * There was no test file for this component before this ticket: its only
 * coverage was indirect, through `youScreen.test.tsx`'s stub. That stub
 * exists specifically so You's own tests don't have to know how the belt
 * renders — which means the belt's own behaviour needs a home of its own,
 * and this is genuinely new coverage rather than a rewrite of existing
 * coverage (per this repo's testing discipline).
 *
 * Three properties, and each is a real acceptance criterion rather than an
 * incidental detail:
 *
 *  - **The empty state is reachable and still opens `/bjj`** — the ticket
 *    changed how "no rank yet" looks, and a redesign that quietly drops the
 *    only way to add a first promotion would be a regression dressed as a
 *    fix.
 *  - **The belt render is the actual first belt (white, no stripes), not a
 *    generic icon.** Hidden from assistive tech deliberately (see the
 *    component's own doc comment), so this is asserted with
 *    `includeHiddenElements` — the same option `youScreen.test.tsx` already
 *    uses for this codebase's other deliberately-hidden decorative renders.
 *  - **No colour is asserted for a rank nobody has.** The real masthead below
 *    tints its glass wash with `activeBeltAccent`; the empty state must not,
 *    because a colour here would claim a rank that does not exist.
 */

jest.setTimeout(30_000);

const mockGetToken = async () => 'token';
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockGetToken,
}));

const mockGetStanding = jest.fn((..._a: unknown[]): Promise<Standing> =>
  Promise.resolve({ current: null, time_at_current_days: null, promotions: [] }),
);
// Spread the real module — `describeTimeAtBelt`, `awardingPromotion` and
// `formatAwardDate` are only reached on the RANKED branch, not the empty one
// this file is about, but listing exports by hand is how a helper this file
// never touches arrives as `undefined` and reads as a rendering bug instead
// of an incomplete mock.
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  getStanding: (...a: unknown[]) => mockGetStanding(...a),
}));

// Same shape as `roadmapEntryPoints.test.tsx`'s `expo-router` mock: fires on
// mount, and `mockPush` is a STABLE spy so the instance the component called
// is the instance the test holds.
const mockUseCallback = useCallback;
const mockUseEffect = useEffect;
const mockUseRef = useRef;
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const cleanup = mockUseRef<(() => void) | void>(undefined);
    const run = mockUseCallback(() => {
      if (typeof cleanup.current === 'function') cleanup.current();
      cleanup.current = cb();
    }, [cb]);
    mockUseEffect(run, [run]);
  },
}));

beforeEach(() => {
  mockGetStanding
    .mockReset()
    .mockResolvedValue({ current: null, time_at_current_days: null, promotions: [] });
  mockPush.mockClear();
});

describe('the belt-themed "no rank yet" state', () => {
  it('renders the empty card and invites the first promotion', async () => {
    render(<BjjRankHeader getToken={mockGetToken} />);

    const card = await screen.findByTestId('bjj-rank-empty');
    expect(card.props.accessibilityLabel).toBe('Add your first promotion');
    expect(screen.getByText('No rank yet')).toBeTruthy();
  });

  it('still opens /bjj on press — the redesign must not lose the only way in', async () => {
    render(<BjjRankHeader getToken={mockGetToken} />);

    const card = await screen.findByTestId('bjj-rank-empty');
    fireEvent.press(card);
    expect(mockPush).toHaveBeenCalledWith('/bjj');
  });

  it('draws the actual first belt — white, no stripes — not a generic icon', async () => {
    render(<BjjRankHeader getToken={mockGetToken} />);

    await screen.findByTestId('bjj-rank-empty');
    // Hidden from assistive tech deliberately (the card's own label already
    // says what tapping it does) — `includeHiddenElements` is what
    // `youScreen.test.tsx` already reaches for to see this codebase's other
    // hidden decorative renders.
    expect(
      screen.getByLabelText('White belt', { includeHiddenElements: true }),
    ).toBeTruthy();
  });
});
