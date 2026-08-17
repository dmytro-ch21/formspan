import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { WeightTrend } from '@/components/WeightTrend';
import { RANGE_DAYS } from '@/lib/weightTrend';
import { shiftDate } from '@/lib/anthropometry';
import { dayString } from '@/lib/calendar';
import { listCheckins, type Checkin } from '@/lib/body';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * The weight trend, one tap from the check-in card.
 *
 * ## Why a screen rather than more of the Today card
 *
 * The card is a decision surface and says one thing: is this working, do I need
 * to act. A chart with three ranges on it is a second question — what has the
 * shape been — and putting it on Today would make the card a report, which is
 * the thing its own doc says it must not become. One tap away keeps both
 * honest.
 *
 * ## It fetches a year and slices locally
 *
 * The range switcher is instant because the data is already here: a year of
 * daily check-ins is ~365 small rows, which is smaller than most single screens
 * in this app fetch, and re-requesting on every tap would make a control that
 * exists to be tapped repeatedly feel like navigation. `listCheckins` is
 * date-ranged on the server, so this is one request with a wide window rather
 * than three narrow ones.
 *
 * The trailing `TREND_DAYS` matter here: the seven-day mean at the LEFT edge of
 * a year window is computed from readings before it, so the fetch reaches back
 * further than the chart draws. Fetching exactly a year would make the oldest
 * week of every chart climb out of nothing — see `buildTrendSeries`.
 */

/** A fortnight of slack, so the mean at the far edge has its lookback. */
const LOOKBACK_SLACK_DAYS = 14;

export default function WeightTrendScreen() {
  const getToken = useAuthToken();
  const { units } = useUnits();
  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [failed, setFailed] = useState(false);
  // `dayString`, NOT `toISOString().slice(0,10)`. That is the UTC date, and
  // this repo already banned it once in review (`app/(tabs)/index.tsx`): check-
  // ins are dated by the LOCAL calendar day, so west of Greenwich an evening
  // opens the chart on an empty "tomorrow", and east of Greenwich a morning
  // weigh-in is dated past the window's right edge and dropped as a future
  // reading — invisible, on the day the athlete just logged it. It would also
  // put the card's trend number and the chart's right edge on different days
  // in the same glance.
  const today = dayString(new Date());

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const from = shiftDate(today, -(RANGE_DAYS.year + LOOKBACK_SLACK_DAYS));
      listCheckins(getToken, { from, to: today })
        .then((rows) => {
          if (live) {
            setCheckins(rows);
            setFailed(false);
          }
        })
        .catch(() => {
          // No retry loop and no thrown error: a trend is not worth an alert,
          // and this screen is reachable offline from a cached Today.
          if (live) setFailed(true);
        });
      return () => {
        live = false;
      };
    }, [getToken, today]),
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Weight' }} />
      <ScrollView contentContainerStyle={styles.page}>
        {checkins == null && !failed ? (
          <ActivityIndicator />
        ) : failed ? (
          <Text style={styles.note}>Could not load your check-ins. Pull back and try again.</Text>
        ) : (
          <>
            <WeightTrend checkins={checkins ?? []} today={today} units={units} />
            <Text style={styles.note}>
              The line is a seven-day average; the dots are what the scale said. Day-to-day swings
              are mostly water, so the line is the one to read.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  note: { fontSize: 13, opacity: 0.65, lineHeight: 19 },
});
