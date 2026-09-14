import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { useEffect } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { useCountdown } from '../Countdown';
import { TIMER_BAR_SPACE, TimerSurface, timerSpaceFor } from '../Timer';
import { MS, SWAP_SCALE } from '@/constants/Motion';
import { collectNodes, findAllByType, type TreeNode } from '@/lib/__tests__/support/tree';
import type { RunStep } from '@/lib/intervalRun';

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
 *   frame clock, so the smoothness of the drain, the fade-in and the
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
    // F57: the card's ring re-arms with it, from the same value — it IS that value.
    const arc = ringArc();
    expect(arc.offset).toBeCloseTo(arc.circumference * (1 - drainScale()), 5);
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
    // F57: the card's ring holds exactly where the bar holds.
    const arc = ringArc();
    expect(arc.offset).toBeCloseTo(arc.circumference * (1 - 60 / 90), 2);
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

/*
  F55/#1134 — N558 merged with its `/review-animations` findings unfixed, and
  the review had blocked on the first of these. This block replaces N558's
  arrival/swap tests, several of which asserted the defects themselves
  (`FadeInDown`, a `Keyframe` swap, `ReduceMotion.System` everywhere).

  What jest can see is unchanged: no frame clock, so where an animation comes to
  REST, never a frame along it. For the flash that is not enough — the flashing
  swap and the fixed one rest at identical values — so the Reanimated mock now
  logs every shared-value write as ASSIGNED (`__sharedValueWrites`). A reversal
  that continues from where the crossfade is looks like "an animation assigned
  to the same value, with no literal start value written first". Anything that
  restarts a swap has to write one, remount a form, or use a fresh value, and
  each of those is asserted against here.
*/
type SharedValueWrite = { target: unknown; value: unknown };
const sharedValueWrites = () =>
  (Reanimated as unknown as { __sharedValueWrites: SharedValueWrite[] }).__sharedValueWrites;

/** A swap form's wrapper — including the one hidden from assistive technology. */
const form = (which: 'bar' | 'card') =>
  screen.getByTestId(`countdown-form-${which}`, { includeHiddenElements: true });
const formStyle = (which: 'bar' | 'card') =>
  StyleSheet.flatten(form(which).props.style) as {
    opacity: number;
    transform: { scale: number }[];
    transformOrigin?: string;
    position?: string;
  };

const REDUCE_MOTION_STATES = [
  ['on', true],
  ['off', false],
  ['not yet answered', 'pending'],
] as const;

