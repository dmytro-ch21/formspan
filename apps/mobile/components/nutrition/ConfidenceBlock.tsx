import { StyleSheet, View as RNView } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  CONFIDENCE_TARGET_DAYS,
  type Confidence,
  type DayConfidence,
} from '@/lib/confidence';

/**
 * "Can this target be judged yet?" — the fortnight, drawn.
 *
 * A shield, a sentence, fourteen dots and a ring. The reference's own layout,
 * and each part earns its place:
 *
 *  - **the dots** are the individual days, so a gap is attributable rather than
 *    an aggregate. Fourteen dots and "6 of 14" say different things: the count
 *    says how much, the row says *when*, and a fortnight with the last four
 *    days missing is a different situation from one with four missing a
 *    fortnight ago.
 *  - **the ring** is the same number read from across the room. It is
 *    deliberately the accent rather than a macro colour — this is progress
 *    through a task, not a category.
 *
 * ## A partial day is drawn as a half, and it is not counted
 *
 * `confidence.ts` decides what partial means; this draws it as a dot filled on
 * the left half only. The three states have to be distinguishable **without**
 * colour, because the whole set is one hue: empty is an outline, partial is a
 * half disc, logged is a full one. Shape carries it, and the spoken label
 * carries it again.
 *
 * ## Nothing here is allowed to congratulate
 *
 * With no entries at all the ring reads 0 of 14 and the copy says the fortnight
 * has not started — a zero that is a statement of fact, in the one place a zero
 * is honest, because the denominator is right beside it. What it must never do
 * is present that as an achievement or hide it: an athlete told nothing about
 * their evidence will read the target as better-founded than it is, which is
 * the whole reason this block exists.
 */

/**
 * How big the dots are, and the gap between them.
 *
 * **Fourteen have to fit on one line, and at 11pt with a 5pt gap they did
 * not** — measured on an iPhone 17 Pro, where the row leaves about 204pt once
 * the shield and the ring have taken theirs, and fourteen 11pt dots need 219.
 * They wrapped 12 + 2, which reads as a broken grid rather than as a fortnight.
 * 9 and 4 need 178.
 *
 * The row still carries `flexWrap`, because at accessibility text sizes the
 * prose beside it grows and the arithmetic changes again — wrapping is the
 * graceful failure, not the intended one.
 */
const DOT = 9;
const DOT_GAP = 4;

export function ConfidenceBlock({ c }: { c: Confidence }) {
  const accent = useAccent();
  const pct = c.considered > 0 ? Math.round((c.logged / c.considered) * 100) : 0;

  return (
    <RNView style={styles.wrap} testID="target-confidence">
      <RNView style={styles.shield}>
        <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3l7 3v5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Z"
            stroke={accent.ink}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
          <Path d="M12 9v5M9.5 11.5h5" stroke={accent.ink} strokeWidth={1.6} strokeLinecap="round" />
        </Svg>
      </RNView>

      <RNView style={styles.main}>
        <Text style={styles.title}>{c.enough ? 'Enough to judge this by' : 'Getting accurate results'}</Text>
        <Text style={styles.body}>
          {c.enough
            ? `A target is judged over ${c.considered} days, and yours has ${c.logged}. ` +
              'The weekly check can tell whether this number is working.'
            : `A target needs ${c.considered} days before it is judged. Log at least ` +
              `${CONFIDENCE_TARGET_DAYS} of the last ${c.considered} days so we can give you ` +
              'accurate feedback.'}
        </Text>

        <RNView
          style={styles.dots}
          accessible
          accessibilityRole="text"
          accessibilityLabel={spoken(c)}
          testID="confidence-dots"
        >
          {c.days.map((d) => (
            <Dot key={d.day} state={d.state} colour={accent.accent} />
          ))}
        </RNView>

        <Text style={styles.count}>
          {`${c.logged} of ${c.considered} days logged`}
          {partialCount(c) > 0 ? ` · ${partialCount(c)} part-logged` : ''}
        </Text>
      </RNView>

      <Ring pct={pct} logged={c.logged} considered={c.considered} colour={accent.accent} />
    </RNView>
  );
}

