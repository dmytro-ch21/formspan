import Svg, { Path, Rect } from 'react-native-svg';

import { describeBelt } from '@/components/Belt';
import { activeBeltAccent, type BeltKey } from '@/constants/Colors';

/**
 * A **tied** belt — **the HERO / IDENTITY rendering.**
 *
 * ## Which of the two belt renderings to use
 *
 * There are exactly two, and they are deliberate. Reach for this one where the
 * belt **names the screen you are on** and is the largest thing in the header:
 * the roadmap hero is the first and currently only such slot. The knot is why
 * it exists — at 64pt a flat strap reads as a coloured rectangle.
 *
 * `components/Belt.tsx` is the other: the belt as a physical object, a flat
 * strap with its rank bar, for **list rows and rank displays**. That one draws
 * stripes and black-belt degrees; **this one carries neither**, because it
 * names a belt rather than reporting a rank. Anything at 44pt list-row scale,
 * and anything that has to show stripes, is that one and not this.
 *
 * **They are two drawings on purpose. Do not consolidate them, and do not draw
 * a third.** Consolidating silently changes every rank display in the app; a
 * third one appears when somebody finds neither of these and starts from
 * scratch, which is why each file points at the other. `check:palette` catches
 * colour drift between them because **both take their colours from
 * `constants/Colors.ts`** — `activeBeltAccent` here, `activeStrap` /
 * `activeRankBar` there — and never from a literal. Nothing catches SHAPE
 * drift, so if you change what one of them draws, look at the other.
 *
 * **In the belt's ACCENT, not its strap colour**, which is the one place this
 * departs from `Belt`. A strap colour is a picture of dyed cotton (#1B4CC4
 * blue measures 2.50:1 against `surface`); this is a 16pt-tall mark on a
 * near-black ground doing signalling work, which is exactly what `beltAccent`
 * was validated for. `activeBeltAccent` so monochrome mode reaches it.
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