describe('F55 — the surface arrives, leaves and swaps without a flash, and Reduce Motion keeps a fade', () => {
  it.each(REDUCE_MOTION_STATES)(
    'arrives and leaves by opacity alone, at MS.press, with Reduce Motion %s',
    async (_label, answer) => {
      answerReduceMotion(answer);
      await startRest(90);
      const layer = screen.getByTestId('countdown-layer');
      const entering = layer.props.entering as Builder;
      const exiting = layer.props.exiting as Builder;
      // Opacity only: the 64pt is reserved, so there is nowhere to travel from.
      expect([entering.name, exiting.name]).toEqual(['FadeIn', 'FadeOut']);
      expect(entering.config.duration).toBe(MS.press);
      expect(exiting.config.duration).toBe(MS.press);
      // Never, not System — System is a launch-time snapshot that, with Reduce
      // Motion on, skips the fade outright. The live hook decides instead.
      expect(entering.config.reduceMotion).toBe(Reanimated.ReduceMotion.Never);
      expect(exiting.config.reduceMotion).toBe(Reanimated.ReduceMotion.Never);
    },
  );

  it('opens in the form the countdown asks for, with no crossfade inside the arrival', async () => {
    answerReduceMotion(false);
    await startRest(90);
    // A rest opens minimised: the bar fully there on its first frame, the card absent.
    expect(formStyle('bar').opacity).toBe(1);
    expect(formStyle('card').opacity).toBe(0);
    // The only layout animation left in the surface is the layer's own.
    expect(animatedViews().map((n) => n.props.testID)).toEqual(['countdown-layer']);
  });

  it('keeps both forms mounted and exposes exactly one, to touches and to assistive technology', async () => {
    answerReduceMotion(false);
    await startRest(90);
    const exposure = (which: 'bar' | 'card') => ({
      touches: form(which).props.pointerEvents,
      hidden: form(which).props.accessibilityElementsHidden,
      android: form(which).props.importantForAccessibility,
      behind: formStyle(which).position === 'absolute',
    });
    const shown = { touches: 'box-none', hidden: false, android: 'auto', behind: false };
    const faded = { touches: 'none', hidden: true, android: 'no-hide-descendants', behind: true };

    expect(exposure('bar')).toEqual(shown);
    expect(exposure('card')).toEqual(faded);
    // The two forms share six testIDs. Default queries skip hidden elements, so
    // exactly one set of controls is reachable — never two.
    expect(screen.getAllByTestId('countdown-remaining')).toHaveLength(1);
    expect(screen.queryByTestId('countdown-minimize')).toBeNull();

    await fireEvent.press(screen.getByTestId('countdown-expand'));

    expect(exposure('card')).toEqual(shown);
    expect(exposure('bar')).toEqual(faded);
    expect(screen.getAllByTestId('countdown-remaining')).toHaveLength(1);
    expect(screen.queryByTestId('countdown-expand')).toBeNull();
  });

  it('makes the card modal to VoiceOver only while the card is the form on screen', async () => {
    answerReduceMotion(false);
    await startRest(90);
    // Both forms render a root with testID `countdown-timer`; read the card's.
    const cardRoot = () =>
      within(form('card')).getByTestId('countdown-timer', { includeHiddenElements: true });
    // Minimised: the card is mounted behind the bar, and must not trap focus there.
    expect(cardRoot().props.accessibilityViewIsModal).toBe(false);

    await fireEvent.press(screen.getByTestId('countdown-expand'));
    expect(cardRoot().props.accessibilityViewIsModal).toBe(true);

    await fireEvent.press(screen.getByTestId('countdown-minimize'));
    expect(cardRoot().props.accessibilityViewIsModal).toBe(false);
  });

  it('reverses a swap mid-flight by retargeting ONE value — nothing restarts from a start value', async () => {
    answerReduceMotion(false);
    await startRest(90);
    // `withTiming` as a recorder: a tagged animation instead of its destination,
    // so assigning an animation can be told apart from writing a literal.
    jest
      .spyOn(Reanimated, 'withTiming')
      .mockImplementation(((timingTo: number, config: unknown) => ({ timingTo, config })) as never);
    const writes = sharedValueWrites();
    const before = writes.length;

    await fireEvent.press(screen.getByTestId('countdown-expand'));
    // No clock advances between the presses: in jest this IS "within the 180ms".
    await fireEvent.press(screen.getByTestId('countdown-minimize'));

    const swap = writes.slice(before);
    // Exactly two writes, one per toggle, to ONE persistent value — no literal
    // start value in between, no second value for the other form.
    expect(swap).toHaveLength(2);
    expect(swap[0].target).toBe(swap[1].target);
    expect(swap.map((w) => (w.value as { timingTo: number }).timingTo)).toEqual([1, 0]);
    for (const w of swap) {
      expect((w.value as { config: object }).config).toEqual(
        expect.objectContaining({ duration: MS.control, reduceMotion: Reanimated.ReduceMotion.Never }),
      );
    }
    // And no form remounts with its own layout animation — the `Keyframe` and
    // `FadeOut` that could only restart from frame 0 are gone.
    expect(animatedViews().map((n) => n.props.testID)).toEqual(['countdown-layer']);
  });

  it.each(REDUCE_MOTION_STATES)(
    'fades in every state, and scales from the top edge only when motion is on — Reduce Motion %s',
    async (_label, answer) => {
      answerReduceMotion(answer);
      await startRest(90);
      const timing = jest.spyOn(Reanimated, 'withTiming');
      await fireEvent.press(screen.getByTestId('countdown-expand'));

      // The fade is armed whatever Reduce Motion says: gentler, not nothing.
      expect(timing).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ duration: MS.control, reduceMotion: Reanimated.ReduceMotion.Never }),
      );
      // Both forms scale about the top edge the layer is pinned to.
      expect(formStyle('bar').transformOrigin).toBe('top');
      expect(formStyle('card').transformOrigin).toBe('top');
      // At rest: the card shown at full size, the bar faded out behind it.
      expect(formStyle('card').opacity).toBe(1);
      expect(formStyle('bar').opacity).toBe(0);
      expect(formStyle('card').transform[0].scale).toBeCloseTo(1, 10);
      // The scale is the only movement, so it is what Reduce Motion — and an
      // unanswered OS — removes.
      expect(formStyle('bar').transform[0].scale).toBeCloseTo(answer === false ? SWAP_SCALE : 1, 10);
    },
  );
});

/*
  F57/#1140 — the expanded ring and the run bar move on the UI thread.

  N558 made the collapsed bar drain continuously, and F55 kept both forms
  mounted; the card's ring still stepped at 4Hz from `remaining`, so expanding a
  smooth bar revealed a stepping clock. The ring now reads the SAME armed drain
  the bar does. The assertions that matter are the ones that would move if it
  didn't: the arc sits where the one drain comes to rest (a ring still computed
  from `remaining` would be two-thirds wound after 30s), and the withTiming
  count does not grow (a ring arming its own copy would double it).
*/
const ringArc = () => {
  const card = screen.getByTestId('countdown-form-card', { includeHiddenElements: true });
  const arcs = collectNodes(card as TreeNode).filter(
    (n) => n.props.strokeDashoffset != null && n.props.strokeDasharray != null,
  );
  expect(arcs.length).toBeGreaterThan(0);
  // react-native-svg normalises `strokeDasharray` to an array on the host node.
  const dash = arcs[0].props.strokeDasharray as number | number[];
  return {
    offset: arcs[0].props.strokeDashoffset as number,
    circumference: Array.isArray(dash) ? dash[0] : dash,
  };
};

