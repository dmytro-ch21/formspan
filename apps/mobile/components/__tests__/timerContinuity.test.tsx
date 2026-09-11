import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { useCountdown } from '../Countdown';
import { TIMER_BAR_SPACE, TimerSurface, timerSpaceFor } from '../Timer';
import { MS, SWAP_SCALE } from '@/constants/Motion';
import { findAllByType, type TreeNode } from '@/lib/__tests__/support/tree';

/**
 * N558/#1047 — starting a rest timer, twenty times a session, on the screen an
 * athlete stares at between sets.
 *
 * Three defects landed on the same frame, and each has its own describe block
 * below. What jest can and cannot see is worth saying first, because the most
 * important one is the easiest to "test" with an apparatus that cannot fail.
 *
 * - **Render cost is observable, and it is the load-bearing assertion.** The
 *   drain used to be a `setState` every 250ms in the hook the SESSION SCREEN
 *   calls, so the whole screen re-rendered four times a second for the length of
 *   every rest. `SessionStandIn` below is that screen reduced to exactly its
 *   relationship with the hook — it calls `useCountdown` and mounts
 *   `TimerSurface` — and counts its own renders. The count is asserted to be
 *   ZERO across 30 seconds of a running rest, with a positive control proving
 *   the counter does count (±15s legitimately re-renders it).
 * - **The animation itself is not.** `jest.setup.js`'s Reanimated mock has no
 *   frame clock, so the smoothness of the drain, the 25pt arrival and the
 *   crossfade are device checks (`docs/testing/functional-scenarios.md`, Rest
 *   timer → needs a device). What IS asserted is how each animation was ARMED:
 *   how often, from which value, with which curve and duration, and whether it
 *   honours Reduce Motion.
 */

jest.mock('@/lib/sounds', () => ({ playSound: jest.fn() }));
jest.mock('@/lib/voice', () => ({
  announce: jest.fn(),
  cuesForTransition: () => [],
  speak: jest.fn(),
  stopSpeaking: jest.fn(),
  voiceEnabled: () => false,
}));

/** Called from the stand-in's render body — a render counter React cannot optimise away. */
const standInRendered = jest.fn();
/** The hook's API, handed out from an effect (assigning it during render is a side effect). */
const hook: { current: ReturnType<typeof useCountdown> | null } = { current: null };
const countdown = () => hook.current!;

function SessionStandIn() {
  standInRendered();
  const t = useCountdown();
  useEffect(() => {
    hook.current = t;
  });
  return t.timer ? (
    <TimerSurface
      timer={t.timer}
      clock={t.clock}
      run={t.run}
      minimized={t.minimized}
      onMinimize={() => t.setMinimized(true)}
      onExpand={() => t.setMinimized(false)}
      onAdjust={t.adjust}
      onTogglePause={t.togglePause}
      onSkip={t.skipStep}
      onStop={t.stop}
    />
  ) : null;
}

/** Drive `useReducedMotion`'s one input. `'pending'` never resolves, so `null` holds. */
function answerReduceMotion(value: boolean | 'pending') {
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() =>
      value === 'pending' ? new Promise<boolean>(() => {}) : Promise.resolve(value),
    );
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: () => {} } as ReturnType<typeof AccessibilityInfo.addEventListener>);
}

async function startRest(seconds: number) {
  await render(<SessionStandIn />);
  await act(async () => {
    countdown().startRest(seconds, 'Back squat', 'ex-1');
  });
  // Let the Reduce Motion answer land.
  await act(async () => {});
}

/**
 * Advance the clock one second per `act`, not all at once.
 *
 * On a device every 250ms tick is its own macrotask, and React finishes its
 * work between them. Thirty seconds inside ONE `act` is 120 ticks with no
 * boundary between them — and in the Reduce Motion path each tick writes the
 * drain's shared value, which the jest mock (unlike Reanimated) turns into a
 * React re-render. 120 of those without a boundary trips React's
 * nested-update limit: an artefact of the apparatus, measured, not a loop in
 * the component. One second per `act` keeps the device's shape.
 */
const advance = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await act(() => {
      jest.advanceTimersByTime(Math.min(1000, ms - elapsed));
    });
  }
};

const digits = () => screen.getByTestId('countdown-remaining');

const drainScale = () => {
  const style = StyleSheet.flatten(screen.getByTestId('countdown-drain').props.style) as {
    transform: { scaleX: number }[];
  };
  return style.transform[0].scaleX;
};

