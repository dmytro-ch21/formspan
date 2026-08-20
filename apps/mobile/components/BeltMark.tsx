import Svg, { Path, Rect } from 'react-native-svg';

import { describeBelt } from '@/components/Belt';
import { activeBeltAccent, type BeltKey } from '@/constants/Colors';

/**
 * A **tied** belt, small, centred under a belt's name.
 *
 * `components/Belt.tsx` draws the belt as a physical object — a flat strap with
 * the rank bar sewn near one end — and that is the right drawing for a rank
 * card, where the stripes are the content. This is the other one: the mark from
 * the roadmap reference, a belt tied around a waist and seen from the front,
 * where the *knot* is what makes it read as a belt at 64pt wide. A flat strap
 * at that size reads as a coloured rectangle.
 *
 * **In the belt's ACCENT, not its strap colour**, which is the one place this
 * departs from `Belt`. A strap colour is a picture of dyed cotton (#1B4CC4
 * blue measures 2.50:1 against `surface`); this is a 16pt-tall mark on a
 * near-black ground doing signalling work, which is exactly what `beltAccent`
 * was validated for. `activeBeltAccent` so monochrome mode reaches it.
 *
 * No stripes and no rank bar: this names a belt, it does not report a rank.
 */
export function BeltMark({
  belt,
  width = 64,
  testID,
}: {
  belt: BeltKey;
  width?: number;
  testID?: string;
}) {
  const color = activeBeltAccent[belt];
  const height = Math.round((width * 30) / 64);

  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 64 30"
      accessibilityRole="image"
      accessibilityLabel={describeBelt(belt)}
      testID={testID ?? `belt-mark-${belt}`}
    >
      {/* The two wings — the strap running out to either side of the knot,
          dipping slightly as a tied belt does rather than running dead level. */}
      <Path d="M1 7 C 9 4, 17 4, 26 8 L 26 15 C 17 11, 9 11, 1 14 Z" fill={color} />
      <Path d="M63 7 C 55 4, 47 4, 38 8 L 38 15 C 47 11, 55 11, 63 14 Z" fill={color} />
      {/* The tails, hanging from under the knot and angled out. Cut on the
          diagonal, which is how a belt end actually hangs. */}
      <Path d="M26 15 L32 15 L28 29 L21 26 Z" fill={color} />
      <Path d="M38 15 L32 15 L36 29 L43 26 Z" fill={color} />
      {/* The knot last, so it sits over both wings and both tails. */}
      <Rect x="23" y="4" width="18" height="13" rx="3" fill={color} />
    </Svg>
  );
}