const runFillScale = () => {
  const style = StyleSheet.flatten(screen.getByTestId('countdown-run-fill').props.style) as {
    transform: { scaleX: number }[];
    width?: unknown;
    transformOrigin?: string;
  };
  return { scaleX: style.transform[0].scaleX, width: style.width, origin: style.transformOrigin };
};

/** A two-step run: 30s of work, then 60s of rest — 90s in all. */
const RUN: RunStep[] = [
  { kind: 'work', seconds: 30, label: 'Burpee', exerciseID: 'ex-1', setIndex: 0, ordinal: 1, total: 2 },
  { kind: 'rest', seconds: 60, label: 'Burpee', exerciseID: 'ex-1', ordinal: 1, total: 2 },
];

async function startRunOf(steps: RunStep[]) {
  await render(<SessionStandIn />);
  await act(async () => {
    countdown().startRun(steps, 'exercise');
  });
  await act(async () => {});
}

describe('F57 — the expanded ring and the run bar move on the UI thread', () => {
  it("reads the bar's one armed drain: the ring adds no animation, and a tick arms nothing", async () => {
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRest(90);
    // The drain's jump and its linear leg — and nothing for the ring.
    expect(timing.mock.calls.length).toBe(2);

    await advance(30_000);
    expect(timing.mock.calls.length).toBe(2);
    // Where the one drain comes to rest (empty) is where the arc is: fully unwound.
    // A ring still computed from `remaining` would sit a third unwound here.
    const { offset, circumference } = ringArc();
    expect(offset).toBeCloseTo(circumference, 5);
    expect(drainScale()).toBe(0);
  });

  it.each([
    ['on', true],
    ['not yet answered', 'pending'],
  ] as const)('with Reduce Motion %s, the ring steps with the digits', async (_label, answer) => {
    answerReduceMotion(answer);
    await startRest(90);
    await advance(30_000);
    const { offset, circumference } = ringArc();
    expect(offset).toBeCloseTo(circumference * (1 - 60 / 90), 1);
  });

  it('fills the run bar on the UI thread, armed once toward the end of THIS step', async () => {
    answerReduceMotion(false);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRunOf(RUN);

    // Drain and run bar, two legs each. The run bar's linear leg heads for where
    // the run will be when this 30s step ends: 30 of 90 seconds.
    expect(timing.mock.calls.length).toBe(4);
    const linearTargets = timing.mock.calls
      .filter(([, config]) => (config as { easing?: unknown } | undefined)?.easing === Reanimated.Easing.linear)
      .map(([toValue]) => toValue as number);
    expect(linearTargets).toHaveLength(2);
    expect(linearTargets[0]).toBe(0);
    expect(linearTargets[1]).toBeCloseTo(30 / 90, 5);

    await advance(10_000);
    expect(timing.mock.calls.length).toBe(4);
    // A scaleX fill at full width, not an animated width.
    const fill = runFillScale();
    expect(fill.width).toBe('100%');
    // Grows rightward from the left edge, the way the width did.
    expect(fill.origin).toBe('left');
    expect(fill.scaleX).toBeCloseTo(30 / 90, 5);
  });

  it('with Reduce Motion on, the run bar steps with the digits and arms nothing', async () => {
    answerReduceMotion(true);
    const timing = jest.spyOn(Reanimated, 'withTiming');
    await startRunOf(RUN);
    await advance(10_000);
    expect(timing).not.toHaveBeenCalled();
    // 10s into the 30s work step: 10 of 90 seconds of the run.
    expect(runFillScale().scaleX).toBeCloseTo(10 / 90, 2);
  });

  it('a run bar that comes back after its run ended jumps to its start, never glides from the old fill', async () => {
    answerReduceMotion(false);
    await startRunOf(RUN);
    await advance(20_000);
    // What a set tick does with auto-rest on: the run ends, the timer does not,
    // so the surface — and the run bar's shared value — stay mounted.
    await act(async () => {
      countdown().startRest(60, 'Back squat', 'ex-1');
    });
    await act(async () => {});

    const timing = jest.spyOn(Reanimated, 'withTiming');
    await act(async () => {
      countdown().startRun(RUN, 'exercise');
    });
    const jumps = timing.mock.calls
      .map(([toValue, config]) => ({ toValue: toValue as number, ...(config as { duration?: number }) }))
      .filter((c) => c.duration === 0);
    // Exactly one arm jumps — the run bar's, onto the new run's start. The drain
    // bridges as before, because its bar never stopped being on screen.
    expect(jumps).toHaveLength(1);
    expect(jumps[0].toValue).toBe(0);
  });

  it('a lone rest has no run bar, so it arms none', async () => {
    answerReduceMotion(false);
    await startRest(90);
    await fireEvent.press(screen.getByTestId('countdown-expand'));
    expect(screen.queryByTestId('countdown-run-fill')).toBeNull();
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
