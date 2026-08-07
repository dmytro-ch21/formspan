import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Alert } from 'react-native';

import { accents, vola } from '@/constants/Colors';

import { HOLD_MS, HoldToConfirm, usesTapFallback } from '../HoldToConfirm';

/**
 * A component test rather than a pure-function one, because the property that
 * matters here is not arithmetic — it is that a press which was released early
 * performs NOTHING.
 *
 * There is no honest way to extract that. The guard is the relationship between
 * `onPressIn` starting a timer and `onPressOut` clearing it, and a pure helper
 * that "decides" whether 400ms is less than 900ms would pass forever while the
 * component forgot to call it. The failure being protected against — a tap
 * finishing somebody's session — is invisible to every other kind of test.
 */

const props = {
  label: 'Finish session',
  confirmTitle: 'Finish session?',
  onConfirm: jest.fn(),
};

beforeEach(() => {
  jest.useFakeTimers();
  props.onConfirm = jest.fn();
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: () => {} } as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const hold = (ms: number) => {
  fireEvent(screen.getByTestId('hold'), 'pressIn');
  act(() => {
    jest.advanceTimersByTime(ms);
  });
};

describe('holding to confirm', () => {
  it('does nothing for a tap', () => {
    // THE assertion. Before this control existed, this exact gesture ended a
    // session — one tap, no confirmation, not undoable from the phone.
    render(<HoldToConfirm {...props} testID="hold" />);
    fireEvent(screen.getByTestId('hold'), 'pressIn');
    fireEvent(screen.getByTestId('hold'), 'pressOut');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('does nothing when released just before the threshold', () => {
    render(<HoldToConfirm {...props} testID="hold" />);
    hold(HOLD_MS - 50);
    fireEvent(screen.getByTestId('hold'), 'pressOut');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once the hold completes', () => {
    render(<HoldToConfirm {...props} testID="hold" />);
    hold(HOLD_MS);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms exactly once, however long the finger stays down', () => {
    // A repeating timer here would finish the session, then finish it again.
    render(<HoldToConfirm {...props} testID="hold" />);
    hold(HOLD_MS * 4);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('starts over after an abandoned hold rather than accumulating', () => {
    // Two 500ms holds are not one 1000ms hold. Accumulating would mean a
    // second nervous half-press commits, which is precisely the accident.
    render(<HoldToConfirm {...props} testID="hold" />);
    hold(HOLD_MS - 100);
    fireEvent(screen.getByTestId('hold'), 'pressOut');
    hold(HOLD_MS - 100);
    fireEvent(screen.getByTestId('hold'), 'pressOut');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('honours a custom duration', () => {
    render(<HoldToConfirm {...props} durationMs={2000} testID="hold" />);
    hold(1500);
    expect(props.onConfirm).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not fire after the screen goes away', () => {
    // A hold in flight when the session is closed must not reach into an
    // unmounted tree — and must not happen at all, since nobody is holding
    // anything any more.
    render(<HoldToConfirm {...props} testID="hold" />);
    fireEvent(screen.getByTestId('hold'), 'pressIn');
    screen.unmount();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('tells the user it wants a hold', () => {
    // A button that ignores taps and says nothing is indistinguishable from a
    // broken one.
    render(<HoldToConfirm {...props} testID="hold" />);
    expect(screen.getByTestId('hold').props.accessibilityHint).toMatch(/hold/i);
  });
});

describe('the screen-reader path', () => {
  it('routes VoiceOver to a confirm dialog instead of a hold', async () => {
    // VoiceOver activates with a double-tap, which synthesises a press and an
    // immediate release — there is no sustained contact to measure. A
    // hold-only control is not awkward for those users, it is UNREACHABLE, and
    // it fails silently: announced, focusable, does nothing.
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<HoldToConfirm {...props} testID="hold" />);
    await act(async () => {});

    fireEvent.press(screen.getByTestId('hold'));
    expect(alert).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe('Finish session?');
  });

  it('performs the action from the dialog, not from the tap', async () => {
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    let buttons: { text?: string; onPress?: () => void }[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation(((_t: string, _m: string, b: never) => {
      buttons = b;
    }) as never);
    render(<HoldToConfirm {...props} testID="hold" />);
    await act(async () => {});

    fireEvent.press(screen.getByTestId('hold'));
    // The tap alone must not perform it — that would make the accessible path
    // a single tap on a destructive action, which is what all of this exists
    // to prevent.
    expect(props.onConfirm).not.toHaveBeenCalled();

    buttons.find((x) => x.text === 'Finish session')?.onPress?.();
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('decides the fallback from the screen reader, nothing else', () => {
    expect(usesTapFallback(true)).toBe(true);
    expect(usesTapFallback(false)).toBe(false);
  });
});

describe('the fill has to be visible against what it fills', () => {
  it('never defaults to the same colour as an accent it might sit on', () => {
    // Found in review, and it was deterministic rather than subtle: the
    // strength Finish button's background IS `accent.accent`, the default
    // accent is `#B8FF2C`, and `vola.lime` is `#B8FF2C` — so the default fill
    // over the default accent was lime on lime. The one button this control
    // was built for showed no progress at all.
    //
    // The call site now passes `accent.on`, which every palette defines
    // precisely because it reads against that palette's accent. This pins the
    // collision that made it necessary.
    expect(accents.green.accent).toBe(vola.lime);
    for (const a of Object.values(accents)) {
      expect(a.on).not.toBe(a.accent);
    }
  });
});

describe('the threshold', () => {
  it('is 900ms — pinned to the number, not to the constant', () => {
    // Importing HOLD_MS on both sides of an assertion makes the test agree
    // with whatever the constant says. One literal is what actually holds the
    // timing: under ~600ms accidental holds start getting through.
    expect(HOLD_MS).toBe(900);
  });
});
