import { StyleSheet, View as RNView } from 'react-native';

import { vola } from '@/constants/Colors';
import type { TrendWeek } from '@/lib/trend';

/**
 * Weeks of training, as bars — the shape of the last two months.
 *
 * Sits under Recent, which answers "what did I just do". This answers "have I
 * been showing up", which is the only question about training that a list
 * cannot answer, and the only one worth putting on a screen whose job is to
 * get you to the gym.
 *
 * **Days trained, not tonnage.** A tonnage chart is one a BJJ athlete cannot
 * appear in: mat time produces no kilograms, so a mixed week renders as a
 * strength-only week and a pure BJJ month renders as nothing at all. This app
 * has already shipped that bug once, in the week summary that told a BJJ-only
 * athlete "0kg volume". See `lib/trend.ts`.
 *
 * **The current week is drawn hollow**, because it is not over. A part-week
 * bar next to seven finished ones reads as a decline that has not happened
 * yet — the chart would report a slump every Monday morning.
 */
export function TrendStrip({ weeks, testID }: { weeks: TrendWeek[]; testID?: string }) {
  // Against the tallest bar, floored at 3, so a quiet stretch does not inflate
  // one session into a full-height column. Not against 7: scaling to the
  // theoretical maximum makes every real week look like a failure.
  const peak = Math.max(3, ...weeks.map((w) => w.days));

  return (
    <RNView
      style={styles.wrap}
      testID={testID}
      // One element, one sentence. Fourteen bars is fourteen stops otherwise,
      // and "3" repeated has no meaning read out of order.
      accessible
      accessibilityRole="image"
      accessibilityLabel={summarise(weeks)}
    >
      {weeks.map((w) => (
        <RNView key={w.start} style={styles.col}>
          <RNView style={styles.track}>
            <RNView
              style={[
                styles.bar,
                // A floor of 2pt on an empty week, so the baseline stays a
                // line rather than a row of gaps — the gap is what a missing
                // column would look like, and every column here exists.
                { height: Math.max(2, (w.days / peak) * TRACK) },
                w.days === 0 && styles.barEmpty,
                w.current && styles.barCurrent,
              ]}
            />
          </RNView>
        </RNView>
      ))}
    </RNView>
  );
}

const TRACK = 34;

/** "Trained 3 days this week, 4 last week. 8 weeks shown." */
function summarise(weeks: TrendWeek[]): string {
  if (weeks.length === 0) return 'No training history yet.';
  const current = weeks[weeks.length - 1];
  const previous = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const head = `Trained ${days(current.days)} so far this week`;
  const tail = previous ? `, ${days(previous.days)} last week` : '';
  return `${head}${tail}. ${weeks.length} weeks shown, oldest first.`;
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
  },
  col: { flex: 1 },
  track: { height: TRACK, justifyContent: 'flex-end' },
  bar: { borderRadius: 3, backgroundColor: vola.green },
  // Not `transparent`: an absent bar and a zero bar are different facts, and
  // the baseline says the week existed and held nothing.
  barEmpty: { backgroundColor: vola.line },
  // Hollow, because the week is not finished — see the note above. An outline
  // rather than a lighter fill: at 2pt a fill difference is unreadable, and
  // this has to survive greyscale.
  barCurrent: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: vola.green,
  },
});
