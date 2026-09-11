import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { Pill, CHIP_HEIGHT, CHIP_LABEL_LINE } from '../Pill';
import {
  WeekStrip,
  REVIEW_HEIGHT,
  REVIEW_ICON,
} from '@/components/today/WeekStrip';
import { TOUCH_MIN, slopFor } from '@/constants/Spacing';

/**
 * The 44pt floor, at the two sites F42 found genuinely under it.
 *
 * ## Why this asserts an EFFECTIVE size, not a `hitSlop` value
 *
 * `hitSlop={9}` is meaningless on its own — it is only correct relative to
 * the height it is extending. A test pinning the literal 9 would go green if
 * somebody later changed the chip's padding and left the slop alone, which is
 * precisely the drift that produced the ~39pt target in the first place. So
 * each case below reconstructs the painted height from the component's own
 * flattened style and adds the slop it actually rendered.
 *
 * ## What this cannot see
 *
 * Whether a thumb hits it. The audit computed 39pt and 16pt from padding and
 * font size in source, and **no figure was ever measured on glass** — both of
 * #1041's device criteria exist because geometry clearing 44 on paper is not
 * the same claim as a control being reliably hit one-handed.
 */

/** `hitSlop` as a number applies to all four edges, so it counts twice. */
const effective = (visualHeight: number, hitSlop: number) => visualHeight + 2 * hitSlop;

describe('slopFor — the arithmetic behind every call site', () => {
  it('rounds up, so an odd shortfall still clears the floor rather than landing on it', () => {
    // 27 is 17 short; half is 8.5, and 8 would leave the control at 43.
    expect(slopFor(27)).toBe(9);
    expect(effective(27, slopFor(27))).toBeGreaterThanOrEqual(TOUCH_MIN);
  });

  it('asks for nothing when the control already clears the floor', () => {
    expect(slopFor(TOUCH_MIN)).toBe(0);
    expect(slopFor(60)).toBe(0);
  });

  it('never returns a negative slop, which would shrink the target', () => {
    expect(slopFor(1000)).toBe(0);
  });

  /*
    Written once as `>= Math.min(h, TOUCH_MIN)`, which is very nearly vacuous:
    a control that already exceeds the floor trivially satisfies it, and one
    below the floor only has to stay at least its own painted height, which
    slop can never take it below. Mutating `slopFor` to round DOWN — landing
    a 27pt chip on 43 — left this green while the three real assertions went
    red, so it was measuring nothing. Split in two: below the floor the
    target must REACH the floor, above it the control is left alone.
  */
  it('takes every height below the floor up to it, and leaves larger ones alone', () => {
    for (let h = 1; h < TOUCH_MIN; h += 1) {
      expect(effective(h, slopFor(h))).toBeGreaterThanOrEqual(TOUCH_MIN);
    }
    for (let h = TOUCH_MIN; h <= 120; h += 1) {
      expect(slopFor(h)).toBe(0);
    }
  });
});

describe('Pill — the shared chip reaches the floor (F42, #1041)', () => {
  it('a chip renders an effective target of at least 44pt', async () => {
    await render(<Pill label="Strength" onPress={() => {}} testID="pill" />);
    const pill = screen.getByTestId('pill');
    const style = StyleSheet.flatten(pill.props.style);

    // Two assertions, because they can fail for different reasons. First: the
    // declared height still describes what is actually painted — this is what
    // catches the padding being changed and the constant left behind.
    expect(style.paddingVertical * 2 + CHIP_LABEL_LINE).toBe(CHIP_HEIGHT);
    // Then: the slop the component really rendered takes that height over the
    // floor. Never a literal `9` — a test pinning the slop alone goes green
    // when the padding shrinks underneath it, which is the exact drift that
    // produced the 39pt target.
    expect(effective(CHIP_HEIGHT, pill.props.hitSlop as number)).toBeGreaterThanOrEqual(TOUCH_MIN);
  });

  it('a badge has no press target at all, so it is exempt rather than failing', async () => {
    await render(<Pill label="Public" testID="pill" />);
    // The badge path renders an RNView with no `onPress` — nothing to hit, so
    // a touch-target floor does not apply. Asserted so that a future change
    // making badges pressable has to come back through this file.
    expect(screen.getByTestId('pill').props.onPress).toBeUndefined();
  });
});

describe('WeekStrip — "Week in review" reaches the floor (F42, #1041)', () => {
  it('renders an effective target of at least 44pt', async () => {
    // A real Monday-first week, because `WeekStrip` derives its day keys from
    // these and an empty array is not a state it is built to render.
    const monday = new Date(2026, 8, 7);
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 7 + i));

    await render(
      <WeekStrip
        now={monday}
        days={days}
        logged={{ state: 'off' }}
        onWeekInReview={() => {}}
        testID="week-strip"
      />,
    );
    const review = screen.getByTestId('week-strip-review');
    const style = StyleSheet.flatten(review.props.style);
    // The chevron is the tallest child; the label is 12pt.
    expect(style.paddingVertical * 2 + REVIEW_ICON).toBe(REVIEW_HEIGHT);
    expect(effective(REVIEW_HEIGHT, review.props.hitSlop as number)).toBeGreaterThanOrEqual(
      TOUCH_MIN,
    );
  });
});