/**
 * One day.
 *
 * The half state is an SVG rather than a clipped view, because a half-filled
 * circle drawn with `overflow: hidden` and a child at 50% width renders a
 * D-shape whose flat edge is the CHILD's edge — correct here by luck and wrong
 * the moment the radius changes. A path says what it means.
 */
function Dot({ state, colour }: { state: DayConfidence; colour: string }) {
  const r = DOT / 2;
  if (state === 'logged') {
    return <RNView style={[styles.dot, { backgroundColor: colour }]} />;
  }
  if (state === 'empty') {
    // Outline only. `line` rather than `lineSoft`: the palette's own note puts
    // `lineSoft` on this ground near 1.2:1, and an untrained day still has to
    // be a day rather than a smudge — the same argument `gridRest` records.
    return <RNView style={[styles.dot, styles.dotEmpty]} />;
  }
  return (
    <Svg width={DOT} height={DOT}>
      <Circle cx={r} cy={r} r={r - 0.5} stroke={vola.line} strokeWidth={1} fill="none" />
      <Path d={`M${r} 0.5 A ${r - 0.5} ${r - 0.5} 0 0 0 ${r} ${DOT - 0.5} Z`} fill={colour} />
    </Svg>
  );
}

/** The count, as a ring — the same figure, readable from further away. */
function Ring({
  pct,
  logged,
  considered,
  colour,
}: {
  pct: number;
  logged: number;
  considered: number;
  colour: string;
}) {
  const size = 62;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  // `- 0.001` so a full ring does not close on a dash boundary and leave a
  // hairline seam at twelve o'clock — the same guard `ProgressRing` records.
  const filled = circumference * (Math.max(0, Math.min(100, pct)) / 100) - 0.001;

  return (
    <RNView
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${logged} of ${considered} days logged`}
      testID="confidence-ring"
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={vola.line} strokeWidth={stroke} fill="none" />
        {filled > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colour}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            fill="none"
          />
        )}
      </Svg>
      <RNView style={styles.ringCentre} pointerEvents="none">
        <Text style={styles.ringValue}>{logged}</Text>
        <Text style={styles.ringOf}>{`of ${considered}`}</Text>
      </RNView>
    </RNView>
  );
}

function partialCount(c: Confidence): number {
  return c.days.filter((d) => d.state === 'partial').length;
}

/**
 * The row of dots, said out loud.
 *
 * One label on the group rather than fourteen elements: touch-exploring
 * fourteen unlabelled dots is worse than not exposing them, and the useful
 * content is the shape — how many, and whether the gaps are recent.
 */
function spoken(c: Confidence): string {
  const part = partialCount(c);
  const recent = c.days.slice(-3).every((d) => d.state === 'empty');
  return (
    `${c.logged} of the last ${c.considered} days logged` +
    (part > 0 ? `, ${part} only part-logged` : '') +
    (recent && c.logged > 0 ? '. The last three days are missing.' : '.')
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  shield: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `flexShrink` rather than a fixed width, so the ring keeps its size and the
  // prose reflows — the opposite of the `flex: 1` collapse #484 measured on the
  // arithmetic rows, where the LABEL was the thing squeezed to nothing.
  main: { flex: 1, gap: 4, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '700' },
  body: { fontSize: 12, lineHeight: 17, color: vola.textMuted },
  // Wrapping, because fourteen dots at 11pt plus gaps is 175pt and a narrow
  // phone at a large text size has less than that.
  dots: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: DOT_GAP, marginTop: 3 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  dotEmpty: { borderWidth: 1, borderColor: vola.line },
  count: { fontSize: 11, color: vola.textDim, marginTop: 2 },
  ringCentre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'], lineHeight: 23 },
  ringOf: { fontSize: 10, color: vola.textDim },
});
