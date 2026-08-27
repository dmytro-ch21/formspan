import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { RecordsCard } from '@/components/RecordsCard';
import { TrainingSummary } from '@/components/TrainingSummary';
import { TrainingHistory } from '@/components/progress/TrainingHistory';
import { ThisWeek } from '@/components/progress/ThisWeek';
import { WhatChanged } from '@/components/progress/WhatChanged';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { shiftDate, trendWeight } from '@/lib/anthropometry';
import { listCheckins, type Checkin } from '@/lib/body';
import { dayString, weekDays } from '@/lib/calendar';
import { localLoggedDays } from '@/lib/foodLog';
import { hasFoodLog, moduleOffWithCatalog, moduleWithCatalog } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import type { LoggedDaysView } from '@/lib/nutrition';
import { listPlannedBetween, type PlannedSession } from '@/lib/plan';
import {
  freshRecords,
  nutritionWeek,
  reading,
  whatChanged,
  type BodyChange,
  type Reading,
} from '@/lib/progress';
import { fetchRecords, type ExerciseRecords } from '@/lib/records';
import type { Session } from '@/lib/sessions';
import { cachedExercises, listLocalSessions } from '@/lib/sessionStore';
import { formatWeight } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';
import { reviewWeek, type WeekReview } from '@/lib/weekReview';

/**
 * Progress — "am I getting better?"
 *
 * ## What this screen is, and what it deliberately is not
 *
 * It is a **reorganisation** of analysis this app already had, not a second
 * analytics stack. The weight trend, the records list, the consistency grid and
 * the week review all existed; what did not exist was one place that read them
 * together and said what they MEAN before showing what they are.
 *
 * So the order of the sections below is the product requirement, not a layout
 * preference, and it is asserted rather than eyeballed — see
 * `app/__tests__/progressScreen.test.tsx`, which pins the `progress-section-*`
 * testIDs in document order:
 *
 * 1. **This week** — recent context, per discipline, plus whether food was
 *    logged. `WeekReview`, reused whole.
 * 2. **What changed** — the interpretation. One or two sentences derived from
 *    the same figures the sections below draw.
 * 3. **Training** — the drill-down: the consistency grid, the records, and the
 *    position map for a grappler.
 * 4. **Body** — the weight trend.
 * 5. **Nutrition** — consistency and the target that consistency is measured
 *    against.
 * 6. **Goals** — where a goal is set and reviewed.
 *
 * The charts are all still here. They are underneath the sentence that says why
 * they matter, which is the whole of the ticket's "interpretation before raw
 * data".
 *
 * ## Every read is a five-kind {@link Reading}
 *
 * This tab is nothing but reads of history, and the failure this codebase has
 * shipped three times is an absent value rendering as the most discouraging of
 * its possible causes — "start logging" to somebody with two years of data,
 * because the fetch had not answered yet. `lib/progress.ts` carries the full
 * account. The practical rule here: **no section computes its own
 * empty-versus-loading**, every one of them is handed a `Reading` and the
 * copy for the four non-content states lives in one component.
 *
 * ## What moved here from You, and what did not
 *
 * `TrainingSummary`, `RecordsCard` and the position-map row are **moved** —
 * they are not rendered on `You` any more, so there is one of each in the app.
 * `RoadmapSummary` and the belt masthead stayed on You: a belt is identity, and
 * the roadmap is what the athlete is *learning*, which is a different question
 * from whether they are getting better at it. N181 (#586) owns that screen and
 * may revisit the line.
 *
 * ## Offline
 *
 * The week comes from SQLite, so the section that leads the screen is right in
 * a gym with no signal. Records, check-ins and the training grid are server
 * reads and degrade to `unavailable` — a stated absence, never a zero.
 */
