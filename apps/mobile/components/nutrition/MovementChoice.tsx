import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { ActivityLevel } from '@/lib/activityLevel';

/**
 * How much you move when you are not training — three cards, one chosen.
 *
 * The reference draws these as cards in a row rather than as the stacked pills
 * this screen used to have: a glyph, a title, a two-line description, and a
 * radio at the foot, with the chosen one outlined in the accent and its radio
 * filled.
 *
 * ## The assumed state is not the chosen state, and they must not look alike
 *
 * Nobody has to pick one — the derivation runs at a documented default until
 * somebody does. That is a different fact from having chosen it, and the
 * contract carries `activity_chosen` precisely so a client can tell them apart.
 * An assumed card is drawn with a **dashed** border and an **empty** radio, and
 * its `accessibilityState.selected` stays false: a filled radio claims the
 * athlete decided this, and they did not.
 *
 * The dash is drawn in `textMuted` (4.67:1) rather than `textDim`, which the
 * palette records at 2.51:1 — under the 3:1 floor for a non-text element, so
 * the dashed-versus-solid distinction would simply not exist for a low-vision
 * reader. The state is carried in prose and in the spoken label as well, so
 * this was never the only channel; it costs nothing to make it legible.
 *
 * ## Selection persists, and this component is not what persists it
 *
 * That is #434, already merged: the choice is written to the device and pushed
 * to the account by the screen. This is a dumb control — it reports a press and
 * renders what it is told — so a rebuild of the visual layer cannot regress the
 * storage.
 */

/**
 * The kit icon for each level.
 *
 * `sedentary` is deliberately NOT the gear the first version used. The kit's
 * `settings` glyph means *settings* everywhere else in the app, and on this
 * screen it renders a couple of inches from the actual settings button — so the
 * one card whose meaning is "you sit at a screen all day" was drawing the
 * universal symbol for "change something". `dashboard` is a screen, which is
 * what a desk job is made of.
 */
const GLYPH = {
  sedentary: 'dashboard',
  light: 'route',
  active: 'running',
} as const;

export type MovementOption = {
  key: ActivityLevel;
  label: string;
  hint: string;
};

export function MovementChoice({
  options,
  chosen,
  /** The level the derivation used when nobody has chosen. */
  assumed,
  onChoose,
}: {
  options: readonly MovementOption[];
  chosen: ActivityLevel | null;
  assumed: ActivityLevel | null;
  onChoose: (level: ActivityLevel) => void;
}) {
  const accent = useAccent();

  return (
    <RNView style={styles.row}>
      {options.map((o) => {
        const isOn = chosen === o.key;
        const isAssumed = chosen === null && assumed === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChoose(o.key)}
            style={({ pressed }) => [
              styles.card,
              isOn && { borderColor: accent.accent, borderWidth: 1.5 },
              isAssumed && styles.assumed,
              pressed && styles.pressed,
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: isOn, checked: isOn }}
            accessibilityLabel={
              isAssumed
                ? `${o.label}. ${o.hint}. Assumed — you have not chosen yet.`
                : `${o.label}. ${o.hint}`
            }
            testID={`target-activity-${o.key}`}
          >
            <RNView style={styles.glyphWrap}>
              <RNView
                style={[styles.disc, isOn && { backgroundColor: accent.accent, opacity: 0.16 }]}
              />
              <Icon name={GLYPH[o.key]} size={17} color={isOn ? accent.ink : vola.textMuted} />
            </RNView>
            <Text style={[styles.title, isOn && { color: accent.ink }]}>{o.label}</Text>
            <Text style={styles.hint}>{o.hint}</Text>
            <RNView style={styles.radioWrap}>
              <Radio on={isOn} colour={accent.accent} ink={accent.on} />
            </RNView>
          </Pressable>
        );
      })}
    </RNView>
  );
}

/**
 * The radio at the foot of a card.
 *
 * A tick inside a filled disc when chosen, an empty outline otherwise — drawn
 * rather than composed from bordered views, because a check mark built from two
 * rotated borders rendered as a downward chevron here once and 241 tests stayed
 * green. Icons are drawings.
 *
 * Hidden from assistive tech: the card's own `accessibilityState` already says
 * whether it is selected, and a screen reader announcing both reads the state
 * twice.
 */
function Radio({ on, colour, ink }: { on: boolean; colour: string; ink: string }) {
  return (
    <RNView accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={22} height={22} viewBox="0 0 22 22">
        <Circle
          cx={11}
          cy={11}
          r={9.2}
          fill={on ? colour : 'none'}
          stroke={on ? colour : vola.textDim}
          strokeWidth={1.4}
        />
        {on && (
          <Path
            d="M6.6 11.2l3 3 5.8-5.8"
            stroke={ink}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        )}
      </Svg>
    </RNView>
  );
}

const styles = StyleSheet.create({
  // Wraps at accessibility sizes rather than squeezing three cards into a
  // 393pt row — three columns of six characters each is not a legible control.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    flexGrow: 1,
    flexBasis: 104,
    minWidth: 104,
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    paddingHorizontal: 11,
    paddingTop: 11,
    paddingBottom: 10,
    gap: 4,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  assumed: { borderStyle: 'dashed', borderColor: vola.textMuted },
  glyphWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  disc: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 17 },
  title: { fontSize: 14, fontWeight: '700' },
  hint: { fontSize: 11, lineHeight: 15, color: vola.textDim },
  // `marginTop: auto` pins the radio to the foot of the tallest card, so three
  // cards with different-length hints still line their radios up.
  radioWrap: { marginTop: 'auto', paddingTop: 8, alignItems: 'center' },
});
