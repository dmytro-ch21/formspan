import { StyleSheet, View as RNView } from 'react-native';
import { configure, fireEvent, render, screen, within } from '@testing-library/react-native';

import { ScreenHeader, wordmarkFits } from '../ScreenHeader';

/**
 * The header stops overlapping its own wordmark.
 *
 * The bug: `ScreenHeader` publishes an `action` slot with no width contract
 * while drawing an 88pt wordmark centred across the same row. `you.tsx` passed
 * three text controls (~173pt), and on a 375pt device the word "Friends" sat
 * on the wordmark's tail. Separately, `justifyContent: 'space-between'` with
 * THREE flow children put `SyncChip` in the row's interior — the wordmark's
 * band — which is why it came and went with sync state.
 *
 * ## What each part of this file proves, precisely
 *
 * **The geometry table** is the real coverage, and it is exact: `wordmarkFits`
 * is pure, so every clause can be pinned and every mutation killed.
 *
 * **The wiring tests** prove that measurement reaches the decision and the
 * decision reaches the render. They do **not** prove `onLayout` is attached to
 * the right nodes — `onLayout` never fires under RNTL (there is no Yoga pass
 * producing frames), so the test synthesises the event on the nodes it chose.
 * A misplaced `onLayout` that this test also targeted would pass.
 *
 * **What nothing here can prove:** that "Settings" at 14pt/700 is ~55pt wide.
 * jest has no font metrics, so the device geometry — and therefore the 375pt
 * collision itself — is unverifiable in this suite. That is the argument for
 * measuring rather than computing: the fix has no width constant in it for a
 * test to ratify. A Simulator screenshot is the only real evidence.
 */

jest.setTimeout(30_000);
// RNTL's async utilities keep their own 1000ms budget, which `jest.setTimeout`
// does not raise — see the note in `app/__tests__/workoutDetailScreen.test.tsx`,
// where the module-graph cost blew through it on a cold cache.
configure({ asyncUtilTimeout: 10_000 });

const mockSyncState = {
  syncing: false,
  pending: 0,
  deferred: 0,
  lastSyncAt: null as string | null,
  lastError: null as string | null,
  online: true,
};
jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => mockSyncState,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

beforeEach(() => {
  mockSyncState.online = true;
  mockSyncState.pending = 0;
  mockSyncState.lastError = null;
});

describe('whether the wordmark fits', () => {
  /**
   * LITERAL widths, never the exported constants.
   *
   * Importing `WORDMARK_WIDTH`/`WORDMARK_MIN_GAP` and computing the
   * expectations from them would make this table agree with whatever those
   * constants say — it would restate the implementation rather than check it.
   * These numbers are the real ones: an 88pt mark needing 12pt of clearance on
   * a 353pt row, which is a 393pt device minus the header's 20pt padding.
   */

  it('says no to the case that actually shipped', () => {
    // You tab: title ~53, three actions ~173. The mark spans 132.5→220.5 and
    // the cluster starts at 180.
    expect(wordmarkFits({ row: 353, left: 53, right: 173 })).toBe(false);
  });

  it('says yes to the three tabs that never collided', () => {
    // Today/Plan/Library: title plus a chip at most. Without this the whole
    // table is satisfied by a constant `false`, which would hide the wordmark
    // everywhere and pass.
    expect(wordmarkFits({ row: 353, left: 68, right: 88 })).toBe(true);
  });

  it('checks the LEFT side too, not just the one that broke', () => {
    // A long title with almost nothing on the right. A right-only predicate
    // passes the shipped case above and misses this entirely — and this is the
    // direction a localised build fails in.
    expect(wordmarkFits({ row: 353, left: 200, right: 20 })).toBe(false);
  });

  it('treats the gap as clearance, not as a bonus', () => {
    // Exactly touching is a fail; 12pt clear is a pass. Delete `minGap` from
    // either clause and the first of these goes green.
    expect(wordmarkFits({ row: 353, left: 0, right: 132.5 })).toBe(false);
    expect(wordmarkFits({ row: 353, left: 0, right: 120.5 })).toBe(true);
    expect(wordmarkFits({ row: 353, left: 132.5, right: 0 })).toBe(false);
    expect(wordmarkFits({ row: 353, left: 120.5, right: 0 })).toBe(true);
  });

  it('is what the chip arriving takes away', () => {
    // The intermittent half of the bug, as numbers: the same actions fit until
    // the chip joins them in the cluster.
    expect(wordmarkFits({ row: 353, left: 53, right: 100 })).toBe(true);
    expect(wordmarkFits({ row: 353, left: 53, right: 200 })).toBe(false);
  });

  it('depends on the row it is centred in', () => {
    // Identical content, different row. A predicate ignoring `row` cannot
    // produce both of these.
    expect(wordmarkFits({ row: 353, left: 53, right: 100 })).toBe(true);
    expect(wordmarkFits({ row: 300, left: 53, right: 100 })).toBe(false);
    // Worth knowing, and the reason the You cluster had to move rather than
    // wait for a bigger phone: a 173pt cluster does NOT clear the mark at
    // 420pt either. It needs a ~458pt row, which is a tablet.
    expect(wordmarkFits({ row: 420, left: 53, right: 173 })).toBe(false);
    expect(wordmarkFits({ row: 480, left: 53, right: 173 })).toBe(true);
  });
});

/** `onLayout` never fires under jest, so the test plays it. */
function layout(node: Parameters<typeof fireEvent>[0], width: number) {
  fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 28 } } });
}

