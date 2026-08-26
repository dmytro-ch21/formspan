import { render, screen } from '@testing-library/react-native';

import { ProgressRing } from '../ui/ProgressRing';
import { TrainingCard, TRAINING_WINDOW_DAYS } from '../today/MiniCards';

/**
 * The ring's centre label, and the device bug that produced this file.
 *
 * #584 item 4, walked on a real phone: the TRAINING card on Today appeared to
 * render **two numbers on top of each other**, with the legible fragments
 * `78.57`, `4285` and `71428.5`. It is one number. Today passes
 * `days / 28 * 100`, and 22 days of 28 is `78.57142857142857`, which wraps onto
 * three lines inside a 54pt circle.
 *
 * That is worth a test rather than a one-character fix, for the reason the
 * component's own note gives: **every other caller happened to pass an
 * integer**, so the ring looked correct for months and the defect belonged to
 * whichever call site first did arithmetic. The rounding is in the ring now, so
 * the next caller cannot reintroduce it — and these assert both halves, the
 * value and the single line, because rounding alone still allows a future
 * `1000%` to wrap.
 */

it('rounds a repeating percentage instead of rendering all its digits', () => {
  render(
    <ProgressRing
      percent={(22 / TRAINING_WINDOW_DAYS) * 100}
      color="#B8FF2C"
      label="Trained on 22 of the last 28 days"
      testID="ring"
    />,
  );

  expect(screen.getByText('79%')).toBeTruthy();
  // The exact string the device showed, and the two fragments it broke into.
  expect(screen.queryByText('78.57142857142857%')).toBeNull();
  expect(screen.queryByText(/78\.57/)).toBeNull();
});

it('keeps the label on one line, so no value can ever stack again', () => {
  render(<ProgressRing percent={78.57142857142857} color="#B8FF2C" label="x" testID="ring" />);
  // Rounding fixes today's value; this is what stops the CLASS coming back —
  // a future caller passing 1000 would round cleanly and still wrap.
  expect(screen.getByText('79%').props.numberOfLines).toBe(1);
});

it('still distinguishes nothing-to-report from zero', () => {
  // `null` is not 0%: a window with nothing counted at all is not a score of
  // zero, and this is the pre-existing rule the rounding must not disturb.
  render(<ProgressRing percent={null} color="#B8FF2C" label="x" testID="ring" />);
  expect(screen.getByText('—')).toBeTruthy();
  expect(screen.queryByText('0%')).toBeNull();
});

it('clamps rather than overflowing when a caller passes more than 100', () => {
  render(<ProgressRing percent={140} color="#B8FF2C" label="x" testID="ring" />);
  expect(screen.getByText('100%')).toBeTruthy();
});

describe('the Training card that surfaced it', () => {
  it('renders one legible percentage for the exact device figures', () => {
    // 29 sessions on 22 days in 28 — the numbers on the screenshot.
    render(<TrainingCard training={{ sessions: 29, days: 22 }} onPress={() => {}} />);

    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByText('on 22 days')).toBeTruthy();
    expect(screen.getByText('79%')).toBeTruthy();
    expect(screen.queryByText(/78\.57/)).toBeNull();
  });

  it('draws no ring at all when nothing was logged', () => {
    // Pre-existing rule, asserted here because the change above touches the
    // only text the ring renders: an empty window drew a ring labelled `0%`,
    // which is a zero rendered as a score.
    render(<TrainingCard training={{ sessions: 0, days: 0 }} onPress={() => {}} />);

    expect(screen.queryByTestId('training-ring')).toBeNull();
    expect(screen.getByText(`Nothing logged in the last ${TRAINING_WINDOW_DAYS} days`)).toBeTruthy();
  });
});
