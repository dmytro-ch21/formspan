import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import type { Exercise } from '@/lib/exercises';
import {
  bodyweightExerciseNames,
  describeBodyweight,
  getSessionBodyweight,
  type SessionBodyweight as Bodyweight,
} from '@/lib/sessionBodyweight';
import type { LoggedSet } from '@/lib/sessions';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * The bodyweight behind a finished session's reps-only sets, N453 (#756).
 *
 * "Bodyweight 82.4kg, from your 12 Sep check-in", with the bodyweight exercises
 * it applies to named underneath.
 *
 * ## Why this is its own component
 *
 * The review of a finished strength session is `app/session/[id].tsx`, which is
 * also the live logging screen. Everything here (the fetch, the gating, the
 * copy) lives in this file so that screen carries a single element. It
 * renders NOTHING unless the session is finished, so the set-logging path
 * gains no fetch, no layout and no duration.
 *
 * ## Silence is the fallback, and it means exactly one thing
 *
 * The component renders nothing when any of these hold:
 *
 *   - the session has no completed reps-only set;
 *   - the athlete has no weigh-in on or before that day;
 *   - the phone is offline;
 *   - the server is too old to send the fields.
 *
 * In every one of those cases the screen looks exactly as it did before N453:
 * reps, and no load figure. It never claims "no check-in" (offline cannot tell
 * that from none), and it never shows a number the server did not send.
 */
export function SessionBodyweight({
  sessionID,
  startedAt,
  finished,
  sets,
  catalog,
}: {
  sessionID: string;
  /** Which check-in applies depends on the session's day, so a reschedule refetches. */
  startedAt: string;
  finished: boolean;
  sets: readonly Pick<LoggedSet, 'exercise_id' | 'completed'>[];
  catalog: ReadonlyMap<string, Pick<Exercise, 'load_type' | 'name'>>;
}) {
  const getToken = useAuthToken();
  const { units, unitsReady } = useUnits();
  const names = useMemo(() => bodyweightExerciseNames(sets, catalog), [sets, catalog]);
  const applies = finished && names.length > 0;

  // The answer is filed under what it depends on. A different session, or
  // this one moved to another day, can then never show the previous reading
  // while the new one is in flight.
  const key = `${sessionID}|${startedAt}`;
  const [answer, setAnswer] = useState<{ key: string; bw: Bodyweight | null } | null>(null);

  useEffect(() => {
    if (!applies) return;
    const controller = new AbortController();
    getSessionBodyweight(getToken, sessionID, controller.signal)
      .then((bw) => {
        if (!controller.signal.aborted) setAnswer({ key, bw });
      })
      // Offline or refused: stay silent. See the doc comment above.
      .catch(() => {});
    return () => controller.abort();
  }, [applies, key, sessionID, getToken]);

  const bw = answer?.key === key ? answer.bw : null;
  const line = applies && unitsReady ? describeBodyweight(bw, units) : null;
  if (!line) return null;

  const exercises = `Bodyweight exercises: ${names.join(', ')}`;
  return (
    <View
      style={styles.wrap}
      testID="session-bodyweight"
      accessible
      accessibilityLabel={`${line}. ${exercises}.`}
    >
      <Text style={styles.line}>{line}</Text>
      <Text style={styles.exercises}>{exercises}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: Spacing.sm, gap: Spacing.xxs },
  line: { ...Typography.body },
  exercises: { ...Typography.caption, color: vola.textMuted },
});
