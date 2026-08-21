import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { dayString } from '@/lib/calendar';
import { viewLoggedDays, type LoggedDaysView } from '@/lib/nutrition';

/**
 * The week strip: Mon–Sun, with each day's state as a ring beneath its date.
 *
 * ## The streak line is NOT a streak, and that is deliberate
 *
 * The reference reads `🔥 3 day streak`. **This project rejects day streaks by
 * name.** `docs/decisions/nutrition-design.md` §5:
 *
 * > A missed day becomes a loss, and a streak rewards logging a fake day to
 * > save it. Against the no-shame rule.
 *
 * N53 was the last ticket to arrive with a reference screenshot asking for one,
 * and it shipped the sanctioned substitute instead: **a count, not a chain** —
 * `3 of 7 days logged` — which cannot be lost, and which carries N28's
 * denominator rule by construction. That is what this renders.
 *
 * The distinction is not pedantry about wording. The one streak this app *does*
 * keep (N19's) counts **weeks**, precisely so a rest day cannot break it, and it
 * has no running total on any screen to protect. A day chain is the opposite of
 * both properties.
 *
 * **This is flagged on the PR as a question rather than settled unilaterally** —
 * the reference is the user's and the rule is the project's, and only they can
 * overrule the rule. Swapping the count back for a chain is a one-line change
 * to {@link WeekStripProps.summary} if they do.
 *
 * ## What a filled ring means is the caller's decision
 *
 * `logged` is a set of `YYYY-MM-DD` keys rather than anything derived here, so
 * the strip does not quietly decide whether "logged" means a training session, a
 * food entry, or both. Today owns that.
 */
export type WeekStripProps = {
  /** Any date inside the week to draw. */
  now: Date;
  /**
   * Which days carry a food entry — as a {@link LoggedDaysView}, so the four
   * states cannot be collapsed at the call site.
   *
   * It was a bare `ReadonlySet` and the caller wrote `?? new Set()`, which made
   * every past day render as *nothing logged* — and say so to VoiceOver — while
   * the read was still in flight, after a failed read, and for a deployment
   * with no food log at all.
   */
  logged: LoggedDaysView;
  /** The seven days of the week, Monday first. */
  days: Date[];
  onWeekInReview: () => void;
  testID?: string;
};

const INITIALS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function WeekStrip({ now, logged, days, onWeekInReview, testID }: WeekStripProps) {
  const todayKey = dayString(now);
  const known = viewLoggedDays(logged);
  const loggedCount = known ? days.filter((d) => known.has(dayString(d))).length : null;

  // The bar spans the days that have HAPPENED, filled by the ones that were
  // logged. A bar running the whole week would show a future the athlete has
  // not reached yet as a shortfall.
  const elapsed = days.filter((d) => dayString(d) <= todayKey).length;
  const fill = loggedCount !== null && elapsed > 0 ? (loggedCount / elapsed) * 100 : 0;

  return (
    <View style={styles.card} testID={testID}>
      <RNView style={styles.days}>
        {days.map((d, i) => {
          const key = dayString(d);
          const isToday = key === todayKey;
          const isFuture = key > todayKey;
          const isLogged = known?.has(key) ?? false;
          return (
            <RNView
              key={key}
              style={styles.day}
              accessible
              accessibilityLabel={`${INITIALS[i]} ${d.getDate()}${
                isToday ? ', today' : ''
              }${
                // Only claim "nothing logged" when the days are actually known.
                // Unknown days say nothing rather than saying zero.
                known === null
                  ? ''
                  : isLogged
                    ? ', logged'
                    : isFuture
                      ? ', still to come'
                      : ', nothing logged'
              }`}
              testID={`week-strip-${key}`}
            >
              <Text style={[styles.dow, isToday && styles.dowToday]}>{INITIALS[i]}</Text>
              <RNView style={[styles.dateWrap, isToday && styles.dateWrapToday]}>
                <Text style={[styles.date, isFuture && styles.dateFuture]}>{d.getDate()}</Text>
              </RNView>
              <Mark
                logged={isLogged}
                today={isToday}
                future={isFuture}
                known={known !== null}
              />
            </RNView>
          );
        })}
      </RNView>

      <RNView style={styles.track}>
        {loggedCount !== null ? <RNView style={[styles.fill, { width: `${fill}%` }]} /> : null}
      </RNView>

      <RNView style={styles.foot}>
        {/* A count, not a chain — see the header comment. And never a count at
            all until the days are known: `0 of 5 days logged` from a pending
            read is a confident, discouraging zero. */}
        <Text style={styles.summary} testID="week-strip-summary">
          {logged.state === 'checking'
            ? 'Checking…'
            : logged.state === 'unavailable'
              ? 'Could not read this week'
              : logged.state === 'off'
                ? ''
                : `${loggedCount} of ${elapsed} ${elapsed === 1 ? 'day' : 'days'} logged`}
        </Text>
        <Pressable
          onPress={onWeekInReview}
          accessibilityRole="button"
          accessibilityLabel="Week in review"
          style={styles.review}
          testID="week-strip-review"
        >
          <Text style={styles.reviewLabel}>Week in review</Text>
          <Icon name="chevron" size={13} color={vola.textMuted} />
        </Pressable>
      </RNView>
    </View>
  );
}

/**
 * The ring beneath a date.
 *
 * Three states and they are visually distinct without colour: a logged day is
 * filled and ticked, today is an open ring in the accent, a future day is a
 * dimmer open ring. A past day with nothing logged is an open ring too — it is
 * **not** marked with a cross or reddened, because "you did not train on
 * Tuesday" is a fact about a Tuesday and not a verdict.
 */
function Mark({
  logged,
  today,
  future,
  known,
}: {
  logged: boolean;
  today: boolean;
  future: boolean;
  /** False while the week's logged days are unknown — draw neither state. */
  known: boolean;
}) {
  if (!known) {
    return <RNView style={[styles.mark, today ? styles.markToday : styles.markUnknown]} />;
  }
  if (logged) {
    return (
      <RNView style={[styles.mark, styles.markDone]}>
        <Icon name="check" size={11} color={vola.bg} />
      </RNView>
    );
  }
  return (
    <RNView
      style={[
        styles.mark,
        today ? styles.markToday : future ? styles.markFuture : styles.markMissed,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 10,
  },
  days: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { alignItems: 'center', gap: 4, flex: 1 },
  dow: { fontSize: 9, letterSpacing: 0.6, color: vola.textDim, fontWeight: '600' },
  dowToday: { color: vola.lime },
  dateWrap: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  // Flat ring, no bloom — the reference glows here and the user has said twice
  // that they do not want it.
  dateWrapToday: { borderWidth: 1.5, borderColor: vola.lime },
  date: { fontSize: 16, fontWeight: '700', color: vola.text, fontVariant: ['tabular-nums'] },
  dateFuture: { color: vola.textDim, fontWeight: '600' },

  mark: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  markDone: { backgroundColor: vola.lime },
  markToday: { borderWidth: 1.5, borderColor: vola.lime },
  markFuture: { borderWidth: 1, borderColor: vola.line },
  markMissed: { borderWidth: 1, borderColor: vola.lineSoft },
  markUnknown: { borderWidth: 1, borderColor: vola.lineSoft, opacity: 0.5 },

  track: { height: 3, borderRadius: 2, backgroundColor: vola.surfaceRaised, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2, backgroundColor: vola.lime },

  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summary: { fontSize: 12, color: vola.textMuted, fontVariant: ['tabular-nums'] },
  review: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  reviewLabel: { fontSize: 12, color: vola.textMuted },
});