export default function ProgressScreen() {
  const router = useRouter();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const { units, unitsReady } = useUnits();
  const { modules, ready: modulesReady } = useModules();

  /*
    `now` is state and is refreshed on every focus, not computed once.

    A tab screen stays mounted for the life of the process, so a `new Date()`
    captured at first render still says Sunday on Monday morning — and
    `startOfWeek` would then anchor to LAST Monday and report last week's
    training as this week's. Today's screen carries the same note for the same
    reason.
  */
  const [now, setNow] = useState(() => new Date());

  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [planned, setPlanned] = useState<PlannedSession[]>([]);
  const [foodDays, setFoodDays] = useState<LoggedDaysView>({ state: 'checking' });

  const [records, setRecords] = useState<ExerciseRecords[] | null>(null);
  const [recordsFailed, setRecordsFailed] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [checkinsFailed, setCheckinsFailed] = useState(false);

  const foodEnabled = hasFoodLog(modules);
  const bjj = moduleWithCatalog(modules, 'techniques');
  const bjjOff = moduleOffWithCatalog(modules, 'techniques');

  /**
   * The local half: sessions, plans and logged food days.
   *
   * On focus rather than on mount, so finishing a session and coming back shows
   * it. All three are local reads, so they answer with no signal — which is why
   * the section they feed is the one that leads the screen.
   */
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let live = true;
      const at = new Date();
      setNow(at);

      const week = weekDays(at);
      const from = dayString(week[0]);
      const to = dayString(week[6]);

      // 30, matching Today's read of the same store. `reviewWeek` needs enough
      // rows to REACH BACK past last Monday before it will report a
      // comparison at all, and it says so rather than guessing — see its own
      // note on why a count-bounded list is the one thing that can make a
      // local rollup lie.
      listLocalSessions(userId, 30)
        .then((rows) => {
          if (!live) return;
          setSessions(rows);
          setSessionsFailed(false);
        })
        .catch(() => {
          // Left as null, not as an empty list. An empty list renders "nothing
          // logged this week", which is a claim about the athlete's training
          // made from a query that failed.
          if (live) setSessionsFailed(true);
        });

      listPlannedBetween(userId, from, to)
        .then((rows) => {
          if (live) setPlanned(rows);
        })
        // A missing plan is not a missing week: `reviewWeek` treats zero
        // planned as "nobody planned this week", which is the honest reading
        // and is exactly what an unreadable plan list amounts to here.
        .catch(() => {});

      localLoggedDays(userId, from, to)
        .then((days) => {
          if (live) setFoodDays({ state: 'ready', days: new Set(days) });
        })
        .catch(() => {
          // A failed read is NOT an empty week. See `LoggedDaysView`.
          if (live) setFoodDays({ state: 'unavailable' });
        });

      return () => {
        live = false;
      };
    }, [userId]),
  );

  /**
   * The server half: records and body check-ins.
   *
   * One effect for both, because both are network reads with the same lifetime
   * and the same abort — but two independent `.then` chains, so a slow records
   * response cannot delay the weight trend or vice versa.
   *
   * **Records are fetched HERE rather than inside `RecordsCard`**, which is
   * what stops the same list being requested twice on one focus: "What
   * changed" reads it to say whether anything is newly a best, and the card
   * renders it. Two fetches would also be two answers, able to disagree with
   * each other on one screen.
   */
  useFocusEffect(
    useCallback(() => {
      const c = new AbortController();

      fetchRecords(getToken, undefined, c.signal)
        .then((r) => {
          if (c.signal.aborted) return;
          setRecords(r);
          setRecordsFailed(false);
          // Names come from the cached catalog — the same one that makes a
          // session readable offline — so a record never renders as its slug.
          cachedExercises()
            .then((list) => setNames(new Map(list.map((e) => [e.id, e.name]))))
            .catch(() => {});
        })
        .catch(() => {
          if (!c.signal.aborted) setRecordsFailed(true);
        });

      // Three weeks, because the comparison needs BOTH ends smoothed:
      // `trendWeight` averages the seven days ending on its argument, and the
      // far end of the delta is a week back — so days −14 to −8 have to be on
      // hand or the older figure is null and no body insight is drawn at all.
      const today = dayString(new Date());
      listCheckins(getToken, { from: shiftDate(today, -(BODY_WINDOW_DAYS - 1)), to: today })
        .then((rows) => {
          if (c.signal.aborted) return;
          setCheckins(rows);
          setCheckinsFailed(false);
        })
        .catch(() => {
          if (!c.signal.aborted) setCheckinsFailed(true);
        });

      return () => c.abort();
    }, [getToken]),
  );

  const weekReading: Reading<WeekReview> = useMemo(
    () =>
      reading({
        value: sessions === null ? null : reviewWeek(sessions, planned, now),
        failed: sessionsFailed,
      }),
    [sessions, planned, now, sessionsFailed],
  );

  const recordsReading: Reading<ExerciseRecords[]> = useMemo(
    () => reading({ value: records, failed: recordsFailed, isEmpty: (r) => r.length === 0 }),
    [records, recordsFailed],
  );

  const freshReading = useMemo(
    () =>
      reading({
        value: records === null ? null : freshRecords(records, (id) => names.get(id) ?? id),
        failed: recordsFailed,
      }),
    [records, names, recordsFailed],
  );

  const bodyReading: Reading<BodyChange> = useMemo(() => {
    // `unitsReady` gates the whole reading, not the formatting.
    //
    // Every sentence this produces contains a weight, and #483 is the bill for
    // printing kilograms for a frame to somebody who thinks in pounds — the
    // first frame being precisely when a card is read. There is no honest
    // fallback string here: "0.6 kg" to an imperial athlete is wrong, and a
    // unit-less "0.6" is worse. So the read simply has not answered yet, which
    // is true, and `whatChanged` already knows what to do with that.
    if (!unitsReady) return { state: 'checking' };
    if (checkins === null) return reading<BodyChange>({ value: null, failed: checkinsFailed });
    const today = dayString(now);
    const nowKg = trendWeight(checkins, today);
    const thenKg = trendWeight(checkins, shiftDate(today, -BODY_COMPARE_DAYS));
    // Null rather than zero when either end cannot be smoothed. A weight
    // "change" of 0.0 kg computed from one reading a fortnight ago is a
    // fabricated measurement, and it is the sentence an athlete would act on.
    const value =
      nowKg == null || thenKg == null
        ? null
        : { deltaKg: nowKg - thenKg, days: BODY_COMPARE_DAYS };
    // `empty`, not `checking`, when the readings are too sparse: the read
    // ANSWERED, and the answer is that there is not enough to compare. The
    // block simply draws no body insight from it.
    return value === null
      ? { state: 'empty', stale: checkinsFailed }
      : { state: 'ready', value, stale: checkinsFailed };
  }, [checkins, now, checkinsFailed, unitsReady]);

  const nutritionReading = useMemo(
    () =>
      nutritionWeek(
        /*
          Gated on the module, like every food-shaped surface in this app: an
          athlete who has turned nutrition off must not be told "0 days logged"
          forever about a feature they do not have.

          **`modulesReady` is the load-bearing half**, and it is the same guard
          the BJJ row twenty lines down already carries. Without it an empty
          module list — which is what every cold start begins with — classifies
          as `off`, and `off` is a claim about a SETTING NOBODY HAS READ YET.

          It renders correctly today only by coincidence, because `NutritionLine`
          happens to draw nothing for `off`. That is exactly the shape this tab
          exists to refuse: the type would be lying, and the first consumer to
          route this reading through `ReadingState` with an `offLabel` would put
          "Nutrition is turned off" on screen during a normal load. Raised in
          review, and fixed in the classification rather than in the render, so
          the next consumer inherits the truth rather than the coincidence.

          The cost is a dash for a frame or two on an account that does have
          nutrition off. A dash claims nothing; "turned off" claims something.
        */
        foodEnabled ? foodDays : modulesReady ? { state: 'off' } : { state: 'checking' },
        weekDays(now).map(dayString),
        dayString(now),
      ),
    [foodEnabled, modulesReady, foodDays, now],
  );

  const changes = useMemo(
    () =>
      // Never a bare number and never a hard-coded unit — `bodyReading` is
      // `checking` until the athlete's own system is known, so this is only
      // ever called with one in hand.
      whatChanged({ week: weekReading, records: freshReading, body: bodyReading }, (kg) =>
        formatWeight(kg, units),
      ),
    [weekReading, freshReading, bodyReading, units],
  );

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Progress" />
      <ScrollView contentContainerStyle={styles.body} testID="progress-screen">
        {/* 1 — recent context. */}
        <SectionHeader label="This week" />
        <ThisWeek
          week={weekReading}
          nutrition={nutritionReading}
          modules={modules}
          units={units}
          unitsReady={unitsReady}
        />

        {/* 2 — the interpretation, above every chart on this screen. */}
        <SectionHeader label="What changed" />
        <View style={styles.section} testID="progress-section-changed">
          <WhatChanged view={changes} testID="what-changed" />
        </View>

        {/* 3 — the drill-down. */}
        <View style={styles.section} testID="progress-section-training">
          {/* Brings its own section header and its own span control. */}
          <TrainingSummary getToken={getToken} units={units} />
          <RecordsCard records={recordsReading} names={names} units={units} />

          {/*
            The training calendar, rehomed from Today by N179 — which days were
            planned, which were met, and the way into a past session by date.
            `TrainingSummary` above says WHICH DAYS; this says which days were
            asked for. It reads local SQLite, so it is also the block that still
            answers when the summary above cannot reach the network.

            Deliberately the ONLY one of Today's three analytical blocks that
            landed here: `WeekReview` is already drawn by `ThisWeek`, and
            `TrendStrip`'s weekly bars are already drawn by `TrainingSummary`.
            See the component's own note.
          */}
          <TrainingHistory />

          {/*
            The position map, moved off You.

            Gated on the CAPABILITY rather than on `key === 'bjj'`, and it
            renders an explanation rather than nothing when the discipline is
            off — N61, in the one form that has actually bitten this app: an
            athlete cannot tell "turned off" from "not built" from "broken",
            and went looking for the belt roadmaps on a real phone and
            reported them missing. Nothing at all is drawn while the module
            list is still loading, because an empty list is an unanswered
            question rather than a "no".
          */}
          {modulesReady && bjj && (
            <Row
              title="Position map"
              note="Where you score, and where you get stuck."
              onPress={() => router.push('/bjj/positions')}
              testID="progress-bjj-positions"
            />
          )}
          {/* N84, row 10 of the phone-impossible audit: the technique funnel
              as a browsable surface, not just the Today card's abbreviated
              slice. A list, not a chart — see `app/bjj/proficiency.tsx`'s own
              note on why the carve-out does not apply to it. */}
          {modulesReady && bjj && (
            <Row
              title="Technique funnel"
              note="What you've drilled, what you've tried live, and what's working."
              onPress={() => router.push('/bjj/proficiency')}
              testID="progress-bjj-proficiency"
            />
          )}
          {modulesReady && !bjj && bjjOff && (
            <Text style={styles.off} testID="progress-bjj-off">
              {bjjOff.label} is turned off, so its position map is not shown. Turn it back on
              under Sports in your profile.
            </Text>
          )}
        </View>

        {/* 4 — body. */}
        <SectionHeader label="Body" />
        <View style={styles.section} testID="progress-section-body">
          {/*
            A LINK, not a second copy of the chart.
            `app/goals/trend.tsx` is the weight trend — axes, projection, the
            entries behind it — and drawing a rival here would give the app two
            weight-trend views that can disagree, which is the specific failure
            this ticket's own test steps call out.
          */}
          <Row
            title="Weight trend"
            note="The line, the projection and the entries behind it."
            onPress={() => router.push('/goals/trend')}
            testID="progress-weight-trend"
          />
          <Row
            title="Check-ins"
            note="Weight and girths, day by day."
            onPress={() => router.push(`/checkin/${dayString(now)}`)}
            testID="progress-checkin"
          />
        </View>

        {/* 5 — nutrition. */}
        <SectionHeader label="Nutrition" />
        <View style={styles.section} testID="progress-section-nutrition">
          {/*
            Unconditional, and that is deliberate. The destination explains
            itself when nutrition is off — `ModuleOffNotice` is the whole
            screen there — and hiding the link is what leaves an athlete unable
            to reach the explanation. #370's finding, applied here.
          */}
          <Row
            title="Targets and adherence"
            note="What you are eating to, and why that number."
            onPress={() => router.push('/(tabs)/goals')}
            testID="progress-nutrition"
          />
          {/* N84, row 6 of the phone-impossible audit: the reduced phone form
              of `/dashboard/nutrition` — one metric (mean kcal against
              target), not web's three-way join. See `lib/nutritionTrend.ts`. */}
          <Row
            title="Eating vs. target"
            note="Your logged intake against what you're eating to, over time."
            onPress={() => router.push('/goals/nutritionTrend')}
            testID="progress-nutrition-trend"
          />
        </View>

        {/* 6 — goals. */}
        <SectionHeader label="Goals" />
        <View style={styles.section} testID="progress-section-goals">
          <Row
            title="Target history"
            note="Every target you have set, and what each day was measured against."
            onPress={() => router.push('/goals/history')}
            testID="progress-goal-history"
          />
          {/*
            Dashed, per #468: a placeholder standing WHERE content would stand
            is dashed; one standing beside content is a card. This one stands
            where a list of achievements would stand, so it is dashed — and it
            says what is missing rather than leaving a heading over one row.
          */}
          <View style={styles.soon} testID="progress-goals-soon">
            <Text style={styles.soonTitle}>Achievements are not here yet</Text>
            <Text style={styles.soonNote}>
              The firsts you earn on the mat — first submission, first podium — are recorded and
              shown on the session that earned them. A list of them lives here next.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * How many days of check-ins to fetch.
 *
 * Three weeks: `trendWeight` smooths over the seven days ending at its
 * argument, and the far end of the comparison sits a week back — so the oldest
 * day that matters is fourteen back, and the extra week is slack for an athlete
 * who weighs in irregularly.
 */
const BODY_WINDOW_DAYS = 21;

/** How far back the weight comparison reaches. Matches Today's `PROGRESS` card. */
const BODY_COMPARE_DAYS = 7;

/**
 * One destination.
 *
 * A `Pressable` with an explicit role and label rather than a bare `Text` in a
 * touchable: the note underneath is supplementary, so it goes in the hint and
 * the title carries the label — otherwise a screen reader reads the whole
 * paragraph as the name of the control.
 */
function Row({
  title,
  note,
  onPress,
  testID,
}: {
  title: string;
  note: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={note}
      testID={testID}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowNote}>{note}</Text>
      </View>
      <Icon name="chevron" size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: TAB_BAR_CLEARANCE, gap: 12 },
  section: { gap: 10, backgroundColor: 'transparent' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
  },
  rowPressed: { opacity: 0.85 },
  rowText: { flex: 1, gap: 3, backgroundColor: 'transparent' },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  // textMuted, not textDim — textDim is 3.96:1 on `bg`, under AA at this size.
  rowNote: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  off: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },

  soon: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 16,
    padding: 20,
    gap: 6,
  },
  soonTitle: { fontSize: 15, fontWeight: '700' },
  soonNote: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
