import { act, render, screen } from '@testing-library/react-native';

import { MacroRings } from '../today/MacroRings';
import { RING_SHORT, type RingReading } from '@/lib/macroRings';

/**
 * The cap actually reaching the drawn arc (N201/#637).
 *
 * `lib/__tests__/macroRings.test.ts` proves `ringCap` returns the right answer;
 * this proves `MacroRings` asks it. The two are separable and the second is the
 * one that failed in production — the arithmetic was never wrong, the arcs were
 * simply all drawn `round`, so a 2% fill came out as a floating capsule and the
 * user read four of them as a second colour legend.
 */

const reading = (key: RingReading['key'], percent: number | null): RingReading => ({
  key,
  label: RING_SHORT[key],
  eaten: percent === null ? null : percent,
  goal: percent === null ? null : 100,
  percent,
});

/** Every stroked circle in the SVG, in draw order: track, then fill. */
const circles = () => screen.UNSAFE_root.findAllByType('RNSVGCircle' as never);

/**
 * `react-native-svg` normalises `strokeLinecap` to the SVG enum on its way to
 * the host view — `butt` is 0, `round` 1, `square` 2 — so the prop read back
 * off a rendered node is a number, not the string that was written. Mapped
 * here rather than asserted as digits, so a failure names a cap.
 */
const CAP = ['butt', 'round', 'square'] as const;

/**
 * Async because `useReducedMotion` asks `AccessibilityInfo` and sets state when
 * it answers — after the render returns. Letting that settle inside `act` is
 * the difference between a clean run and a suite that prints an update-outside-
 * act warning on every case.
 */
async function caps(readings: RingReading[]): Promise<string[]> {
  render(<MacroRings readings={readings} testID="rings" />);
  await act(async () => {});
  return circles().map((c) => CAP[c.props.strokeLinecap as number] ?? String(c.props.strokeLinecap));
}

test('a fill too short to have a body is drawn without a cap', async () => {
  // 2% of the outer ring — the protein value in the user's own screenshot.
  const [, fill] = await caps([reading('kcal', 2)]);
  expect(fill).toBe('butt');
});

test('a fill with a body of its own keeps its round cap', async () => {
  const [, fill] = await caps([reading('kcal', 60)]);
  expect(fill).toBe('round');
});

/**
 * The card from the user's own screenshot: 87 of 1,880 kcal, protein 2%,
 * carbs 14%, fat 2%. The two that read as detached pills are the two that lose
 * their caps, and the rule is a LENGTH — so protein at 2% on a 374pt lap and
 * fat at 2% on a 148pt one are both under it, while calories at 4.6% on the
 * outer 487pt lap has 22pt of arc and keeps its cap.
 */
test("the day that produced the report draws two slivers, not four pills", async () => {
  const drawn = await caps([
    reading('kcal', 4.6),
    reading('protein', 2),
    reading('carbs', 14),
    reading('fat', 2),
  ]);
  // Four rings, each a track plus a fill; tracks are never capped.
  expect(drawn).toHaveLength(8);
  expect(drawn.filter((_, i) => i % 2 === 0)).toEqual(['butt', 'butt', 'butt', 'butt']);
  expect(drawn.filter((_, i) => i % 2 === 1)).toEqual(['round', 'butt', 'round', 'butt']);
});

// A ring with no target draws a track and nothing else — there is no arc to
// cap, and a cap on a zero-length one would draw a dot, i.e. a reading.
test('a ring with no target draws only its track', async () => {
  const drawn = await caps([reading('kcal', null)]);
  expect(drawn).toHaveLength(1);
  expect(drawn[0]).toBe('butt');
});