beforeEach(() => {
  jest.useFakeTimers();
  standInRendered.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('defect 3 — the countdown does not re-render the screen that owns it', () => {
  it('renders the owning screen ZERO times across 30 seconds of a running rest', async () => {
    answerReduceMotion(false);
    await startRest(90);
    expect(digits()).toHaveTextContent('1:30');

    const before = standInRendered.mock.calls.length;
    await advance(30_000);

    // Before N558 this was ~120: one per 250ms tick. The screen is ~3,900 lines
    // and every set row, so each of those was the whole log.
    expect(standInRendered.mock.calls.length - before).toBe(0);
  });

  it('still repaints the digits on the interval', async () => {
    // The other half of the claim: the screen went quiet because the tick moved
    // DOWN the tree, not because it stopped. A clock that froze would pass the
    // zero-render assertion above just as well.
    answerReduceMotion(false);
    await startRest(90);
    await advance(30_000);
    expect(digits()).toHaveTextContent('1:00');
    await advance(250 * 4);
    expect(digits()).toHaveTextContent('0:59');
  });

  it('does re-render the owning screen when the countdown itself changes (the counter counts)', async () => {
    // Positive control. Without it, a counter that was never wired up would
    // pass the zero assertion forever.
    answerReduceMotion(false);
    await startRest(90);
    const before = standInRendered.mock.calls.length;
    await fireEvent.press(screen.getByTestId('countdown-plus'));
    expect(standInRendered.mock.calls.length).toBeGreaterThan(before);
  });

  it('hands the screen the same remaining time on demand, for the handlers that log it', async () => {
    answerReduceMotion(false);
    await startRest(90);
    await advance(30_000);
    expect(countdown().clock.read()).toBeCloseTo(60, 0);
  });
});

describe('defect 3 — the drain is one UI-thread animation per change, not a stair', () => {
  it('arms a linear drain to empty at the deadline, once, and never again on a tick', async () => {
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);

    // One arm: a zero-length jump to the true position, then the drain.
    const armed = timing.mock.calls.length;
    expect(armed).toBe(2);
    const [toValue, config] = timing.mock.calls[armed - 1];
    expect(toValue).toBe(0);
    expect(config).toMatchObject({
      easing: Reanimated.Easing.linear,
      reduceMotion: Reanimated.ReduceMotion.Never,
    });
    // The drain lasts what is left — the deadline, not a guess.
    expect(config!.duration).toBeGreaterThan(90_000 - 50);
    expect(config!.duration).toBeLessThanOrEqual(90_000);

    await advance(30_000);
    expect(timing.mock.calls.length).toBe(armed);
    // Where the armed animation comes to rest: empty.
    expect(drainScale()).toBe(0);
  });

  it('jumps on its FIRST arm rather than refilling from a stale seed', async () => {
    // On a fresh rest the countdown's clock has not published yet when the bar
    // first renders, so the fill can be seeded at 0. A bridge from there would
    // refill the bar from empty over 180ms at the start of EVERY rest.
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    const [jumpTo, jump] = timing.mock.calls[0];
    expect(jump).toMatchObject({ duration: 0 });
    expect(jumpTo).toBeCloseTo(1, 2);
  });

  it('re-arms from the countdown\'s CURRENT position on ±15s, not from the top', async () => {
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    await advance(30_000);
    timing.mockClear();

    await fireEvent.press(screen.getByTestId('countdown-plus'));

    // 60s left of 90 becomes 75s left of 105. The bridge heads for the true
    // fraction a bridge's length from now — about 0.714 — not for 1.
    expect(timing.mock.calls.length).toBe(2);
    const [bridgeTo, bridge] = timing.mock.calls[0];
    expect(bridgeTo).toBeCloseTo(75 / 105, 2);
    expect(bridge).toMatchObject({ duration: MS.control });
    const [drainTo, drain] = timing.mock.calls[1];
    expect(drainTo).toBe(0);
    expect(drain!.duration).toBeCloseTo(75_000 - MS.control, -2);
  });

  it('holds its width while paused, and arms nothing further until resumed', async () => {
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    await advance(30_000);
    timing.mockClear();

    await fireEvent.press(screen.getByTestId('countdown-toggle'));
    expect(timing.mock.calls.length).toBe(1);
    expect(timing.mock.calls[0][0]).toBeCloseTo(60 / 90, 2);

    await advance(10_000);
    expect(timing.mock.calls.length).toBe(1);
    expect(drainScale()).toBeCloseTo(60 / 90, 2);
  });

  it('with Reduce Motion ON, animates nothing and steps with the digits', async () => {
    answerReduceMotion(true);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    await advance(30_000);
    expect(timing).not.toHaveBeenCalled();
    expect(drainScale()).toBeCloseTo(60 / 90, 2);
  });

  it('before the OS has answered Reduce Motion, animates nothing (holds rather than guesses)', async () => {
    answerReduceMotion('pending');
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    await advance(30_000);
    expect(timing).not.toHaveBeenCalled();
    expect(drainScale()).toBeCloseTo(60 / 90, 2);
  });
});

type Builder = { name: string; config: Record<string, unknown> };

const animatedViews = () =>
  findAllByType(screen.root as TreeNode, 'View').filter(
    (n) => n.props.entering != null || n.props.exiting != null,
  );

describe('defect 2 — arrival and the bar ↔ card swap are animated, and respect Reduce Motion', () => {
  it('arrives from above and leaves the way it came, on the motion scale', async () => {
    answerReduceMotion(false);
    await startRest(90);
    const layer = screen.getByTestId('countdown-layer');
    const entering = layer.props.entering as Builder;
    const exiting = layer.props.exiting as Builder;
    expect(entering.name).toBe('FadeInDown');
    expect(entering.config.duration).toBe(MS.control);
    expect(exiting.name).toBe('FadeOutUp');
    // Exits are faster than entries.
    expect(exiting.config.duration).toBe(MS.press);
  });

  it('skips the swap animation when the whole surface arrives or leaves (no fade inside a fade)', async () => {
    answerReduceMotion(false);
    await startRest(90);
    const config = screen.getByTestId('layout-animation-config');
    expect(config.props.skipEntering).toBe(true);
    expect(config.props.skipExiting).toBe(true);
    // And the swap wrapper is actually inside it, not beside it.
    const inside = findAllByType(config as TreeNode, 'View').filter((n) => n.props.entering != null);
    expect(inside).toHaveLength(1);
  });

  it('crossfades the swap, the incoming form settling up from SWAP_SCALE', async () => {
    answerReduceMotion(false);
    await startRest(90);
    await fireEvent.press(screen.getByTestId('countdown-expand'));
    // The card is on screen now (the minimise control is card-only).
    expect(screen.getByTestId('countdown-minimize')).toBeTruthy();

    const swaps = animatedViews().filter((n) => n.props.testID !== 'countdown-layer');
    expect(swaps).toHaveLength(1);
    const entering = swaps[0].props.entering as Builder & {
      config: { frames: Record<number, { opacity: number; transform: { scale: number }[] }> };
    };
    expect(entering.name).toBe('Keyframe');
    expect(entering.config.frames[0].opacity).toBe(0);
    expect(entering.config.frames[0].transform[0].scale).toBe(SWAP_SCALE);
    expect(entering.config.frames[100].opacity).toBe(1);
    expect(entering.config.duration).toBe(MS.control);
    expect((swaps[0].props.exiting as Builder).config.duration).toBe(MS.press);
  });

  it('carries ReduceMotion.System on every layout animation, in both forms', async () => {
    answerReduceMotion(false);
    await startRest(90);
    const seen: Builder[] = [];
    const collect = () => {
      for (const n of animatedViews()) {
        for (const b of [n.props.entering, n.props.exiting] as (Builder | undefined)[]) {
          if (b) seen.push(b);
        }
      }
    };
    collect();
    await fireEvent.press(screen.getByTestId('countdown-expand'));
    collect();

    // Layer in + out, and the swap in + out on each form: nothing may be
    // missed by a filter that matched fewer views than it should.
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const b of seen) expect(b.config.reduceMotion).toBe(Reanimated.ReduceMotion.System);
  });
});

