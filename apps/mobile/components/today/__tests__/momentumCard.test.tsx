import { render, within } from '@testing-library/react-native';

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
