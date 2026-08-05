import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { vola } from '@/constants/Colors';
import { BRAND_ICONS, type BrandIconName, type Primitive } from './icons.generated';

/**
 * The icon set — the brand kit's own geometry, rendered.
 *
 * This used to draw every icon out of `View`s with borders and rotations,
 * because the rule was that `react-native-svg` is a native dependency and
 * therefore a prebuild and a fresh device build for everyone. **That premise
 * was wrong for this SDK.** It is in Expo's `bundledNativeModules.json` at
 * 15.15.4 — it ships *inside* Expo Go, so adding it costs no prebuild and
 * breaks no workflow.
 *
 * The old rule had a real cost. A check mark drawn from two borders rendered as
 * a downward chevron for a while: the geometry was a mirror of a tick, 241
 * tests were green, and it was caught only by looking at a Simulator. Icons are
 * drawings; they belong in a drawing format.
 *
 * Geometry is **generated** from `assets/brand/icons/*.svg` by
 * `scripts/generate_icons.mjs`, never hand-copied — `verify` fails if the
 * generated file has drifted from the kit. Recolour with the `color` prop
 * rather than forking an icon; the kit's `currentColor` is what makes that work.
 *
 * Everything defaults to `textDim`, so an icon beside a label inherits that
 * label's rank instead of shouting over it. And **every icon is hidden from
 * assistive technology**: they sit next to text that already says the same
 * thing, and a screen reader announcing "clock, 41 minutes" is reading the
 * furniture out loud. An icon that is genuinely the only content needs a
 * labelled `Pressable` around it, not an exception here.
 */

/**
 * Icons the app needs that the brand kit does not have.
 *
 * Deliberately small, and each is here because the kit has no equivalent rather
 * than because the kit's version was inconvenient. If one ever gets a real
 * counterpart in `assets/brand/icons/`, delete it from here — a local copy of
 * an icon the kit also defines is exactly the drift the generator prevents.
 */
const EXTRA = {
  /** Disclosure. The kit has no chevron; it is chrome rather than iconography. */
  chevron: [{ t: 'p', d: 'M9 5l7 7-7 7' }],
  'chevron-down': [{ t: 'p', d: 'M5 9l7 7 7-7' }],
  /** Back. The same stroke, mirrored. */
  back: [{ t: 'p', d: 'M15 5l-7 7 7 7' }],
  /** Sets in a session — the "20 sets" meta row. */
  layers: [{ t: 'p', d: 'M4 7h16M4 12h16M4 17h10' }],
  /** Dismiss. Chrome, like the chevrons — the kit has no close glyph. */
  close: [{ t: 'p', d: 'M6 6l12 12M18 6L6 18' }],
} as const satisfies Record<string, readonly Primitive[]>;

/**
 * Names the app used before the kit did.
 *
 * Kept so call sites do not churn for a rename: `barbell` is what the session
 * rows have always asked for, and `workout` is what the kit calls the same
 * drawing.
 */
const ALIAS = { barbell: 'workout' } as const;

export type IconName = BrandIconName | keyof typeof EXTRA | keyof typeof ALIAS;

function primitives(name: IconName): readonly Primitive[] {
  if (name in ALIAS) return BRAND_ICONS[ALIAS[name as keyof typeof ALIAS]];
  if (name in EXTRA) return EXTRA[name as keyof typeof EXTRA];
  return BRAND_ICONS[name as BrandIconName];
}

export function Icon({
  name,
  size = 14,
  color = vola.textDim,
  strokeWidth,
}: {
  name: IconName;
  size?: number;
  color?: string;
  /**
   * Overrides the kit's 1.8. Worth setting only when an icon is rendered far
   * from 24pt — a hairline at 40pt and a slab at 12pt are the two ways a
   * uniform stroke stops looking uniform.
   */
  strokeWidth?: number;
}) {
  const sw = strokeWidth ?? 1.8;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {primitives(name).map((p, i) =>
        p.t === 'p' ? (
          <Path
            key={i}
            d={p.d}
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : p.t === 'c' ? (
          <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} stroke={color} strokeWidth={sw} />
        ) : (
          <Rect
            key={i}
            x={p.x}
            y={p.y}
            width={p.w}
            height={p.h}
            rx={p.rx}
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        ),
      )}
    </Svg>
  );
}
