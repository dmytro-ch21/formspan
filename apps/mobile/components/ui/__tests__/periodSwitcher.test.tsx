import { render, screen } from '@testing-library/react-native';

import { PeriodSwitcher } from '../PeriodSwitcher';

/**
 * `subLabel` — the date folded into the pill (N179/#584 follow-up).
 *
 * The bug: Today rendered `TODAY` in this pill and then repeated the full
 * date directly underneath it in a standalone `<Text>` — one fact, twice.
 * `subLabel` folds the second line into the same pill instead.
 *
 * **What matters here is that every OTHER caller is unaffected.** This
 * component's own doc comment calls it shared across the app ("the week on
 * Plan, the month behind it, the day on Today"), so the coverage that counts
 * is: omit `subLabel` and nothing changes, pass it and both lines render and
 * are both spoken.
 */
describe('PeriodSwitcher — subLabel', () => {
  const noop = () => {};

  it('renders nothing extra when subLabel is omitted — Plan and any other caller is unaffected', () => {
    render(
      <PeriodSwitcher
        label="THIS WEEK"
        onPrev={noop}
        onNext={noop}
        prevLabel="Previous week"
        nextLabel="Next week"
        testID="switcher"
      />,
    );
    expect(screen.getByText('THIS WEEK')).toBeTruthy();
    // The accessible name is the label alone — no trailing comma, no second
    // fact appended for a caller that never passed one.
    expect(screen.getByTestId('switcher-label').props.accessibilityLabel).toBe('THIS WEEK');
  });

  it('renders subLabel as a second line, smaller, under the main label', () => {
    render(
      <PeriodSwitcher
        label="TODAY"
        subLabel="Wednesday, 26 August"
        onPrev={noop}
        onNext={noop}
        prevLabel="Previous day"
        nextLabel="Next day"
        testID="switcher"
      />,
    );
    expect(screen.getByText('TODAY')).toBeTruthy();
    expect(screen.getByText('Wednesday, 26 August')).toBeTruthy();
  });

  it('speaks both lines together, not just the main label', () => {
    // A screen reader has to say the date too — it is not decoration, it is
    // the fact the standalone `<Text>` used to carry on its own.
    render(
      <PeriodSwitcher
        label="TODAY"
        subLabel="Wednesday, 26 August"
        onPrev={noop}
        onNext={noop}
        prevLabel="Previous day"
        nextLabel="Next day"
        testID="switcher"
      />,
    );
    expect(screen.getByTestId('switcher-label').props.accessibilityLabel).toBe(
      'TODAY, Wednesday, 26 August',
    );
  });

  it('still leads the accessible name with the sentence form when both onPress and pressLabel are given', () => {
    // WCAG 2.5.3 — the visible text leads, but a pressable readout with a
    // destination still needs to say what pressing it does, and now with the
    // date folded in too.
    render(
      <PeriodSwitcher
        label="FRI 28 AUG"
        subLabel="Friday, 28 August"
        onPrev={noop}
        onNext={noop}
        onPress={noop}
        pressLabel="Back to today"
        prevLabel="Previous day"
        nextLabel="Next day"
        testID="switcher"
      />,
    );
    expect(screen.getByTestId('switcher-label').props.accessibilityLabel).toBe(
      'FRI 28 AUG, Friday, 28 August. Back to today',
    );
  });
});
