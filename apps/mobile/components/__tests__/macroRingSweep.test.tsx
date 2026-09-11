import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { MacroRings } from '../today/MacroRings';
import { RING_SHORT, type RingReading } from '@/lib/macroRings';
import { findAllByType } from '@/lib/__tests__/support/tree';

/**
 * Where the sweep comes to REST (F46/#1045).
 *
 * `macroRingCaps.test.tsx` next door proves the arcs are capped correctly;
 * this proves they are *drawn at the right length*, which is the half F46 put
 * at risk. Moving the interpolation from core `Animated` onto Reanimated's
 * `useAnimatedProps` rewrote every expression that produces a
 * `strokeDashoffset` — including the ramp's clamp, which is the one piece of
 * arithmetic in the file that is easy to get subtly wrong and impossible to
 * see wrong: a mis-clamped ramp still renders a plausible gradient.
 *
 * ## What this can and cannot see
 *
 * There is no frame clock in jest, and `jest.setup.js`'s Reanimated mock
 * deliberately does not invent one — `withTiming` resolves to its final value.
 * So every assertion here is about the value the sweep ARRIVES at, never about
 * a frame partway along it. The 620ms, the 380ms second-lap delay and the
 * curve are device-evidence criteria on #1045 and are not asserted here; a
 * test that claimed to check them would be apparatus that cannot fail.
 *
 * ## The `null` hold is the one that matters most
 *
 * `useReducedMotion` returns `boolean | null`, and `null` means "the OS has
 * not answered yet". Treating it as `false` sweeps the ring for somebody who
 * asked not to be moved, on EVERY cold start, because the first frame always
 * precedes the answer. That bug is invisible on a machine where the promise
 * resolves quickly, so the test holds the answer back forever instead of
 * racing it.
 */

const reading = (key: RingReading['key'], percent: number | null): RingReading => ({
  key,
  label: RING_SHORT[key],
  eaten: percent,
  goal: percent === null ? null : 100,
  percent,
});

/** The outer ring's geometry, from `MacroRings`' own defaults: 168pt, 13pt stroke. */
const RADIUS = (168 - 13) / 2;
const C = 2 * Math.PI * RADIUS;

/**
 * `react-native-svg` reports a `strokeDashoffset` of 0 back as `null` — 0 is
 * "the arc is fully drawn", and the extractor drops it. Mapped here so an
 * assertion can talk in arc lengths rather than in that quirk.
 */
const offsets = () =>
  findAllByType(screen.root, 'RNSVGCircle')
    // The track carries no dash array and no offset at all; it is not an arc.
    .filter((c) => c.props.strokeDasharray != null)
    .map((c) => (c.props.strokeDashoffset == null ? 0 : (c.props.strokeDashoffset as number)));

async function draw(readings: RingReading[]): Promise<number[]> {
  await render(<MacroRings readings={readings} testID="rings" />);
  await act(async () => {});
  return offsets();
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a ring under target rests at the offset its percentage names', async () => {
  const [fill] = await draw([reading('kcal', 60)]);
  // 60% eaten leaves 40% of the lap undrawn.
  expect(fill).toBeCloseTo(C * 0.4, 6);
});

test('a ring at exactly target closes completely', async () => {
  const [fill] = await draw([reading('kcal', 100)]);
  expect(fill).toBeCloseTo(0, 6);
});

/**
 * The clamp, arc by arc. Past 100% the second lap is painted as N cumulative
 * arcs, each stopping at its own share of the overflow so the ramp reveals in
 * order rather than appearing whole — see the N554/#1025 block in the
 * component. This asserts the whole sequence rather than a sample, because a
 * clamp that is wrong by one arc is exactly what a sample misses.
 */
test('each ramp arc stops at its own share of the overflow', async () => {
  const drawn = await draw([reading('kcal', 160)]);
  const [baseLap, ...ramp] = drawn;

  // The base lap is full at any value past 100%.
  expect(baseLap).toBeCloseTo(0, 6);
  expect(ramp.length).toBeGreaterThan(1);

  const overflow = 0.6;
  ramp.forEach((offset, i) => {
    const reach = ((ramp.length - i) / ramp.length) * overflow;
    // `over` rests at `overflow`, so an arc whose reach is at or below it is
    // held at its own stopping point; the maths is the component's, restated.
    const expected = reach >= 1 ? 0 : C * (1 - Math.min(reach, overflow));
    expect(offset).toBeCloseTo(expected, 6);
  });

  // Longest and darkest first: the ramp must be monotonically shorter.
  const shrinking = ramp.every((o, i) => i === 0 || o > ramp[i - 1]);
  expect(shrinking).toBe(true);
});

test('the ring holds unswept while the OS has not answered about Reduce Motion', async () => {
  // Never resolves — the `null` window held open for the whole test, which is
  // the state a cold start is really in for its first frames.
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockReturnValue(new Promise<boolean>(() => {}));
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: () => {} } as ReturnType<typeof AccessibilityInfo.addEventListener>);

  const [fill] = await draw([reading('kcal', 60)]);
  // Full circumference is an arc of zero length: nothing has swept.
  expect(fill).toBeCloseTo(C, 6);
});

test('Reduce Motion still draws the ring at its value — it only removes the travel', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: () => {} } as ReturnType<typeof AccessibilityInfo.addEventListener>);

  const [fill] = await draw([reading('kcal', 60)]);
  // The same resting offset as the animated case. An empty ring (offset === C)
  // would be answering a different request: Reduce Motion asks not to be
  // MOVED, not to be shown nothing.
  expect(fill).toBeCloseTo(C * 0.4, 6);
});
