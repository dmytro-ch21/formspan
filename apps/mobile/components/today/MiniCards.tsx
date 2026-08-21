import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { vola } from '@/constants/Colors';
import { dayString } from '@/lib/calendar';
import { viewLoggedDays, type LoggedDaysView } from '@/lib/nutrition';

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

        {/*
          **No ring when there is nothing.** Seen on a device: an empty window
          drew a ring labelled `0%`, which is a zero rendered as a score — the
          exact failure the sentence beside it exists to avoid, restated in a
          shape that looks like an achievement. The sentence carries the state
          on its own; a 0% ring adds nothing and asserts something.
        */}
        {training != null && training.sessions > 0 ? (
          <ProgressRing
            percent={pct}
            size={54}
            stroke={5}
            color={vola.lime}
            label={`Trained on ${training.days} of the last ${TRAINING_WINDOW_DAYS} days`}
            testID="training-ring"
          />
        ) : null}
      </RNView>
    </Pressable>
  );
}

export type LoggingCardProps = {
  /** Which days carry a food entry, as a {@link LoggedDaysView}. */
  loggedDays: LoggedDaysView;
  /** The seven days of the displayed week, Monday first. */
  days: Date[];
  now: Date;
  onPress: () => void;
  testID?: string;
};

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * `LOGGING` — days logged this week, as `n / elapsed` and a row of seven dots.
 *
 * ## The denominator is ELAPSED days, not seven
 *
 * It was seven, and that silently reversed a recorded decision. The
 * `LOGGED_WINDOW_DAYS` comment this replaced said a rolling seven was chosen
 * *specifically* because a Monday reset "would make Monday morning always say
 * '0 of 7', which is the discouraging shape the no-shame rule avoids" — the
 * same rule that struck the reference's day streak. Counting against elapsed
 * days also makes this agree with the week strip above it, which is the other
 * half of why the card's duplicate count was removed.
 *
 * The dots still show all seven: the ones after today are drawn **pending**,
 * not missed, so the week's shape is visible without the count implying a
 * shortfall the athlete has not had the chance to make up.
 */
export function LoggingCard({ loggedDays, days, now, onPress, testID }: LoggingCardProps) {
  const todayKey = dayString(now);
  const known = viewLoggedDays(loggedDays);
  const n = known === null ? null : days.filter((d) => known.has(dayString(d))).length;
  const elapsed = days.filter((d) => dayString(d) <= todayKey).length;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        loggedDays.state === 'checking'
          ? 'Logging, still loading'
          : loggedDays.state === 'unavailable'
            ? 'Logging, could not be read'
            : `${n} of ${elapsed} days logged so far this week`
      }
      style={({ pressed }) => [styles.mini, pressed && styles.pressed]}
      testID={testID}
    >
      <RNView style={styles.miniHead}>
        <Icon name="food" size={13} color={vola.textMuted} />
        <Text style={styles.miniLabel}>LOGGING</Text>
      </RNView>

      {/*
          Stacked rather than side by side. Seen on a device: two mini cards
          share a 390pt row, so `0 / 7` beside seven dots left the figure about
          60pt of width and it wrapped one word per line — `0 /`, `7`, `days`,
          `this`, `week`. The dots need the full card width, so they get their
          own row.
      */}
      <RNView style={styles.loggingBody}>
        <RNView style={styles.miniFigures}>
          {n === null ? (
            <Text style={styles.miniAbsent}>
              {loggedDays.state === 'unavailable' ? 'Could not read this week' : 'Checking…'}
            </Text>
          ) : (
            <>
              <Text style={styles.miniValue}>
                {n}
                <Text style={styles.miniDenom}> / {elapsed}</Text>
              </Text>
              <Text style={styles.miniMeta}>days so far this week</Text>
            </>
          )}
        </RNView>

        <RNView style={styles.dots}>
          {days.map((d, i) => {
            const key = dayString(d);
            const done = known?.has(key) ?? false;
            const pending = key > todayKey;
            return (
              <RNView key={key} style={styles.dotCol}>
                <Text style={styles.dotDow}>{DOW[i]}</Text>
                <RNView
                  style={[
                    styles.dot,
                    // An unknown week draws neither done nor missed. Drawing
                    // "missed" beside a figure reading "Checking…" is the same
                    // confident zero the figure is carefully avoiding.
                    known === null
                      ? styles.dotUnknown
                      : done
                        ? styles.dotDone
                        : pending
                          ? styles.dotPending
                          : styles.dotMissed,
                  ]}
                >
                  {known !== null && done ? <Icon name="check" size={8} color={vola.bg} /> : null}
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
  loggingBody: { gap: 10 },
  miniFigures: { flex: 1 },
  miniValue: {
    fontSize: 26,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
  },
  miniDenom: { fontSize: 15, fontWeight: '600', color: vola.textDim },
  miniMeta: { fontSize: 11, color: vola.textMuted },
  miniValueRow: { flexDirection: 'row', alignItems: 'baseline' },
  miniSub: { fontSize: 10, color: vola.textDim },
  miniAbsent: { fontSize: 11, color: vola.textDim },

  dots: { flexDirection: 'row', justifyContent: 'space-between' },
  dotCol: { alignItems: 'center', gap: 3 },
  dotDow: { fontSize: 8, color: vola.textDim },
  dot: { width: 13, height: 13, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: vola.lime },
  dotPending: { borderWidth: 1, borderColor: vola.lineSoft },
  dotMissed: { borderWidth: 1, borderColor: vola.line },
  dotUnknown: { borderWidth: 1, borderColor: vola.lineSoft, opacity: 0.5 },
});

/** The two side by side, with Today's own `gap` between them. */
export function MiniCardRow({ children }: { children: React.ReactNode }) {
  return <RNView style={row.row}>{children}</RNView>;
}

const row = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
});