describe('defect 1 — the log is not moved by the timer', () => {
  it('reserves the same space whether or not a timer is showing, for the life of a live session', () => {
    // THE property. The old rule was `timer && minimized`, which is four
    // different taps that moved the whole log 64pt under the thumb.
    expect(timerSpaceFor({ finished: false, timerShowing: false })).toBe(TIMER_BAR_SPACE);
    expect(timerSpaceFor({ finished: false, timerShowing: true })).toBe(TIMER_BAR_SPACE);
    // Finishing mid-rest keeps the room while the bar is still up...
    expect(timerSpaceFor({ finished: true, timerShowing: true })).toBe(TIMER_BAR_SPACE);
    // ...and a finished report with no timer gets it back.
    expect(timerSpaceFor({ finished: true, timerShowing: false })).toBe(0);
    expect(TIMER_BAR_SPACE).toBe(64);
  });

  it('is what the session screen pads its log by, and minimised state plays no part in it', () => {
    const code = readFileSync(join(__dirname, '..', '..', 'app/session/[id].tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const style = code.slice(
      code.indexOf('<KeyboardAwareScrollView'),
      code.indexOf('>', code.indexOf('contentContainerStyle')),
    );
    expect(style).toMatch(/paddingTop: timerSpaceFor\(\{ finished, timerShowing: timerState\.timer != null \}\)/);
    expect(style).not.toMatch(/minimized/);
    expect(style).not.toMatch(/TIMER_BAR_SPACE/);
  });
});
