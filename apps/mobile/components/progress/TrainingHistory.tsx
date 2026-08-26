import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { TrainingCalendar } from '@/components/TrainingCalendar';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { dayString, weekDays } from '@/lib/calendar';
import { useModules } from '@/lib/ModulesProvider';
import { listPlannedBetween, type PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import { listLocalSessions } from '@/lib/sessionStore';
import { sessionHref } from '@/lib/startSession';
import { useSource } from '@/lib/useTrainBoard';
import { useUnits } from '@/lib/useUnits';

/**
 * The training calendar, rehomed from Today to Progress (N179).
 *
 * ## Why it moved, and why only this one of the three
 *
 * Today carried three analytical blocks below the fold — `TrainingCalendar`,
 * `WeekReview` and an eight-week `TrendStrip` — none of which answers *what do
 * I do in the next ten minutes*, which is the only question Today exists to
 * answer. All three had to leave; only this one needed a new home:
 *
 * - **`WeekReview`** is already on Progress. N178 renders the very same
 *   component inside `components/progress/ThisWeek.tsx`, so putting it here as
 *   well would be one card drawn twice on one screen.
 * - **`TrendStrip`** asks *have I been showing up*, which `TrainingSummary` —
 *   also on Progress, also above this — already answers with a bar per week
 *   over a selectable span. Two weekly-bar charts a few hundred points apart is
 *   the W2/W4 shape this repo has shipped twice, so this block does not draw a
 *   third.
 * - **`TrainingCalendar`** has no equivalent on this tab. `TrainingSummary`'s
 *   day grid says *which days*; this says which days were **planned**, which
 *   were met, and opens the session behind one. That is a different question,
 *   and the last surface on the phone that opens a past session by date.
 *
 * ## It reads for itself
 *
 * Two local SQLite reads, so it renders with no network — the same functions
 * Today and Train call, and nothing here writes anything. That matters
 * alongside `TrainingSummary`, which is network-backed: in a gym dead-spot this
 * block is what still answers.
 *
 * It takes no props deliberately, including its own clock. A props-drilled
 * version would have to be threaded through whatever shape this tab ends up
 * with; a one-line insertion survives the tab being rebuilt around it, which it
 * already has been once between this branch being written and merged.
 *
 * ## Unread is not empty
 *
 * `useSource` — the same three-state discipline Train and Today use, imported
 * rather than re-implemented. The calendar needs BOTH reads: it draws logged
 * sessions against planned days, so half an answer renders a week with its
 * plans silently missing, which reads as an athlete who planned nothing.
 */
export function TrainingHistory() {
  const { userId } = useAuth();
  const { modules } = useModules();
  const { units } = useUnits();
  const router = useRouter();

  // Its own clock, refreshed on focus rather than captured at mount. A tab
  // screen stays mounted for the life of the process, so a `Date` taken once
  // still says Sunday on Monday morning. Same shape as Train's; deliberately
  // not ticked, because nothing here draws a running clock.
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );

  const [sessions, sessionsReady, sessionsFailed] = useSource<Session[]>();
  const [planned, plannedReady, plannedFailed] = useSource<PlannedSession[]>();

  // Keyed on the day string rather than on `now`, so a fresh `Date` per focus
  // does not re-fire the read for an identical window. Noon, because midnight
  // local does not exist on a spring-forward date in some zones.
  const today = dayString(now);
  const week = useMemo(() => weekDays(new Date(`${today}T12:00:00`)), [today]);
  const from = dayString(week[0]);
  const to = dayString(week[6]);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let live = true;
      listLocalSessions(userId, 30).then(
        (rows) => live && sessionsReady(rows),
        () => live && sessionsFailed(),
      );
      listPlannedBetween(userId, from, to).then(
        (rows) => live && plannedReady(rows),
        () => live && plannedFailed(),
      );
      return () => {
        live = false;
      };
    }, [userId, from, to, sessionsReady, sessionsFailed, plannedReady, plannedFailed]),
  );

  if (sessions.state === 'unread' || planned.state === 'unread') return null;

  if (sessions.state === 'unavailable' || planned.state === 'unavailable') {
    // Dashed, per #468: it stands WHERE content would stand. And it says the
    // read failed rather than drawing an empty week, which would be a claim
    // about the athlete rather than about the disk.
    return (
      <View style={styles.section}>
        <SectionHeader label="Training calendar" />
        <RNView style={styles.dashed} testID="progress-calendar-unavailable">
          <Text style={styles.note}>Couldn&apos;t read your training calendar just now.</Text>
        </RNView>
      </View>
    );
  }

  return (
    <View style={styles.section} testID="progress-training-calendar">
      <SectionHeader label="Training calendar" />
      <TrainingCalendar
        now={now}
        userId={userId ?? null}
        sessions={sessions.value}
        planned={planned.value}
        modules={modules}
        units={units}
        onOpenSession={(s) => router.push(sessionHref(s, modules))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, marginTop: 4 },
  dashed: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 14,
  },
  note: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
