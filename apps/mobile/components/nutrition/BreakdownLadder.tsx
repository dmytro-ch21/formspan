import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';

/**
 * The arithmetic — resting rate, movement, training, maintenance, phase, result.
 *
 * ## Every line, or none of it
 *
 * A calorie target is an argument, and an argument you cannot inspect is a
 * verdict. This project's standing principle is auditable recommendations and
 * this is the surface where that gets paid for, so the ladder shows every step
 * including the ones that are unflattering — a clamped rail is stated out loud,
 * because without the line the last step visibly does not follow from the one
 * above it and a reader concludes the app cannot add up.
 *
 * ## Why the rows are a card and not a list of `Row`s
 *
 * The previous version used a shared `Row` whose label column was `flex: 1`
 * against a large tabular value. #484 measured what that does at accessibility
 * text sizes: "Resting rate" squeezed onto **three narrow lines** beside
 * `1840 kcal`. The fix is not a bigger flex basis, it is giving the value
 * permission to go **below** the label rather than beside it — so this row is a
 * `flexWrap` container where the value is a normal sibling that wraps when it
 * no longer fits. At default sizes that is indistinguishable from the
 * reference's two-column row; at accessibility sizes it becomes two lines
 * instead of five.
 *
 * ## The footer is the answer, and it is never collapsed
 *
 * "This works out to N kcal" is the only line in this section an athlete
 * strictly needs, so it sits outside the collapsible body. The heading is not
 * "Your target": that was its name when the derivation was the only way to get
 * a number, and with three sources on one screen it would name something nobody
 * has chosen. What is in force is at the top of the screen and says so.
 */

export type LadderRow = {
  key: string;
  glyph: IconName;
  /** The macro-ish colour of the step's glyph disc. */
  colour: string;
  label: string;
  /** The one-line justification beneath the label. Null when there is none. */
  hint: string | null;
  value: string;
  /** `up` renders the value in the accent, `down` in `danger`, null plain. */
  direction: 'up' | 'down' | null;
  /** Heavier type — the running total lines. */
  strong?: boolean;
};

export function BreakdownLadder({
  rows,
  result,
  onChangePhase,
  changePhaseLabel,
  note,
  testID,
}: {
  rows: readonly LadderRow[];
  /** The bottom line. Null when the derivation produced nothing. */
  result: string | null;
  onChangePhase: () => void;
  changePhaseLabel: string;
  /** A clamp explanation, or anything else the arithmetic owes the reader. */
  note?: string | null;
  testID?: string;
}) {
  const accent = useAccent();

  return (
    <RNView style={styles.wrap} testID={testID}>
      <RNView style={styles.rows}>
        {rows.map((r, i) => (
          <RNView
            key={r.key}
            style={[styles.row, i > 0 && styles.rowRule]}
            testID={`ladder-${r.key}`}
          >
            <RNView style={styles.glyphWrap}>
              <RNView style={[styles.disc, { backgroundColor: r.colour, opacity: 0.16 }]} />
              <Icon name={r.glyph} size={15} color={r.colour} />
            </RNView>
            <RNView style={styles.main}>
              <Text style={[styles.label, r.strong && styles.labelStrong]}>{r.label}</Text>
              {r.hint ? <Text style={styles.hint}>{r.hint}</Text> : null}
            </RNView>
            <Text
              style={[
                styles.value,
                r.strong && styles.valueStrong,
                r.direction === 'up' && { color: accent.ink },
                r.direction === 'down' && { color: vola.danger },
              ]}
            >
              {r.value}
            </Text>
          </RNView>
        ))}
      </RNView>

      {note ? <Text style={styles.note}>{note}</Text> : null}

      <RNView style={styles.foot}>
        <RNView style={styles.footMain}>
          <Text style={styles.footLead}>This works out to</Text>
          <Text style={[styles.footValue, { color: accent.ink }]} testID="ladder-result">
            {result ?? '—'}
          </Text>
          <Text style={styles.footNote}>Daily calorie target</Text>
        </RNView>
        <Pressable
          onPress={onChangePhase}
          style={styles.phase}
          accessibilityRole="button"
          accessibilityLabel={changePhaseLabel}
          testID="target-phase"
        >
          <Text style={[styles.phaseText, { color: accent.ink }]}>{changePhaseLabel}</Text>
          <Icon name="chevron" size={13} color={accent.ink} />
        </Pressable>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  rows: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    overflow: 'hidden',
  },
  // The wrap is the fix for #484's collapsed label column — see the note at the
  // top. `alignItems: 'center'` keeps the two-column case looking like a row;
  // once the value wraps it becomes a left-aligned block, which is correct.
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vola.lineSoft },
  glyphWrap: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  disc: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 14 },
  // `flexBasis: 0` with `flexGrow` rather than `flex: 1`, and `minWidth` is
  // what actually stops the collapse: below it the value wraps to the next line
  // instead of the label shredding.
  main: { flexGrow: 1, flexBasis: 120, minWidth: 120, gap: 1 },
  label: { fontSize: 14, color: vola.text },
  labelStrong: { fontWeight: '700' },
  hint: { fontSize: 11, color: vola.textDim, lineHeight: 15 },
  value: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: vola.text,
    marginLeft: 'auto',
  },
  valueStrong: { fontSize: 15, fontWeight: '800' },
  note: { fontSize: 11, color: vola.textMuted, lineHeight: 16, paddingHorizontal: 2 },
  foot: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  footMain: { flexGrow: 1, flexBasis: 150, minWidth: 150, gap: 1 },
  footLead: { fontSize: 11, color: vola.textDim },
  footValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'], lineHeight: 26 },
  footNote: { fontSize: 11, color: vola.textDim },
  phase: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, paddingVertical: 4 },
  phaseText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
});