describe('the header itself', () => {
  it('shows the wordmark before anything has been measured', () => {
    // Optimistic on purpose: the three tabs that have always fitted must not
    // blink the mark out and back on every mount. The pre-measurement state is
    // exactly the old behaviour.
    render(<ScreenHeader title="Today" />);
    expect(screen.getByLabelText('VOLA')).toBeTruthy();
  });

  it('withdraws the wordmark once the widths prove it does not fit', () => {
    render(<ScreenHeader title="You" action={null} />);
    layout(screen.getByTestId('screen-header-row'), 353);
    layout(screen.getByTestId('screen-header-actions'), 173);
    // The title is measured last, so this is also the frame where `measured`
    // first becomes true.
    layout(screen.getByTestId('screen-header-row').children[0] as never, 53);
    expect(screen.queryByLabelText('VOLA')).toBeNull();
  });

  it('keeps it when the widths leave room', () => {
    // Without this arm, "hides after any layout at all" passes the test above.
    render(<ScreenHeader title="Today" />);
    layout(screen.getByTestId('screen-header-row'), 353);
    layout(screen.getByTestId('screen-header-actions'), 88);
    layout(screen.getByTestId('screen-header-row').children[0] as never, 68);
    expect(screen.getByLabelText('VOLA')).toBeTruthy();
  });

  it('keeps the chip and the action in ONE flow child', () => {
    // The subtle half of the fix. As siblings they made three flow children,
    // and `space-between` then places the middle one — the chip — inside the
    // wordmark's band. Containment is the meaningful assertion; asserting
    // `justifyContent: 'space-between'` would be a style constant checked
    // against itself, and with exactly two children it is unambiguous anyway.
    //
    // BOTH must be inside it. Passing `action={null}` — as this test first did
    // — proves only that the chip is grouped, so an implementation that kept
    // the chip in the cluster and rendered `{action}` as a third row child
    // passes while resurrecting half the bug.
    mockSyncState.online = false;
    render(<ScreenHeader title="You" action={<RNView testID="probe-action" />} />);
    const cluster = within(screen.getByTestId('screen-header-actions'));
    expect(cluster.getByTestId('sync-chip')).toBeTruthy();
    expect(cluster.getByTestId('probe-action')).toBeTruthy();
  });
});

/**
 * W10 — the rule marks the top of the scrolling region, and nothing else.
 *
 * The bug: `View` from `Themed` paints no background, so this header is
 * transparent and the screen's own ground shows through on both sides of the
 * scroll view's top edge. Content is therefore clipped **mid-glyph against an
 * identical colour**, with nothing marking where it stopped being drawn —
 * reported from a device as "scrolls on and on until the content disappears".
 *
 * **The predicate is not "is the header fixed?"** Seven callers, three
 * arrangements: the header IS the boundary (`goals`, `phase`); the header
 * scrolls away inside the scroll view (`index`, `food`, `you`); the header is
 * pinned above OTHER fixed chrome that owns the boundary (`workouts`'s scope
 * strip, which already draws its own rule; `library`'s search and chips). Only
 * the first draws. The first version of this fix conflated the first and third
 * and would have put a second seam 40pt above an existing one — review caught
 * it, this suite did not, which is why the third arrangement is named here.
 *
 * **What this test can and cannot prove.** It pins the decision, and either
 * mutation turns one arm red. It cannot prove the rule is VISIBLE, that it
 * lands on the scroll view's top edge, or that 1.23:1 is legible to anyone —
 * jest runs no Yoga pass and has no pixels.
 *
 * **The device half is answered by sampling pixels, not by looking**, and the
 * numbers are recorded on #484: on `Goals` at accessibility XXXL the device row
 * at exactly 150.0pt is `#1A2230` across 100% of the width, between two rows of
 * `#080B12`; at default text the row at 114.0pt is `#1A2230` across 82%, the
 * rest being the floating settings button that overlays the header; on `Plan`
 * the same scan returns 0%. `docs/testing/functional-scenarios.md` carries that
 * scan as a repeatable check alongside the per-screen script, and #496 tracks
 * whether 1.23:1 is enough for the reader who needs it most.
 *
 * BOTH arms are required. With only the first, "always draws" passes while
 * seaming five screens that have no boundary; with only the second, "never
 * draws" passes while leaving the reported bug exactly as it was.
 */
describe('the edge at the top of the scrolling region', () => {
  it('draws a rule when content scrolls under the header itself', () => {
    // `goals` and `phase`: the header's bottom edge IS the scroll view's top.
    render(<ScreenHeader title="Your target" />);
    expect(screen.getByTestId('screen-header')).toHaveStyle({
      borderBottomWidth: StyleSheet.hairlineWidth,
      // LITERAL, per this file's convention — `vola.lineSoft`. A token-based
      // assertion would silently follow a palette change, and at 1.23:1 (#496)
      // this is precisely the value worth making a human re-confirm. It must
      // stay equal to the tab bar's `borderTopColor` in `app/(tabs)/_layout.tsx`,
      // which is a route file and cannot be imported here.
      borderBottomColor: '#1A2230',
    });
  });

  it('draws none when nothing scrolls under the header', () => {
    // Two different reasons, one flag: the header scrolls away (`index`,
    // `food`, `you`), or fixed chrome below owns the boundary (`workouts`,
    // `library`). A rule in either case is a seam across nothing.
    render(<ScreenHeader title="Today" contentScrollsUnder={false} />);
    const header = screen.getByTestId('screen-header');
    expect(header).not.toHaveStyle({ borderBottomWidth: StyleSheet.hairlineWidth });
    expect(StyleSheet.flatten(header.props.style).borderBottomWidth).toBeUndefined();
  });
});
