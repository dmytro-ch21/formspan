import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { LiveHRIndicator } from '../LiveHRIndicator';
import { __dispatchLiveHRForTests } from '@/lib/hrMonitor/liveHR';

/**
 * F41 — the three states of `useReducedMotion`, on the app's most persistent
 * animation.
 *
 * `useReducedMotion` returns `boolean | null`, and the `null` is the whole
 * reason this file exists. It means "the OS has not answered yet", it is the
 * value on the very first frame of every cold start, and a caller that treats
 * it as `false` animates at somebody who asked for stillness — every launch,
 * before the answer arrives. Two states are easy to get right by accident;
 * three are not, so each one is asserted here rather than assumed.
 *
 * The heart is the right subject for it. It beats once per BLE sample, ~1 Hz,
 * for the length of a workout — so a wrong answer here is not one stray
 * animation, it is an hour of one.
 *
 * ## Why this counts `Animated.timing` calls rather than reading the scale
 *
 * The obvious test — read the scale off the animated view and assert it moved —
 * **cannot fail**, and that is not a guess: it was written that way first and
 * its own negative control caught it. The beat runs with `useNativeDriver:
 * true`, so the JS-side `Animated.Value` is handed to the native driver and
 * never ticks in jest; it reads `1` whether the animation started or not. The
 * Reduce-Motion-ON case therefore passed for entirely the wrong reason.
 *
 * What is actually being decided in the component is *whether to start a beat
 * at all*, so that is what is asserted. The interpolation between 1 and 1.15 is
 * React Native's job and is not this file's business.
 */

const dev = { id: 'dev-1', name: 'Amazfit GTR 4' };

/** Drive the hook's one input. `'pending'` never resolves, so `null` holds. */
function answerReduceMotion(value: boolean | 'pending') {
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() =>
      value === 'pending' ? new Promise<boolean>(() => {}) : Promise.resolve(value),
    );
}

async function mountWithReading() {
  await act(() => {
    __dispatchLiveHRForTests({ type: 'start', device: dev });
    __dispatchLiveHRForTests({ type: 'connected' });
    __dispatchLiveHRForTests({ type: 'reading', bpm: 165, at: new Date().toISOString() });
  });
  await render(<LiveHRIndicator hrMaxBPM={200} />);
  await act(async () => {});
}

let timing: jest.SpyInstance;

beforeEach(async () => {
  jest.restoreAllMocks();
  await act(() => __dispatchLiveHRForTests({ type: 'stop' }));
  // Spied, not stubbed — the real implementation still runs, so the component
  // behaves exactly as it does in production and this only counts.
  timing = jest.spyOn(Animated, 'timing');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('F41 — the heart respects Reduce Motion, in all three states', () => {
  test('Reduce Motion OFF: a reading starts the beat', async () => {
    answerReduceMotion(false);
    await mountWithReading();

    // Two legs: 1 → 1.15, then 1.15 → 1. This is the control that gives the
    // other two cases their meaning — without it, a component that never
    // animated at all would pass both of them.
    expect(timing).toHaveBeenCalled();
    const targets = timing.mock.calls.map((c) => (c[1] as { toValue: number }).toValue);
    expect(targets).toEqual([1.15, 1]);
  });

  test('Reduce Motion ON: the same reading starts nothing, and the number is still there', async () => {
    answerReduceMotion(true);
    await mountWithReading();

    expect(timing).not.toHaveBeenCalled();
    // The point of the gate: less movement, not less information. The reading
    // the athlete is actually looking at is untouched.
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
  });

  test('the OS has not answered yet: the heart holds rather than guessing', async () => {
    answerReduceMotion('pending');
    await mountWithReading();

    // `null` is the first-frame value on every cold start. Treating it as
    // `false` is the bug this asserts against: it would animate at everybody,
    // every launch, in the window before the OS replies.
    expect(timing).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
  });
});
