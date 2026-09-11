import { AccessibilityInfo, StyleSheet } from 'react-native';
import { act, render, within } from '@testing-library/react-native';

import { MomentumCard } from '../MomentumCard';
import type { EatenView, TargetView } from '@/lib/nutrition';

/**
 * W13 (#693) direct-component coverage.
 *
 * `todayScreen.test.tsx` mocks `listTargets` to always resolve `[]`, so the
 * whole integration suite renders `view.state === 'none'` and never reaches
 * the `kcal && kcal.percent !== null` branch this file's "See today's food" /
 * "See logged food" text lives behind — a test added there would silently
 * exercise the wrong branch. Rendering `MomentumCard` directly, with a real
 * target, is what actually reaches it.
 */

const EATEN: EatenView = {
  state: 'ready',
  rows: [],
  totals: {
    kcal: 1200,
    protein_g: 90,
    carb_g: 100,
    fat_g: 40,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
  },
};

const TARGET: TargetView = {
  state: 'set',
  target: {
    effective_on: '2026-08-27',
    kcal: 2000,
    protein_g: 150,
    carb_g: 200,
    fat_g: 70,
    fibre_g: null,
  },
};

async function renderCard(isToday: boolean) {
  return render(
    <MomentumCard
      eaten={EATEN}
      view={TARGET}
      rings={['kcal', 'protein']}
      isToday={isToday}
      quickAdd={[]}
      onLog={() => {}}
      onQuickAdd={() => {}}
      onOpenDay={() => {}}
      onConfigureRings={() => {}}
      testID="momentum"
    />,
  );
}

describe('MomentumCard — the day-open link text agrees with the title (W13, #693)', () => {
  it('reads "See today\'s food" on today, with a real target set', async () => {
    const screen = await renderCard(true);
    const link = screen.getByTestId('today-open-food');
    expect(within(link).getByText("See today's food")).toBeTruthy();
    expect(within(link).queryByText('See logged food')).toBeNull();
  });

  it('reads "See logged food" on a browsed day — the visible text, not just the a11y label', async () => {
    // ac-verifier's finding on the review pass: the a11y-label fix alone left
    // the ON-SCREEN string still saying "today's food" on a browsed day. A
    // sighted athlete would see a MOMENTUM title and a link underneath still
    // claiming "today's food" — the exact overclaim this ticket removes.
    const screen = await renderCard(false);
    const link = screen.getByTestId('today-open-food');
    expect(within(link).getByText('See logged food')).toBeTruthy();
    expect(within(link).queryByText("See today's food")).toBeNull();
  });

  it('keeps the accessibility label and the visible text in agreement on both days', async () => {
    const today = await renderCard(true);
    const todayLink = today.getByTestId('today-open-food');
    expect(todayLink.props.accessibilityLabel).toBe("Open today's food log");

    const browsed = await renderCard(false);
    const browsedLink = browsed.getByTestId('today-open-food');
    expect(browsedLink.props.accessibilityLabel).toBe('Open food log');
  });
});

