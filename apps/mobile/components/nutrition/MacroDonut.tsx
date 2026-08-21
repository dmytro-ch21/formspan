import { StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { macroArcs, type MacroRow } from '@/lib/macroModel';

/**
 * The macro split — a four-segment ring and the legend that names it.
 *
 * ## The ring is by grams, and the section header says so
 *
 * The reference's `g per day` pill is what makes this ring honest rather than
 * decorative. An energy donut is the obvious alternative and is not available:
 * **fibre is a carbohydrate**, so protein + fat + carbs + fibre does not
 * partition the calories, and a four-slice energy ring would count some of them
 * twice. By grams the ring is a picture of the four numbers listed beside it
 * and of nothing else — a claim it can keep. `macroArcs` holds that reasoning;
 * this file draws what it returns.
 *
 * ## The legend is the ring's only label, which is why the colours were fought for
 *
 * A segment carries no text. That is the single reason the macro palette is
 * held to a full pairwise ΔE 15 under three colour-vision simulations rather
 * than the weaker bar a labelled chip gets — and it is why the reference's own
 * blue and violet could not be used unchanged. See `macroColors` in
 * `constants/Colors.ts`.
 *
 * Order is shared: the legend's third row is the third arc clockwise, because
 * `macroArcs` and the rows come from one `MACRO_ORDER`.
 *
 * ## Nothing to draw draws nothing
 *
 * With no grams there are no arcs, and the ring renders as an empty track with
 * a dash — not four equal quarters, which would be a picture of a split nobody
 * has.
 */

const SIZE = 118;
const STROKE = 19;

export function MacroDonut({ rows }: { rows: readonly MacroRow[] }) {
  const arcs = macroArcs(rows);
  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;

  // Arcs are laid end to end with `strokeDashoffset`, walking a running total.
  // A gap of ~1.5pt between segments so four abutting fills read as four rather
  // than as one multicoloured band — subtracted from each arc's length rather
  // than added to the offset, so the ring still closes exactly.
  //
  // The running total is resolved into `segments` BEFORE the JSX rather than
  // accumulated inside the `map`. `react-hooks/immutability` is an error in this
  // app and is right to be: a variable mutated by a render callback is a value
  // whose result depends on how many times React chose to call it, and under
  // StrictMode's double invocation the second pass would start from a total the
  // first pass left behind. Here it would draw the ring twice round.
  const GAP = arcs.length > 1 ? 1.5 : 0;
  const segments: { key: string; colour: string; length: number; offset: number }[] = [];
  let walked = 0;
  for (const a of arcs) {
    segments.push({
      key: a.key,
      colour: a.colour,
      length: Math.max(0, circumference * a.fraction - GAP),
      offset: -circumference * walked,
    });
    walked += a.fraction;
  }

  return (
    <RNView style={styles.wrap} testID="macro-donut">
      <RNView
        style={styles.ringWrap}
        accessible
        accessibilityRole="image"
        accessibilityLabel={spoken(rows)}
      >
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={r}
            stroke={vola.surfaceRaised}
            strokeWidth={STROKE}
            fill="none"
          />
          {segments.map((seg) => (
            <Circle
              key={seg.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={r}
              stroke={seg.colour}
              strokeWidth={STROKE}
              strokeDasharray={`${seg.length} ${circumference}`}
              strokeDashoffset={seg.offset}
              // Twelve o'clock, clockwise. Without this an arc starts at three
              // o'clock, which reads as the ring being rotated.
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              fill="none"
            />
          ))}
        </Svg>
        {arcs.length === 0 ? (
          <RNView style={styles.centre} pointerEvents="none">
            <Text style={styles.empty}>—</Text>
          </RNView>
        ) : null}
      </RNView>

      <RNView style={styles.legend}>
        {rows.map((row) => (
          <RNView key={row.key} style={styles.legendRow} testID={`macro-row-${row.key}`}>
            <RNView style={[styles.dot, { backgroundColor: row.colour }]} />
            <Text style={styles.name}>{row.label}</Text>
            {row.rule ? (
              <Text style={styles.rule} numberOfLines={2}>
                {row.rule}
              </Text>
            ) : null}
            <Text style={[styles.grams, { color: row.colour }]}>
              {row.grams == null ? '—' : `${row.grams} g`}
            </Text>
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

/** The ring, said out loud — the picture's content, not its shape. */
function spoken(rows: readonly MacroRow[]): string {
  const said = rows
    .filter((r) => r.grams != null)
    .map((r) => `${r.label} ${r.grams} grams`)
    .join(', ');
  return said ? `Macro split by grams: ${said}` : 'Macro split — no figures yet';
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 12,
  },
  ringWrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  centre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { fontSize: 20, color: vola.textDim },
  // `flexBasis` past which the legend drops below the ring rather than
  // shredding its four rows into single characters.
  legend: { flexGrow: 1, flexBasis: 168, minWidth: 168, gap: 2 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 5 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  name: { fontSize: 13, fontWeight: '700' },
  // The rule takes whatever room is left and yields it first: it is the least
  // important thing in the row, and the value must never be pushed off.
  rule: { fontSize: 11, color: vola.textDim, flexShrink: 1, flexGrow: 1 },
  grams: {
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto',
    paddingLeft: 6,
  },
});
