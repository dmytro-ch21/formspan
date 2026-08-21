import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { MACRO_LABEL, type MacroRow } from '@/lib/macroModel';

/**
 * The four macros as a row of tiles, under the calorie figure.
 *
 * The reference's tiles each carry a coloured glyph in a circle, the value
 * large, the label beneath in the macro's own colour, and a thin coloured bar
 * across the bottom.
 *
 * ## What the bar is, and what it is not
 *
 * **It is a share of the four, not progress toward anything.** This screen is
 * about a target that has not been accepted yet — nothing has been eaten
 * against it, so there is no progress to draw, and drawing one would be the
 * "zeroes presented as achievements" the acceptance criteria forbid. Each bar
 * is that macro's grams as a fraction of the largest of the four, which makes
 * the row readable as a shape at a glance — protein dominant, fibre small —
 * without asserting anything about the day.
 *
 * Scaling to the LARGEST rather than to the total is deliberate: as a fraction
 * of the total, fibre's 25g of 395g is 6% and renders as a bar too short to
 * see, so the one macro whose bar most needs to say "this is the small one"
 * would say nothing at all instead. Against the largest, the row is a set of
 * relative lengths with a full one at the top, which is what the reference
 * draws.
 *
 * Hidden from assistive tech, because it is redundant: the value and the label
 * beside it are the content, and a screen reader announcing four unlabelled
 * progress bars is reading the furniture out loud.
 *
 * ## The empty state is a dash, not a zero
 *
 * A tile with no number renders `—`, keeps its label and draws no bar. "0 g of
 * protein" is a claim about a plan; "we do not have this yet" is the truth.
 */

/** The kit icon that stands for each macro. */
const GLYPH = {
  protein: 'nutrition',
  fat: 'water',
  carbs: 'calories',
  fibre: 'heart',
} as const;

export function MacroTiles({ rows, testID }: { rows: readonly MacroRow[]; testID?: string }) {
  const most = Math.max(0, ...rows.map((r) => r.grams ?? 0));

  return (
    <RNView style={styles.row} testID={testID}>
      {rows.map((r) => (
        <RNView key={r.key} style={styles.tile} testID={`macro-tile-${r.key}`}>
          <RNView style={styles.top}>
            {/*
              The glyph's disc is the macro colour held well back, with the
              glyph itself at full strength on top — the reference's treatment,
              and the reason it works is that a saturated disc behind a
              saturated glyph leaves the glyph invisible. 0.16 keeps the disc a
              tint of the card rather than a second object.
            */}
            <RNView style={[styles.disc, { backgroundColor: r.colour, opacity: 0.16 }]} />
            <RNView style={styles.discGlyph}>
              <Icon name={GLYPH[r.key]} size={13} color={r.colour} />
            </RNView>
            <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {r.grams == null ? '—' : `${r.grams} g`}
            </Text>
          </RNView>
          <Text style={[styles.label, { color: r.colour }]} numberOfLines={1}>
            {MACRO_LABEL[r.key].toUpperCase()}
          </Text>
          <RNView
            style={styles.track}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {r.grams != null && most > 0 ? (
              <RNView
                style={[
                  styles.fill,
                  { backgroundColor: r.colour, width: `${Math.max(6, (r.grams / most) * 100)}%` },
                ]}
              />
            ) : null}
          </RNView>
        </RNView>
      ))}
    </RNView>
  );
}

const styles = StyleSheet.create({
  // `flexWrap` so that at accessibility text sizes the four tiles become two
  // rows of two rather than four slivers. `minWidth` on the tile is what makes
  // the wrap happen instead of each tile squeezing to nothing — the same
  // failure `Row`'s `flex: 1` label column had on this screen, which is what
  // #484 measured.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    flexGrow: 1,
    flexBasis: 76,
    minWidth: 76,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    paddingHorizontal: 9,
    paddingTop: 9,
    paddingBottom: 8,
    gap: 4,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  disc: { position: 'absolute', left: 0, width: 22, height: 22, borderRadius: 11 },
  discGlyph: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  value: {
    fontSize: 16,
    fontWeight: '800',
    // Tabular, so 75 g and 205 g do not shuffle the label under them.
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  label: { fontSize: 10, fontWeight: '800', letterSpacing: 0.9 },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: vola.line,
    overflow: 'hidden',
    marginTop: 2,
  },
  fill: { height: 3, borderRadius: 2 },
});