describe('MomentumCard — the rings do not carry a previous day\'s fill (W15, #703)', () => {
  // `index.tsx` keys `<MomentumCard key={on} .../>` on the browsed day, for
  // exactly the reason this test pins: `Ring`'s sweep animation lives in a
  // per-fiber value that only re-initialises on a fresh mount. `Host` below
  // reproduces that exact wiring — a `key` prop conditioned on which day is
  // showing — the same shape `index.tsx` uses, so this protects the mechanism
  // the real fix depends on. It does not exercise `index.tsx`'s own line
  // directly (rendering the whole screen hits the same wall
  // `todayScreen.test.tsx`'s own comments describe — `listTargets` mocked to
  // `[]` never reaches a real target), which is what this ticket's own
  // `NEEDS HUMAN EVIDENCE` device check is for.
  //
  // ## F46/#1045 rewrote HOW this is checked, and not WHAT
  //
  // This used to sample the ring's `strokeDashoffset` 50ms into the 620ms
  // sweep, under `jest.useFakeTimers()`, and assert the remounted ring read
  // much closer to empty than the same-key one. That worked because core
  // `Animated` interpolates in JavaScript on a JS timer, which fake timers
  // drive. F46 moved the sweep onto Reanimated's UI runtime — where there is
  // no JS timer to advance, on a device or in jest — so the technique is gone
  // for good rather than temporarily unavailable. Inventing a frame clock in
  // the Reanimated mock to keep the old assertion alive would be measuring
  // that invented clock, not the component.
  //
  // What survives is the mechanism itself, asserted one step earlier and
  // without needing a clock at all: a day switch must MOUNT A FRESH `Ring`,
  // and a fresh mount re-runs `useReducedMotion`'s effect. So the number of
  // times the OS is asked about Reduce Motion is a direct, exact count of how
  // many times `Ring` has been constructed. Same key across a day switch: the
  // fiber is reused, the value carries the previous day's fill, and the OS is
  // never asked again. New key: a fresh fiber, a fresh zero, a fresh ask.
  //
  // The mid-switch APPEARANCE — a ring that visibly still shows yesterday for
  // a moment — is no longer checkable here and is a device-evidence criterion
  // on #1045.
  //
  // Reduce Motion is forced OFF so the animated branch is the one taken; the
  // reduced branch snaps via a direct write and would construct no animation
  // at all.
  const FULL: EatenView = {
    state: 'ready',
    rows: [],
    totals: {
      kcal: 1200, protein_g: 90, carb_g: 100, fat_g: 40, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    },
  };
  const NOTHING: EatenView = {
    state: 'ready',
    rows: [],
    totals: {
      kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null,
      saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null,
    },
  };

  function Host({ day, eaten }: { day: string; eaten: EatenView }) {
    return (
      <MomentumCard
        key={day}
        eaten={eaten}
        view={TARGET}
        rings={['kcal']}
        isToday
        quickAdd={[]}
        onLog={() => {}}
        onQuickAdd={() => {}}
        onOpenDay={() => {}}
        onConfigureRings={() => {}}
        testID="momentum"
      />
    );
  }

  /**
   * How many times the OS has been asked about Reduce Motion — i.e. how many
   * times a `Ring` has been constructed, since `useReducedMotion`'s effect
   * runs once per mount and this card draws exactly one ring.
   */
  let asks: jest.SpyInstance;

  beforeEach(() => {
    asks = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    // `jest.spyOn` hands back the EXISTING mock when one is already installed,
    // carrying every call the rest of this file has made through it — which is
    // how the count below read 10 rather than 1 the first time. Cleared rather
    // than reset: `mockClear` drops the calls and keeps the resolved value.
    asks.mockClear();
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  });

  it('the same key across a day switch reuses the ring, carrying its fill', async () => {
    const sameKey = await render(<Host day="2026-08-20" eaten={FULL} />);
    await act(async () => {});
    expect(asks).toHaveBeenCalledTimes(1);

    // The day's DATA changes but the key does not — the pre-fix shape.
    await sameKey.rerender(<Host day="2026-08-20" eaten={NOTHING} />);
    await act(async () => {});

    // No second construction: the same fiber, and therefore the same value,
    // still holding what yesterday swept it to.
    expect(asks).toHaveBeenCalledTimes(1);
  });

  it('a new key across a day switch remounts the ring, so its sweep restarts from empty', async () => {
    const newKey = await render(<Host day="2026-08-20" eaten={FULL} />);
    await act(async () => {});
    expect(asks).toHaveBeenCalledTimes(1);

    await newKey.rerender(<Host day="2026-08-21" eaten={NOTHING} />);
    await act(async () => {});

    // A second construction is the whole fix: a fresh `Ring`, a freshly
    // zeroed value, and a sweep that starts from empty rather than from the
    // previous day's fill.
    expect(asks).toHaveBeenCalledTimes(2);
  });
});

describe('MomentumCard — the headline figure sits on its own legibility plate (N443, #739)', () => {
  it('wraps the "left" figure in the plate, not directly on the ring', async () => {
    const screen = await renderCard(true);
    const plate = screen.getByTestId('today-centre-plate');
    // TARGET is 2000 kcal, EATEN totals 1200 — "800 left" is what should be
    // ON the plate. Asserting `within(plate)` rather than just `getByText`
    // pins that the text is a CHILD of the scrim, not a sibling drawn over
    // it — a regression that moved the plate beside the text instead of
    // behind it would still pass a bare `getByText`.
    expect(within(plate).getByText('800')).toBeTruthy();
    expect(within(plate).getByText('left')).toBeTruthy();
    // `within` only pins the HIERARCHY — a plate with no backgroundColor at
    // all (drawing nothing) would still pass both assertions above. Pin the
    // scrim itself: `vola.bg` (#080B12 → rgb(8,11,18)) at partial opacity,
    // not a new colour.
    const style = StyleSheet.flatten(plate.props.style);
    expect(style.backgroundColor).toBe('rgba(8,11,18,0.72)');
  });

  it('wraps the "eaten" figure in the plate when no target is set', async () => {
    const screen = await render(
      <MomentumCard
        eaten={EATEN}
        view={{ state: 'none' }}
        rings={['kcal', 'protein']}
        isToday
        quickAdd={[]}
        onLog={() => {}}
        onQuickAdd={() => {}}
        onOpenDay={() => {}}
        onConfigureRings={() => {}}
        testID="momentum"
      />,
    );
    const plate = screen.getByTestId('today-centre-plate');
    expect(within(plate).getByText('1,200')).toBeTruthy();
    expect(within(plate).getByText('eaten')).toBeTruthy();
  });

  // The THIRD branch `Centre` can take — `view.state === 'unknown'`, "we
  // could not check your target" rather than "you have none" — is its own
  // return statement wrapping its own `CentrePlate`. Covered separately so
  // an edit that unwraps just this one (the rarest of the three to hit on a
  // device) cannot stay green.
  it('wraps the "eaten" figure in the plate when the target check itself failed', async () => {
    const screen = await render(
      <MomentumCard
        eaten={EATEN}
        view={{ state: 'unknown' }}
        rings={['kcal', 'protein']}
        isToday
        quickAdd={[]}
        onLog={() => {}}
        onQuickAdd={() => {}}
        onOpenDay={() => {}}
        onConfigureRings={() => {}}
        testID="momentum"
      />,
    );
    const plate = screen.getByTestId('today-centre-plate');
    expect(within(plate).getByText('1,200')).toBeTruthy();
    expect(within(plate).getByText('eaten')).toBeTruthy();
  });
});
