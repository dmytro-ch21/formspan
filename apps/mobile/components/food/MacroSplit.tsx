/**
 * The three macros against their goals, on one line.
 *
 * ## Why this is not the thing the design doc refuses
 *
 * `nutrition-design.md` §5 rejects "six stacked ring-and-bar cards — the
 * dashboard graveyard Today's design doc exists to prevent". **The objection is
 * to the STACK**, and it was made against a competitor showing six of them.
 * Three figures on one row is a split; it is one line under the figure it
 * splits, and it adds no vertical card.
 *
 * The user asked for a ring or bar per macro showing consumed against goal, in
 * `0 / 141g` shape. That is what this is, at the size the objection allows.
 *
 * ## Where it refuses to guess
 *
 * With no target there is no goal, so it shows what was eaten and **no
 * denominator** — never `60 / 0g`, which reads as being over a limit nobody
 * set. With nothing loaded it shows dashes rather than zeros, for the reason
 * `EatenView` exists: an empty read is not a day nobody ate on.
 */

import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { macroSplit, viewTarget, viewTotals, type EatenView, type TargetView } from '@/lib/nutrition';

export function MacroSplit({
  eaten,
  view,
  testID,
}: {
  eaten: EatenView;
  view: TargetView;
  testID?: string;
}) {
  const accent = useAccent();
  const totals = viewTotals(eaten);
  const target = viewTarget(view);
  const macros = macroSplit(totals, target);

  return (
    <View style={styles.row} testID={testID ?? 'macro-split'}>
      {macros.map((m) => {
        // `null` totals means the read has not answered. A zero here would be
        // a claim about the day, so it is a dash.
        const eatenText = totals ? String(Math.round(m.eaten)) : '—';
        // The dash is for the eye. A screen reader announces it as "em dash"
        // or drops it entirely — "Protein: of 141 grams" — so the unloaded
        // state gets words instead. Found in review.
        const label = !totals
          ? `${m.label}: not loaded yet`
          : m.goal == null
            ? `${m.label}: ${eatenText} grams eaten, no goal set`
            : `${m.label}: ${eatenText} of ${m.goal} grams`;
        return (
          <View key={m.key} style={styles.cell} accessible accessibilityLabel={label}>
            <Text style={styles.figure} testID={`macro-${m.key}`}>
              {eatenText}
              {/* The denominator only exists when a goal does. */}
              {m.goal != null && <Text style={styles.goal}> / {m.goal}g</Text>}
            </Text>
            <Text style={[styles.label, { color: vola.textMuted }]}>{m.label}</Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${bar(m.eaten, m.goal)}%`,
                    // Over goal goes muted, never `danger` — one day over is
                    // not an error state, and a state colour spent here means
                    // nothing when something is actually wrong. Same rule
                    // `RemainingBlock` states for the calorie bar.
                    backgroundColor:
                      m.goal != null && m.eaten > m.goal ? vola.textDim : accent.accent,
                  },
                ]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** No goal means no bar to fill — 0%, not 100%. A full bar with no target
 *  would read as "done", which is a claim about a goal nobody set. */
function bar(eaten: number, goal: number | null): number {
  if (goal == null || goal <= 0) return 0;
  return Math.min(100, (eaten / goal) * 100);
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, marginTop: 14 },
  cell: { flex: 1 },
  figure: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  goal: { fontSize: 12, fontWeight: '600', color: vola.textMuted },
  label: { fontSize: 11, marginTop: 1 },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: vola.surfaceRaised,
    marginTop: 6,
    overflow: 'hidden',
  },
  fill: { height: 3, borderRadius: 2 },
});
