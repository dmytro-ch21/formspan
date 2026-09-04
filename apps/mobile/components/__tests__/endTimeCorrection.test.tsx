import { fireEvent, render, screen } from '@testing-library/react-native';

import { EndTimeCorrection } from '../EndTimeCorrection';

/**
 * N487/#848: this is the whole fix, so the arithmetic gets its own test
 * rather than trusting the two screens that wire it in. The property that
 * matters is that "1h ago" really is `now - 60 minutes` and not `value - 60
 * minutes` — a session already corrected once must not have a second "1h
 * ago" tap compound against the FIRST correction rather than restate it
 * against the real world. See the component's own comment on why `now` and
 * `value` are separate props.
 */

const NOW = new Date(2026, 7, 20, 21, 30, 0); // 21:30 local
const onChange = jest.fn();

beforeEach(() => {
  onChange.mockClear();
});

describe('the collapsed row', () => {
  it('shows the current value, not "now"', () => {
    render(<EndTimeCorrection value={new Date(2026, 7, 20, 19, 0, 0)} now={() => NOW} onChange={onChange} testID="et" />);
    expect(screen.getByTestId('et-value')).toHaveTextContent('7:00 PM');
  });
});

describe('quick offset chips', () => {
  it('"Just now" sets the real now, regardless of the current value', () => {
    render(<EndTimeCorrection value={new Date(2026, 7, 20, 15, 0, 0)} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-offset-0'));
    expect(onChange).toHaveBeenCalledWith(NOW);
  });

  it('"1h ago" subtracts from NOW, not from the value already showing', () => {
    // The value already carries an earlier correction (6pm) — a naive
    // implementation that offsets `value` would land on 5pm. The real bug
    // this guards: an athlete opens the sheet twice, taps "1h ago" both
    // times, and gets 1h ago instead of 2h ago compounding underneath them.
    render(<EndTimeCorrection value={new Date(2026, 7, 20, 18, 0, 0)} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-offset-60'));
    expect(onChange).toHaveBeenCalledWith(new Date(NOW.getTime() - 60 * 60_000));
  });

  it('"2h ago" and "3h ago" both compute off NOW', () => {
    render(<EndTimeCorrection value={NOW} now={() => NOW} onChange={onChange} testID="et" />);

    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-offset-120'));
    expect(onChange).toHaveBeenLastCalledWith(new Date(NOW.getTime() - 120 * 60_000));

    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-offset-180'));
    expect(onChange).toHaveBeenLastCalledWith(new Date(NOW.getTime() - 180 * 60_000));
  });

  it('closes the sheet after a chip is tapped', () => {
    render(<EndTimeCorrection value={NOW} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    expect(screen.getByTestId('et-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('et-offset-30'));
    // `Modal` with `visible={false}` renders no children at all under
    // react-test-renderer, so absence here IS the closed state, not merely
    // evidence of it.
    expect(screen.queryByTestId('et-sheet')).toBeNull();
  });
});

describe('fine-tune nudges', () => {
  it('nudge the DRAFT, not the committed value, until Save is pressed', () => {
    render(<EndTimeCorrection value={NOW} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));

    fireEvent.press(screen.getByTestId('et-nudge-back'));
    fireEvent.press(screen.getByTestId('et-nudge-back'));
    // Nudging alone must not commit — Cancel (or leaving it) has to be a
    // real discard, not a preview of an already-applied change.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('et-save'));
    expect(onChange).toHaveBeenCalledWith(new Date(NOW.getTime() - 30 * 60_000));
  });

  it('cancel discards nudges entirely', () => {
    render(<EndTimeCorrection value={NOW} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-nudge-forward'));
    fireEvent.press(screen.getByTestId('et-cancel'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reseeds the draft from the current value each time the sheet opens', () => {
    const { rerender } = render(
      <EndTimeCorrection value={new Date(2026, 7, 20, 10, 0, 0)} now={() => NOW} onChange={onChange} testID="et" />,
    );
    fireEvent.press(screen.getByTestId('et-row'));
    expect(screen.getByTestId('et-draft-value')).toHaveTextContent('10:00 AM');
    fireEvent.press(screen.getByTestId('et-cancel'));

    // The screen behind it applied a different correction meanwhile (e.g. a
    // quick chip from a previous visit) — the sheet must pick that up fresh,
    // not keep showing the stale draft from the first open.
    rerender(<EndTimeCorrection value={new Date(2026, 7, 20, 14, 0, 0)} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    expect(screen.getByTestId('et-draft-value')).toHaveTextContent('2:00 PM');
  });
});
