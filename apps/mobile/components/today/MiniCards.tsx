import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { vola } from '@/constants/Colors';
import { dayString } from '@/lib/calendar';

/**
 * The two small cards at the foot of Today: `TRAINING` and `LOGGING`.
 *
 * Both are one-question cards, and both are built around the same refusal: a
 * count that has not been read yet renders as an absence, never as `0`. On a
 * dashboard this is the most tempting place in the app to show a zero, because
 * a zero fits the layout perfectly and an absence does not.
 */

export const TRAINING_WINDOW_DAYS = 28;

export type TrainingCardProps = {
  /**
   * Sessions and distinct days in the trailing window, or null until the read
   * settles. **Counted in SQLite** — see `trainingSince` — rather than derived
   * from Today's row-capped session list, which saturates and under-reports.
   */
  training: { sessions: number; days: number } | null;
  onPress: () => void;
  testID?: string;
};

/**
 * `TRAINING` — sessions in the last 28 days, with a ring.
 *
 * ## What the ring is a percentage OF
 *
 * The reference shows `27` over `sessions in 28 days` beside a ring reading
 * `96%`, and 27/28 is 96.4% — so the reference's ring is sessions ÷ days.
 *
 * **This one is DAYS TRAINED ÷ 28 instead**, and the difference matters. A
 * sessions-per-day ratio exceeds 100% the moment somebody trains twice in a
 * day, and a ring that can pass its own full turn is either lying or wrapping —
 * neither of which means anything for "how consistent have I been". Days
 * trained cannot exceed the window, so the ring is always a real fraction of a
 * real thing.
 *
 * The headline number stays SESSIONS, because that is what the athlete did.
 * Where the two differ the card says so — `27 sessions · 24 days` — rather than
 * letting one stand in for the other.
 */
export function TrainingCard({ training, onPress, testID }: TrainingCardProps) {
  const pct =
    training == null ? null : Math.min(100, (training.days / TRAINING_WINDOW_DAYS) * 100);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        training == null
          ? 'Training, still loading'
          : training.sessions === 0
            ? `No sessions in the last ${TRAINING_WINDOW_DAYS} days`
            : `${training.sessions} sessions on ${training.days} days in the last ${TRAINING_WINDOW_DAYS} days`
      }
      style={({ pressed }) => [styles.mini, pressed && styles.pressed]}
      testID={testID}
    >
      <RNView style={styles.miniHead}>
        <Icon name="workout" size={13} color={vola.textMuted} />
        <Text style={styles.miniLabel}>TRAINING</Text>
      </RNView>

      <RNView style={styles.miniBody}>
        <RNView style={styles.miniFigures}>
          {training == null ? (
            <Text style={styles.miniAbsent}>Checking…</Text>
          ) : training.sessions === 0 ? (
            // Not "0 sessions" in the big figure — a zero rendered as a
            // headline reads as a score.
            <Text style={styles.miniAbsent}>Nothing logged in the last {TRAINING_WINDOW_DAYS} days</Text>
          ) : (
            <>
              <Text style={styles.miniValue}>{training.sessions}</Text>
              <Text style={styles.miniMeta}>
                {training.sessions === 1 ? 'session' : 'sessions'} in {TRAINING_WINDOW_DAYS} days
              </Text>
              {training.days !== training.sessions ? (
                <Text style={styles.miniSub}>
                  on {training.days} {training.days === 1 ? 'day' : 'days'}
                </Text>
              ) : null}
            </>
          )}
        </RNView>

        <ProgressRing
          percent={pct}
          size={54}
          stroke={5}
          color={vola.lime}
          label={
            pct == null
              ? 'Days trained, not yet known'
              : `Trained on ${training?.days ?? 0} of the last ${TRAINING_WINDOW_DAYS} days`
          }
          testID="training-ring"
        />
      </RNView>
    </Pressable>
  );
}

export type LoggingCardProps = {
  /** `YYYY-MM-DD` keys with a food entry. Null until the read settles. */
  loggedDays: ReadonlySet<string> | null;
  /** The seven days of the displayed week, Monday first. */
  days: Date[];
  now: Date;
  onPress: () => void;
  testID?: string;
};

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * `LOGGING` — days logged this week, as `n / 7` and a row of seven dots.
 *
 * The denominator is **seven**, not "days so far", and that is the opposite
 * choice from the week strip's summary line directly above. It is deliberate:
 * this card answers "how much of the week did I log" — a question about the
 * whole week, which is still in progress — whereas the strip's line reports
 * against the days that have actually happened. Two different questions, and
 * conflating them would make one of the two wrong. The dots make the difference
 * visible: the ones after today are drawn as *pending*, not as missed.
 */
export function LoggingCard({ loggedDays, days, now, onPress, testID }: LoggingCardProps) {
  const todayKey = dayString(now);
  const n = loggedDays == null ? null : days.filter((d) => loggedDays.has(dayString(d))).length;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        n == null ? 'Logging, still loading' : `${n} of 7 days logged this week`
      }
      style={({ pressed }) => [styles.mini, pressed && styles.pressed]}
      testID={testID}
    >
      <RNView style={styles.miniHead}>
        <Icon name="food" size={13} color={vola.textMuted} />
        <Text style={styles.miniLabel}>LOGGING</Text>
      </RNView>

      <RNView style={styles.miniBody}>
        <RNView style={styles.miniFigures}>
          {n == null ? (
            <Text style={styles.miniAbsent}>Checking…</Text>
          ) : (
            <>
              <Text style={styles.miniValue}>
                {n}
                <Text style={styles.miniDenom}> / 7</Text>
              </Text>
              <Text style={styles.miniMeta}>days this week</Text>
            </>
          )}
        </RNView>

        <RNView style={styles.dots}>
          {days.map((d, i) => {
            const key = dayString(d);
            const done = loggedDays?.has(key) ?? false;
            const pending = key > todayKey;
            return (
              <RNView key={key} style={styles.dotCol}>
                <Text style={styles.dotDow}>{DOW[i]}</Text>
                <RNView
                  style={[
                    styles.dot,
                    done ? styles.dotDone : pending ? styles.dotPending : styles.dotMissed,
                  ]}
                >
                  {done ? <Icon name="check" size={8} color={vola.bg} /> : null}
                </RNView>
              </RNView>
            );
          })}
        </RNView>
      </RNView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mini: {
    flex: 1,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  miniHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  miniLabel: { fontSize: 10, letterSpacing: 0.9, color: vola.textMuted, fontWeight: '700' },
  miniBody: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  miniFigures: { flex: 1 },
  miniValue: {
    fontSize: 26,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
  },
  miniDenom: { fontSize: 15, fontWeight: '600', color: vola.textDim },
  miniMeta: { fontSize: 11, color: vola.textMuted },
  miniSub: { fontSize: 10, color: vola.textDim },
  miniAbsent: { fontSize: 11, color: vola.textDim },

  dots: { flexDirection: 'row', gap: 3 },
  dotCol: { alignItems: 'center', gap: 3 },
  dotDow: { fontSize: 8, color: vola.textDim },
  dot: { width: 13, height: 13, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: vola.lime },
  dotPending: { borderWidth: 1, borderColor: vola.lineSoft },
  dotMissed: { borderWidth: 1, borderColor: vola.line },
});

/** The two side by side, with Today's own `gap` between them. */
export function MiniCardRow({ children }: { children: React.ReactNode }) {
  return <RNView style={row.row}>{children}</RNView>;
}

const row = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
});
