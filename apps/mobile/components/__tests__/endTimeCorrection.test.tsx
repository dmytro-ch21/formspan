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

/**
 * N487 review finding: on the live-session Finish flow, nothing stopped a
 * mis-tapped chip/nudge from landing `ended_at` before `session.started_at`
 * — a negative duration `minutesBetween` (`bjj/session/[id].tsx`) silently
 * reads as zero, and the bad value still reached the backend and fed the
 * exact HR join this ticket exists to fix. `notBefore` is the floor;
 * `session/[id].tsx` passes the session's own `started_at`.
 *
 * `NOW` is 21:30; `FLOOR` is 21:00 (30 minutes before it) throughout.
 */
describe('a floor via notBefore', () => {
  const FLOOR = new Date(2026, 7, 20, 21, 0, 0);

  it('disables a chip that would land before the floor, and it does nothing when tapped', () => {
    render(
      <EndTimeCorrection value={NOW} now={() => NOW} notBefore={FLOOR} onChange={onChange} testID="et" />,
    );
    fireEvent.press(screen.getByTestId('et-row'));

    // "1h ago" = 20:30, before the 21:00 floor.
    const hourAgo = screen.getByTestId('et-offset-60');
    expect(hourAgo.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(hourAgo);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves a chip that lands exactly on the floor enabled', () => {
    render(
      <EndTimeCorrection value={NOW} now={() => NOW} notBefore={FLOOR} onChange={onChange} testID="et" />,
    );
    fireEvent.press(screen.getByTestId('et-row'));

    // "30m ago" = 21:00, exactly the floor — not BEFORE it.
    const halfHourAgo = screen.getByTestId('et-offset-30');
    expect(halfHourAgo.props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(halfHourAgo);
    expect(onChange).toHaveBeenCalledWith(FLOOR);
  });

  it('nudging earlier never crosses the floor, no matter how many taps', () => {
    render(
      <EndTimeCorrection value={NOW} now={() => NOW} notBefore={FLOOR} onChange={onChange} testID="et" />,
    );
    fireEvent.press(screen.getByTestId('et-row'));

    // Five taps of -15m from 21:30 would reach 20:15 unclamped — well past
    // the 21:00 floor.
    for (let i = 0; i < 5; i++) {
      fireEvent.press(screen.getByTestId('et-nudge-back'));
    }
    expect(screen.getByTestId('et-draft-value')).toHaveTextContent('9:00 PM');

    fireEvent.press(screen.getByTestId('et-save'));
    expect(onChange).toHaveBeenCalledWith(FLOOR);
  });

  it('save clamps even a value seeded below the floor (the caller already had an invalid one)', () => {
    const belowFloor = new Date(2026, 7, 20, 20, 0, 0); // 20:00, before the 21:00 floor
    render(
      <EndTimeCorrection
        value={belowFloor}
        now={() => NOW}
        notBefore={FLOOR}
        onChange={onChange}
        testID="et"
      />,
    );
    fireEvent.press(screen.getByTestId('et-row'));
    // No nudge at all — Save alone must still clamp.
    fireEvent.press(screen.getByTestId('et-save'));
    expect(onChange).toHaveBeenCalledWith(FLOOR);
  });

  it('never disables the "later" nudge — only earlier can cross a floor', () => {
    render(
      <EndTimeCorrection value={NOW} now={() => NOW} notBefore={FLOOR} onChange={onChange} testID="et" />,
    );
    fireEvent.press(screen.getByTestId('et-row'));
    const forward = screen.getByTestId('et-nudge-forward');
    expect(forward.props.accessibilityState?.disabled).not.toBe(true);
  });

  it('with no notBefore prop, nothing is disabled and offsets are never clamped', () => {
    render(<EndTimeCorrection value={NOW} now={() => NOW} onChange={onChange} testID="et" />);
    fireEvent.press(screen.getByTestId('et-row'));
    fireEvent.press(screen.getByTestId('et-offset-240')); // 4h ago — well past FLOOR, but no floor set
    expect(onChange).toHaveBeenCalledWith(new Date(NOW.getTime() - 240 * 60_000));
  });
});
