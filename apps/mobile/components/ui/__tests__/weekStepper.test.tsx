import { render, screen } from '@testing-library/react-native';

import { WeekStepper, type WeekStepperDay } from '../WeekStepper';

/**
 * `WeekStepper` — the reusable week-at-a-glance row (N510).
 *
 * Covers what the ticket's acceptance criteria actually asks for: the four
 * states render distinguishably (a rest day gets the moon glyph in place of
 * its number, not a number), the component takes plain day-state data rather
 * than anything screen-specific, and the optional week label is genuinely
 * optional.
 */

const DAYS: WeekStepperDay[] = [
  { key: '2026-08-03', number: 3, state: 'done', label: 'Monday, 3 August' },
  { key: '2026-08-04', number: 4, state: 'current', label: 'Tuesday, 4 August' },
  { key: '2026-08-05', number: 5, state: 'rest', label: 'Wednesday, 5 August' },
  { key: '2026-08-06', number: 6, state: 'upcoming', label: 'Thursday, 6 August' },
];

describe('WeekStepper', () => {
  it('renders one marker per day, each reachable by its own testID', () => {
    render(<WeekStepper days={DAYS} testID="stepper" />);
    for (const d of DAYS) {
      expect(screen.getByTestId(`week-stepper-day-${d.key}`)).toBeTruthy();
    }
  });

  it('draws the day number for done, current and upcoming days', () => {
    render(<WeekStepper days={DAYS} testID="stepper" />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('draws no number for a rest day — the moon glyph stands in for it', () => {
    render(<WeekStepper days={DAYS} testID="stepper" />);
    // "5" would collide with nothing else here, so its absence is a direct
    // assertion that the rest day did not fall back to rendering its number.
    expect(screen.queryByText('5')).toBeNull();
  });

  it('speaks each day’s own state to a screen reader, not a shared label', () => {
    render(<WeekStepper days={DAYS} testID="stepper" />);
    expect(screen.getByTestId('week-stepper-day-2026-08-03').props.accessibilityLabel).toBe(
      'Monday, 3 August, past',
    );
    expect(screen.getByTestId('week-stepper-day-2026-08-04').props.accessibilityLabel).toBe(
      'Tuesday, 4 August, today',
    );
    expect(screen.getByTestId('week-stepper-day-2026-08-05').props.accessibilityLabel).toBe(
      'Wednesday, 5 August, rest day',
    );
    expect(screen.getByTestId('week-stepper-day-2026-08-06').props.accessibilityLabel).toBe(
      'Thursday, 6 August, still to come',
    );
  });

  it('renders no week label when none is given — the caller decides', () => {
    render(<WeekStepper days={DAYS} testID="stepper" />);
    expect(screen.queryByText('W1')).toBeNull();
  });

  it('renders the week label when given', () => {
    render(<WeekStepper days={DAYS} weekLabel="W1" testID="stepper" />);
    expect(screen.getByText('W1')).toBeTruthy();
  });

  it('takes plain day-state data — nothing here is hardcoded to one screen’s shape', () => {
    // A second, differently-shaped week (a 3-day program stub, non-calendar
    // keys) renders exactly the same way. This is the "not hardcoded to one
    // screen's data shape" acceptance criterion, pinned directly.
    const program: WeekStepperDay[] = [
      { key: 'd1', number: 1, state: 'done', label: 'Day 1' },
      { key: 'd2', number: 2, state: 'current', label: 'Day 2' },
      { key: 'd3', number: 3, state: 'rest', label: 'Day 3' },
    ];
    render(<WeekStepper days={program} testID="program" />);
    expect(screen.getByTestId('week-stepper-day-d2').props.accessibilityLabel).toBe(
      'Day 2, today',
    );
  });
});
