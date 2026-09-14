import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';

import { ProgressCard, type ProgressCardProps } from '../ProgressCard';
import { TOUCH_MIN } from '@/constants/Spacing';
import type { Checkin } from '@/lib/body';

/**
 * W26 (#1230) — the one-tap weigh-in, back on Today's Progress card.
 *
 * N108 rebuilt this card as one `Pressable` opening `/goals/trend`, and
 * logging a weight became two taps through another screen. The card now has
 * TWO buttons, side by side rather than one inside the other: the body opens
 * the trend, and a "Record weight" row opens today's check-in.
 *
 * `todayScreen.test.tsx` covers the WIRING — which route each press pushes,
 * dated by the device's local day. This file covers what belongs to the card:
 * the action exists in every state the card can be in, the two presses do not
 * reach each other, and VoiceOver hears two buttons rather than one.
 *
 * Each state test also asserts the state itself (`Checking…`, the empty copy,
 * a weight figure). Without that, a fixture that silently rendered the wrong
 * state would still find the button and prove nothing about the state named.
 */

const TODAY = '2026-08-30';

function w(measured_on: string, weight_kg: number): Checkin {
  return {
    user_id: 'u1',
    measured_on,
    weight_kg,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    upper_arm_cm: null,
    forearm_cm: null,
    measured_side: 'right',
    notes: '',
  };
}

/** A week of readings ending today — enough for a trend and a line. */
const WEEK = [
  w('2026-08-24', 94.0),
  w('2026-08-25', 93.8),
  w('2026-08-26', 93.9),
  w('2026-08-27', 93.5),
  w('2026-08-28', 93.4),
  w('2026-08-29', 93.1),
  w('2026-08-30', 92.9),
];

const onOpen = jest.fn();
const onRecordWeight = jest.fn();

beforeEach(() => {
  onOpen.mockClear();
  onRecordWeight.mockClear();
});

async function draw(over: Partial<ProgressCardProps> = {}) {
  await render(
    <ProgressCard
      checkins={WEEK}
      phase={null}
      today={TODAY}
      units="metric"
      unitsReady
      loaded
      onOpen={onOpen}
      onRecordWeight={onRecordWeight}
      testID="today-progress"
      {...over}
    />,
  );
}

const record = () => screen.getByRole('button', { name: 'Record weight' });

describe('Record weight is on the card in every state', () => {
  it('while the check-ins are still loading ("Checking…")', async () => {
    await draw({ checkins: [], loaded: false });
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(record()).toBeTruthy();
  });

  it('while the unit preference is still loading ("Checking…")', async () => {
    await draw({ unitsReady: false });
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(record()).toBeTruthy();
  });

  it('in the empty state — the one that tells the athlete to weigh in', async () => {
    await draw({ checkins: [] });
    expect(screen.getByTestId('progress-empty')).toBeTruthy();
    expect(record()).toBeTruthy();
  });

  it('with a populated trend', async () => {
    await draw();
    expect(screen.queryByTestId('progress-empty')).toBeNull();
    expect(screen.queryByText('Checking…')).toBeNull();
    // A weight figure is on the card: the populated branch really rendered.
    expect(screen.getByLabelText(/^Progress\. \d/)).toBeTruthy();
    expect(record()).toBeTruthy();
  });
});

describe('two presses, and neither reaches the other', () => {
  it('pressing Record weight records a weight and does not open the trend', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('today-progress-record'));
    expect(onRecordWeight).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('pressing the rest of the card opens the trend and does not record a weight', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('today-progress'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRecordWeight).not.toHaveBeenCalled();
  });

  it('works from the empty state too, where it is the only way to start a trend', async () => {
    await draw({ checkins: [] });
    await fireEvent.press(record());
    expect(onRecordWeight).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceOver hears two buttons, each with its own label', () => {
  it('exposes exactly two buttons: the progress summary and Record weight', async () => {
    await draw();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    const labels = buttons.map((b) => b.props.accessibilityLabel as string);
    expect(labels).toContain('Record weight');
    expect(labels.filter((l) => /^Progress\./.test(l))).toHaveLength(1);
  });

  it('does not nest the action inside the card body, where it would be swallowed', async () => {
    await draw();
    const body = screen.getByTestId('today-progress');
    // A button inside an accessible Pressable is grouped into it: VoiceOver
    // reads the outer label and the inner control cannot be focused.
    expect(within(body).queryByTestId('today-progress-record')).toBeNull();
    expect(body.props.accessibilityLabel).not.toMatch(/record/i);
  });

  it('keeps the two labels distinct in the empty and loading states', async () => {
    await draw({ checkins: [], loaded: false });
    const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(['Progress, still loading', 'Record weight']);
  });
});

describe('Record weight is at least a 44pt target', () => {
  it('reaches the floor by its own height, with no slop to overlap the card above', async () => {
    await draw();
    const action = screen.getByTestId('today-progress-record');
    const style = StyleSheet.flatten(action.props.style);
    const slop = (action.props.hitSlop as number | undefined) ?? 0;
    expect(style.minHeight + 2 * slop).toBeGreaterThanOrEqual(TOUCH_MIN);
  });
});
