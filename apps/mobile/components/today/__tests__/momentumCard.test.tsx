import { AccessibilityInfo } from 'react-native';
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

function renderCard(isToday: boolean) {
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
  it('reads "See today\'s food" on today, with a real target set', () => {
    const screen = renderCard(true);
    const link = screen.getByTestId('today-open-food');
    expect(within(link).getByText("See today's food")).toBeTruthy();
    expect(within(link).queryByText('See logged food')).toBeNull();
  });

  it('reads "See logged food" on a browsed day — the visible text, not just the a11y label', () => {
    // ac-verifier's finding on the review pass: the a11y-label fix alone left
    // the ON-SCREEN string still saying "today's food" on a browsed day. A
    // sighted athlete would see a MOMENTUM title and a link underneath still
    // claiming "today's food" — the exact overclaim this ticket removes.
    const screen = renderCard(false);
    const link = screen.getByTestId('today-open-food');
    expect(within(link).getByText('See logged food')).toBeTruthy();
    expect(within(link).queryByText("See today's food")).toBeNull();
  });

  it('keeps the accessibility label and the visible text in agreement on both days', () => {
    const today = renderCard(true);
    const todayLink = today.getByTestId('today-open-food');
    expect(todayLink.props.accessibilityLabel).toBe("Open today's food log");

    const browsed = renderCard(false);
    const browsedLink = browsed.getByTestId('today-open-food');
    expect(browsedLink.props.accessibilityLabel).toBe('Open food log');
  });
});

describe('MomentumCard — the rings do not carry a previous day\'s fill (W15, #703)', () => {
  // `index.tsx` keys `<MomentumCard key={on} .../>` on the browsed day, for
  // exactly the reason this test pins: `Ring`'s sweep animation lives in a
  // `useState(() => new Animated.Value(0))` that only re-initialises on a
  // fresh mount. `Host` below reproduces that exact wiring — a `key` prop
  // conditioned on which day is showing — the same shape `index.tsx` uses, so
  // this protects the mechanism the real fix depends on. It does not exercise
  // `index.tsx`'s own line directly (rendering the whole screen hits the same
  // wall `todayScreen.test.tsx`'s own comments describe — `listTargets`
  // mocked to `[]` never reaches a real target), which is what this ticket's
  // own `NEEDS HUMAN EVIDENCE` device check is for.
  //
  // Reduce Motion is forced OFF so the ring genuinely animates over 620ms
  // rather than snapping instantly via `setValue` — under Reduce Motion BOTH
  // the buggy and fixed paths converge to the identical final value (the
  // `useEffect`'s deps retarget correctly either way), so the bug is only
  // observable mid-transition, which is where an athlete actually sees it.
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

  /** The kcal ring's current `strokeDashoffset` — higher means emptier. */
  function kcalOffset(tree: unknown): number | undefined {
    function walk(node: any): number | undefined {
      if (!node) return undefined;
      if (
        typeof node.type === 'string' &&
        node.type.toLowerCase().includes('circle') &&
        node.props.strokeDashoffset !== undefined
      ) {
        return node.props.strokeDashoffset;
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          const found = walk(child);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    }
    return walk(tree);
  }

  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  });

  it('a keyed remount reads far closer to empty, soon after switching, than the same key does', async () => {
    jest.useFakeTimers();
    try {
      // SAME key across the switch — the pre-fix shape: no remount, so `base`
      // animates smoothly FROM its current (filled) value.
      const sameKey = render(<Host day="2026-08-20" eaten={FULL} />);
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        jest.advanceTimersByTime(700);
      });
      sameKey.rerender(<Host day="2026-08-20" eaten={NOTHING} />);
      act(() => {
        jest.advanceTimersByTime(50);
      });
      const sameKeySoon = kcalOffset(sameKey.toJSON());

      // NEW key across the switch — the actual fix: a fresh mount, so `base`
      // starts over at 0 and animates from empty toward empty.
      const newKey = render(<Host day="2026-08-20" eaten={FULL} />);
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        jest.advanceTimersByTime(700);
      });
      newKey.rerender(<Host day="2026-08-21" eaten={NOTHING} />);
      act(() => {
        jest.advanceTimersByTime(50);
      });
      const newKeySoon = kcalOffset(newKey.toJSON());

      expect(sameKeySoon).toBeDefined();
      expect(newKeySoon).toBeDefined();
      // The keyed remount must read meaningfully closer to empty than the
      // same-key path does, 50ms into a 620ms transition — this is the
      // "still shows filled after browsing back to an empty today" symptom,
      // caught at the moment it is visible rather than after it resolves.
      expect(newKeySoon! - sameKeySoon!).toBeGreaterThan(150);
    } finally {
      jest.useRealTimers();
    }
  });
});
