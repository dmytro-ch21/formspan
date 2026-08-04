import { StyleSheet, View } from 'react-native';

import { vola } from '@/constants/Colors';

/**
 * The icon set, drawn from plain views rather than SVG.
 *
 * **No `react-native-svg`, for the reason `Belt.tsx` already gives**: it is a
 * native dependency, so adding it means a prebuild and a fresh device build
 * for everyone — a steep price for a handful of glyphs. Every icon here is
 * straight rules, a circle, or a rotated corner, which views draw exactly.
 *
 * The geometry is lifted from `assets/brand/icons/*.svg` (the brand kit is the
 * source of truth) and re-expressed at the same proportions on a 24-unit grid.
 * `barbell` in particular is a literal transcription — `workout.svg` is five
 * straight strokes and nothing else, so the drawn version is not an
 * approximation of it, it *is* it.
 *
 * Stroke weight scales with size rather than being fixed: a 1.8pt stroke that
 * looks right at 24pt is a smudge at 12pt and a hairline at 40pt. The floor of
 * 1.1 stops it disappearing entirely on the smallest inline uses.
 *
 * Everything takes `color` and defaults to `textDim`, so an icon beside a
 * label inherits that label's rank instead of shouting over it. Icons are
 * decoration next to text that already says the same thing, so they are all
 * `accessible={false}` — a screen reader announcing "clock, 41 minutes" is
 * reading the furniture out loud.
 */

export type IconName =
  | 'barbell'
  | 'calendar'
  | 'check'
  | 'chevron'
  | 'layers'
  | 'timer';

export function Icon({
  name,
  size = 14,
  color = vola.textDim,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  // Proportional to the box, floored so it survives at inline sizes.
  const w = Math.max(1.1, size * 0.1);
  const box = { width: size, height: size };

  switch (name) {
    /**
     * A right-pointing chevron: one square corner, rotated.
     *
     * Two borders on a box beats two rotated rules here — the rules meet at a
     * mitre only if their overlap is computed (see `ScreenHeader`'s wordmark,
     * which does exactly that arithmetic), whereas a border corner is mitred
     * by the layout engine for free.
     */
    case 'chevron': {
      const arm = size * 0.4;
      return (
        <View style={[box, styles.center]} accessible={false}>
          <View
            style={{
              width: arm,
              height: arm,
              borderTopWidth: w,
              borderRightWidth: w,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
              // The rotated square's visual mass sits left of its box centre;
              // this pulls it back so a chevron in a row reads as centred.
              marginLeft: -arm * 0.2,
            }}
          />
        </View>
      );
    }

    /**
     * The same trick, two adjacent borders and a quarter-turn the other way.
     *
     * **Bottom + right, rotated +45° — the mirror of this is not a tick.** With
     * `borderLeft` and −45° both arms come out pointing *upward*, which draws a
     * symmetrical V; on a filled circle that reads as a downward chevron, i.e.
     * a disclosure control, on a card that is not expandable. Verified on the
     * Simulator, where it shipped wrong first.
     *
     * The asymmetry is the whole glyph: `height` is the long arm rising to the
     * right, `width` the short one dropping to the left.
     */
    case 'check': {
      const long = size * 0.62;
      const short = size * 0.32;
      return (
        <View style={[box, styles.center]} accessible={false}>
          <View
            style={{
              width: short,
              height: long,
              borderBottomWidth: w,
              borderRightWidth: w,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
              // The rotated glyph's mass sits low; this re-centres it in the box.
              marginTop: -size * 0.1,
            }}
          />
        </View>
      );
    }

    /**
     * A clock reading three o'clock.
     *
     * The brand icon's hand sits at about eleven, which needs a rotation about
     * one *end* of the hand rather than its centre — and rotating about a
     * point that isn't the centre means either `transformOrigin` or arithmetic
     * per size. Axis-aligned hands need neither and read as a clock just as
     * plainly. The crown on top is `timer.svg`'s `M9 2h6`, and it's what
     * separates this from a plain circle at 12pt.
     */
    case 'timer': {
      const d = size * 0.78;
      const hand = d * 0.3;
      return (
        <View style={[box, styles.center]} accessible={false}>
          <View
            style={{
              position: 'absolute',
              top: 0,
              width: size * 0.34,
              height: w,
              borderRadius: w,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              width: d,
              height: d,
              borderRadius: d / 2,
              borderWidth: w,
              borderColor: color,
              marginTop: size * 0.11,
            }}
          />
          {/* Both hands start at the dial's centre, so they are positioned
              from it rather than centred in the box — the dial is nudged down
              by the crown and the hands have to follow it. */}
          <View
            style={{
              position: 'absolute',
              top: size * 0.11 + d / 2 - hand,
              width: w,
              height: hand,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: size * 0.11 + d / 2 - w / 2,
              left: size / 2,
              width: hand * 0.8,
              height: w,
              backgroundColor: color,
            }}
          />
        </View>
      );
    }

    /**
     * `workout.svg`, stroke for stroke: `M6 9v6 M18 9v6 M3 10v4 M21 10v4
     * M6 12h12` — inner plates, outer plates, bar. The fractions below are
     * those coordinates over 24.
     */
    case 'barbell': {
      const plate = (h: number, left: number) => ({
        position: 'absolute' as const,
        left: size * left - w / 2,
        width: w,
        height: size * h,
        borderRadius: w,
        backgroundColor: color,
      });
      return (
        <View style={[box, styles.center]} accessible={false}>
          <View style={plate(0.25, 0.125)} />
          <View style={plate(0.25, 0.875)} />
          <View style={plate(0.42, 0.25)} />
          <View style={plate(0.42, 0.75)} />
          <View
            style={{
              width: size * 0.5,
              height: w,
              backgroundColor: color,
            }}
          />
        </View>
      );
    }

    /** Stacked rules — a count of things done, for a set tally. */
    case 'layers': {
      const rule = {
        width: size * 0.72,
        height: w,
        borderRadius: w,
        backgroundColor: color,
      };
      return (
        <View style={[box, styles.center, { gap: size * 0.16 }]} accessible={false}>
          <View style={rule} />
          <View style={rule} />
          <View style={rule} />
        </View>
      );
    }

    /** `calendar.svg`: the body, its header rule, and two binder tabs. */
    case 'calendar': {
      const body = size * 0.82;
      const tab = (left: number) => ({
        position: 'absolute' as const,
        top: 0,
        left: size * left - w / 2,
        width: w,
        height: size * 0.18,
        borderRadius: w,
        backgroundColor: color,
      });
      return (
        <View style={[box, styles.center]} accessible={false}>
          <View style={tab(0.33)} />
          <View style={tab(0.67)} />
          <View
            style={{
              width: body,
              height: body,
              marginTop: size * 0.14,
              borderWidth: w,
              borderColor: color,
              borderRadius: size * 0.14,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                marginTop: size * 0.16,
                width: '100%',
                height: w,
                backgroundColor: color,
              }}
            />
          </View>
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
